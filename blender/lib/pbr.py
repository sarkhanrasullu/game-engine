"""Procedural PBR, composited from the baked masks into glTF baseColor + ORM (ADR-0003 §Pipeline).

Inputs are the `lib.bake.bake_chain` maps: material ID (which preset), curvature (edge wear on
convex edges, grime in cavities), AO (ORM red) and the seam mask (passed through for the emissive
seams). The output is an sRGB baseColor and a linear ORM (R occlusion, G roughness, B metallic).
It is numpy over the baked pixels, seeded through the caller's `rng`. The same inputs always give the
same bytes. Deviation from ADR-0003's "node graph baked to baseColor/ORM": an EMIT bake of a node
graph would add five more Cycles bakes per asset and colour-management round trips for the same
result. Pixel compositing over the masks is exact and fast.

The per-material presets are the CALLER's data (ADR-0004 A9.3): a dict from material id (the ints of
`lib.hardsurface`, 0..7) to `preset(...)`. Example:

    from lib import pbr
    MATERIALS = {'steel': 0, 'brass': 1, 'cloth': 4}
    PRESETS = {
        MATERIALS['steel']: pbr.preset(base=(0.20, 0.20, 0.21), rough=0.55, metal=1.0,
                                       wear=(0.55, 0.55, 0.56), wear_rough=0.30, cavity=0.55),
        MATERIALS['brass']: pbr.preset(base=(0.55, 0.34, 0.16), rough=0.40, metal=1.0,
                                       wear=(0.85, 0.62, 0.38), wear_rough=0.25, cavity=0.50),
        MATERIALS['cloth']: pbr.preset(base=(0.04, 0.045, 0.05), rough=0.80, metal=0.0,
                                       wear=(0.06, 0.065, 0.07), wear_rough=0.85, cavity=0.30),
    }
    maps = bake.bake_chain(high, low, 1024, prefix='hero_a', extrusion=0.01, max_ray=0.02)
    base, orm = pbr.compose(maps, rng, prefix='hero_a', presets=PRESETS)
    mat = material.pbr_material('armour', base_color=base, orm=orm, normal=maps['normal'])
"""
import numpy as np

from . import bake
from .hardsurface import ID_COLOURS

#: Keys every preset carries.
PRESET_KEYS = ('base', 'rough', 'metal', 'wear', 'wear_rough', 'cavity')


def preset(*, base, rough, metal, wear, wear_rough, cavity):
    """One material's look: `base` linear RGB, `rough`/`metal` 0..1, `wear` RGB and `wear_rough` on worn
    convex edges, `cavity` darkening 0..1 in concave areas. Returns a plain dict `compose` reads."""
    return dict(base=tuple(base), rough=float(rough), metal=float(metal), wear=tuple(wear),
                wear_rough=float(wear_rough), cavity=float(cavity))


def _grid(image):
    w, h = image.size
    return np.array(bake.pixels(image), dtype=np.float64).reshape(h, w, 4)


def decode_ids(id_px):
    """Material id per pixel: the nearest ID_COLOURS entry to each baked RGB (h, w) int array."""
    palette = np.array(ID_COLOURS, dtype=np.float64)
    d = ((id_px[..., None, :3] - palette[None, None, :, :]) ** 2).sum(-1)
    return d.argmin(-1)


def value_noise(rng, size, cells):
    """Seeded tileable 2D value noise in [0, 1], `size`^2 pixels, `cells` lattice cells (smoothstep)."""
    lattice = np.array([[rng.random() for _ in range(cells)] for _ in range(cells)], dtype=np.float64)
    t = np.linspace(0.0, cells, size, endpoint=False)
    i0 = t.astype(int)
    f = t - i0
    f = f * f * (3 - 2 * f)
    i1 = (i0 + 1) % cells
    a = lattice[np.ix_(i0, i0)] * (1 - f)[None, :] + lattice[np.ix_(i0, i1)] * f[None, :]
    b = lattice[np.ix_(i1, i0)] * (1 - f)[None, :] + lattice[np.ix_(i1, i1)] * f[None, :]
    return a * (1 - f)[:, None] + b * f[:, None]


