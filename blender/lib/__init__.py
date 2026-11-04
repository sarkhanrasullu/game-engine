"""Shared library for the headless Blender asset pipeline (ADR-0003; engine package, ADR-0004 A9.3).

Run only inside the pinned `bpy` venv (blender/setup.sh; the version is the `bpy==` pin in
blender/requirements.txt). Modules:

- `scene`  — factory reset, deterministic render/bake settings, small mesh helpers.
- `bake`   — Cycles CPU bakes (normal, AO, curvature, attribute masks) from a high-poly onto a low-poly, image I/O.
- `material` — PBR material wiring the glTF exporter understands (baseColor, ORM, normal).
- `hardsurface` — deterministic hard-surface modelling helpers (plates, shells, panel lines, fasteners, masks).
- `pbr` — numpy compositing of the baked masks into baseColor + ORM from caller-supplied presets.
- `armature` — the `createRig` joint contract as a Blender armature, skinning helpers, rig.json.
- `export` — the one glTF export call every asset uses (raw .glb, no compression; Node compresses).
- `turntable` — Cycles CPU turntable frames for the consumer's evidence folder.

Every asset script (the engine's smoke/ and the consumer's <kind>/ scripts) composes these. The library
carries no consumer data: material tables, PBR presets and hero -> fighter maps are parameters. Nothing
here downloads or loads bundled content (ADR-0003 §Implementation Guidelines).
"""