def _smooth(x, lo, hi):
    t = np.clip((x - lo) / max(hi - lo, 1e-6), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def wear_mask(curvature, rng, *, threshold=0.12, softness=0.15, breakup=0.6, cells=24):
    """Edge wear in [0, 1] from a curvature map (0.5 = flat): convex edges above 0.5 + threshold,
    ramped over `softness`, broken up by seeded noise (`breakup` 0 = solid line, 1 = patchy)."""
    size = curvature.shape[0]
    edge = _smooth(curvature, 0.5 + threshold, 0.5 + threshold + softness)
    n = value_noise(rng, size, cells)
    return edge * np.clip(1.0 - breakup + breakup * 1.6 * (n - 0.2), 0.0, 1.0)


def _linear_to_srgb(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def _validate(presets):
    if not presets:
        raise ValueError('pbr.compose: `presets` must map at least one material id to a preset()')
    for mid, p in presets.items():
        if not isinstance(mid, int) or not 0 <= mid < len(ID_COLOURS):
            raise ValueError(f'pbr.compose: preset key {mid!r} is not a material id 0..{len(ID_COLOURS) - 1}')
        missing = [k for k in PRESET_KEYS if k not in p]
        if missing:
            raise ValueError(f'pbr.compose: preset {mid} lacks {missing} (use pbr.preset)')
    return presets[0] if 0 in presets else presets[min(presets)]


def compose(maps, rng, *, prefix, presets, wear=None, mottle=0.08):
    """baseColor (sRGB image) and ORM (Non-Color image) from the baked chain. Returns (base, orm).

    `presets` maps material id -> `preset(...)`; ids without a preset fall back to id 0's (or the
    lowest present). `wear` overrides `wear_mask` keyword arguments. `mottle` is the seeded
    low-frequency variation of base colour and roughness. The ORM alpha is 1 (the seam mask stays its
    own map; the asset script picks the channel it ships in, ADR-0003 §Key Interfaces).
    """
    fallback = _validate(presets)
    ids = decode_ids(_grid(maps['id']))
    curv = _grid(maps['curvature'])[..., 0]
    ao = _grid(maps['ao'])[..., 0]
    size = ids.shape[0]
    worn = wear_mask(curv, rng, **(wear or {}))
    cavity = _smooth(0.5 - curv, 0.05, 0.3)
    mot = value_noise(rng, size, 8) - 0.5

    tab = lambda key, n: np.array([presets.get(i, fallback)[key] for i in range(len(ID_COLOURS))], dtype=np.float64).reshape(len(ID_COLOURS), n)  # noqa: E731
    base = tab('base', 3)[ids]
    wear_base = tab('wear', 3)[ids]
    rough = tab('rough', 1)[ids][..., 0]
    wear_rough = tab('wear_rough', 1)[ids][..., 0]
    metal = tab('metal', 1)[ids][..., 0]
    cav = tab('cavity', 1)[ids][..., 0]

    colour = base * (1 - worn[..., None]) + wear_base * worn[..., None]
    colour *= (1.0 - cav * cavity)[..., None]
    colour *= (1.0 + mottle * mot)[..., None]
    roughness = np.clip(rough * (1 - worn) + wear_rough * worn + 0.6 * mottle * mot + 0.15 * cavity, 0.04, 1.0)

    base_img = bake.new_image(f'{prefix}_basecolor', size, non_color=False)
    orm_img = bake.new_image(f'{prefix}_orm', size, non_color=True)
    rgba = np.ones((size, size, 4), dtype=np.float64)
    rgba[..., :3] = _linear_to_srgb(colour)  # 8-bit sRGB storage, written verbatim
    bake.set_pixels(base_img, rgba.ravel().tolist())
    orm = np.ones((size, size, 4), dtype=np.float64)
    orm[..., 0] = ao
    orm[..., 1] = roughness
    orm[..., 2] = metal
    bake.set_pixels(orm_img, orm.ravel().tolist())
    return base_img, orm_img
