// Deterministic offline DSP kernels for bank rendering (engine tools/audio; ADR-0005). Plain
// JavaScript, Float64Array buffers, no Web Audio and no native dependencies, so a bank renders
// byte-identically in Node from a recipe + seed. Kernels: seeded RNG, noise colours, RBJ biquads,
// modal bodies (banks of damped resonators driven by a Hertzian contact pulse), noise bursts with
// filter sweeps, pitch-gliding tones, random flutter (AM), Poisson crackle, bubbles (damped chirps),
// tanh saturation, FFT and spectral measurements, WAV writing. All time arguments are seconds
// unless the name says otherwise. Engine code: no game names, no game data.

export const TAU = Math.PI * 2;

/** mulberry32 PRNG. @example const r = rng(7); r.next(); r.range(100, 200); r.gauss() */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + next() * (hi - lo),
    /** ±1 uniform */
    pm: () => next() * 2 - 1,
    /** standard normal (Box-Muller) */
    gauss() { const u = Math.max(1e-12, next()); const v = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v); },
    /** 1 with probability p */
    chance: (p) => next() < p,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
  };
}

/** Stable 32-bit string hash (FNV-1a) for seeds. */
export function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export const dbToGain = (db) => 10 ** (db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(1e-12, g));
export const sec = (s, sr) => Math.round(s * sr);

/** Zero buffer of `seconds`. */
export const silence = (seconds, sr) => new Float64Array(Math.max(1, sec(seconds, sr)));

/** dst += src * gain starting at `at` seconds (clipped to dst). Returns dst. */
export function mixInto(dst, src, at, sr, gain = 1) {
  const o = sec(at, sr);
  const n = Math.min(src.length, dst.length - o);
  for (let i = 0; i < n; i++) dst[o + i] += src[i] * gain;
  return dst;
}

export function scale(buf, g) { for (let i = 0; i < buf.length; i++) buf[i] *= g; return buf; }
export function multiply(buf, env) { const n = Math.min(buf.length, env.length); for (let i = 0; i < n; i++) buf[i] *= env[i]; for (let i = n; i < buf.length; i++) buf[i] = 0; return buf; }
export function peak(buf) { let p = 0; for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > p) p = a; } return p; }
export function rms(buf, from = 0, to = buf.length) { let s = 0; for (let i = from; i < to; i++) s += buf[i] * buf[i]; return Math.sqrt(s / Math.max(1, to - from)); }

/** Normalise so the loudest channel peaks at `dbfs`. Returns the applied gain. */
export function normalizePeak(chs, dbfs = -1) {
  let p = 0;
  for (const c of chs) p = Math.max(p, peak(c));
  const g = p > 0 ? dbToGain(dbfs) / p : 1;
  for (const c of chs) scale(c, g);
  return g;
}

/** Normalise so the mean channel RMS equals `dbfs`. Returns the applied gain. */
export function normalizeRms(chs, dbfs = -18) {
  let s = 0;
  for (const c of chs) s += rms(c) ** 2;
  const r = Math.sqrt(s / chs.length);
  const g = r > 0 ? dbToGain(dbfs) / r : 1;
  for (const c of chs) scale(c, g);
  return g;
}

// ---- envelopes --------------------------------------------------------------------------------

/**
 * Attack (linear) then exponential decay with t60 = `t60` seconds; `hold` seconds at peak first.
 * @example env({ sr, seconds: 0.5, attack: 0.002, t60: 0.3 })
 */
export function env({ sr, seconds, attack = 0, hold = 0, t60 = 0.2, curve = 1 }) {
  const n = sec(seconds, sr);
  const e = new Float64Array(n);
  const na = sec(attack, sr);
  const nh = sec(hold, sr);
  const k = Math.exp(-6.907755 / Math.max(1, t60 * sr));
  let v = 1;
  for (let i = 0; i < n; i++) {
    if (i < na) e[i] = (i / na) ** curve;
    else if (i < na + nh) e[i] = 1;
    else { e[i] = v; v *= k; }
  }
  return e;
}

/** Linear fade-in / fade-out at the buffer edges (seconds). */
export function fadeEdges(buf, inS, outS, sr) {
  const ni = sec(inS, sr); const no = sec(outS, sr);
  for (let i = 0; i < ni && i < buf.length; i++) buf[i] *= i / ni;
  for (let i = 0; i < no && i < buf.length; i++) buf[buf.length - 1 - i] *= i / no;
  return buf;
}

// ---- filters ----------------------------------------------------------------------------------

/**
 * RBJ biquad. type: lowpass | highpass | bandpass | notch | peaking | lowshelf | highshelf.
 * @example const f = biquad('bandpass', 1200, 1.5, sr); const y = f.run(x);
 */
export function biquad(type, fc, q, sr, gainDb = 0) {
  const st = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, x1: 0, x2: 0, y1: 0, y2: 0 };
  const set = (f, Q = q, gDb = gainDb) => {
    const w = TAU * Math.min(f, sr * 0.49) / sr;
    const cs = Math.cos(w); const sn = Math.sin(w);
    const alpha = sn / (2 * Math.max(1e-4, Q));
    const A = 10 ** (gDb / 40);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'lowpass': b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
      case 'highpass': b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
      case 'bandpass': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break; // constant 0 dB peak
      case 'notch': b0 = 1; b1 = -2 * cs; b2 = 1; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
      case 'peaking': b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A; break;
      case 'lowshelf': {
        const s2 = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) - (A - 1) * cs + s2); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - s2);
        a0 = (A + 1) + (A - 1) * cs + s2; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - s2; break;
      }
      case 'highshelf': {
        const s2 = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) + (A - 1) * cs + s2); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - s2);
        a0 = (A + 1) - (A - 1) * cs + s2; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - s2; break;
      }
      default: throw new Error(`biquad: unknown type ${type}`);
    }
    st.b0 = b0 / a0; st.b1 = b1 / a0; st.b2 = b2 / a0; st.a1 = a1 / a0; st.a2 = a2 / a0;
  };
  set(fc);
  const tick = (x) => {
    const y = st.b0 * x + st.b1 * st.x1 + st.b2 * st.x2 - st.a1 * st.y1 - st.a2 * st.y2;
    st.x2 = st.x1; st.x1 = x; st.y2 = st.y1; st.y1 = y;
    return y;
  };
  return {
    set,
    tick,
    /** Filter a whole buffer (new buffer). */
    run(x) { const y = new Float64Array(x.length); for (let i = 0; i < x.length; i++) y[i] = tick(x[i]); return y; },
    /**
     * Filter with fc gliding exponentially from `fc` to `fc1` over `sweep` seconds (q may glide too).
     */
    sweep(x, fc0, fc1, sweep, sr2, q0 = q, q1 = q) {
      const y = new Float64Array(x.length);
      const ns = Math.max(1, sec(sweep, sr2));
      for (let i = 0; i < x.length; i++) {
        if (i <= ns && (i % 32 === 0 || i === ns)) {
          const u = Math.min(1, i / ns);
          set(fc0 * (fc1 / fc0) ** u, q0 + (q1 - q0) * u);
        }
        y[i] = tick(x[i]);
      }
      return y;
    },
  };
}

/** One-pole low-pass (fc Hz) over a buffer. */
export function onePole(x, fc, sr) {
  const k = 1 - Math.exp(-TAU * fc / sr);
  const y = new Float64Array(x.length);
  let v = 0;
  for (let i = 0; i < x.length; i++) { v += k * (x[i] - v); y[i] = v; }
  return y;
}

// ---- sources ----------------------------------------------------------------------------------

/** Noise of a colour: white | pink (Paul Kellet) | brown. Unit-ish peak. */
export function noise({ sr, seconds, color = 'white', rng: r }) {
  const n = sec(seconds, sr);
  const out = new Float64Array(n);
  if (color === 'white') { for (let i = 0; i < n; i++) out[i] = r.pm(); return out; }
  if (color === 'brown') {
    let v = 0;
    for (let i = 0; i < n; i++) { v = (v + 0.02 * r.pm()) / 1.02; out[i] = v * 3.5; }
    return out;
  }
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = r.pm();
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856; b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return out;
}

/**
 * Pitch-gliding tone. wave: sine | triangle | sawtooth | square; f0 -> f1 exponentially over `sweep`.
 * @example tone({ sr, seconds: 0.2, wave: 'triangle', f0: 260, f1: 110, sweep: 0.045 })
 */
export function tone({ sr, seconds, wave = 'sine', f0, f1 = f0, sweep = seconds, phase = 0 }) {
  const n = sec(seconds, sr);
  const out = new Float64Array(n);
  const ns = Math.max(1, sec(sweep, sr));
  let ph = phase;
  for (let i = 0; i < n; i++) {
    const u = Math.min(1, i / ns);
    const f = f0 * (f1 / f0) ** u;
    ph += f / sr;
    const p = ph - Math.floor(ph);
    let v;
    switch (wave) {
      case 'triangle': v = 1 - 4 * Math.abs(p - 0.5); break;
      case 'sawtooth': v = 2 * p - 1; break;
      case 'square': v = p < 0.5 ? 1 : -1; break;
      default: v = Math.sin(TAU * p);
    }
    out[i] = v;
  }
  return out;
}

/**
 * Hertzian contact pulse: a half-sine of `ms` milliseconds (0.5-3 ms; harder = shorter), unit peak.
 * The excitation for a modal body.
 */
export function contactPulse({ sr, ms = 1.2 }) {
  const n = Math.max(2, sec(ms / 1000, sr));
  const out = new Float64Array(n);
  // max(0, …): sin(π) evaluates to a tiny negative number, and a negative base ** 1.5 is NaN
  for (let i = 0; i < n; i++) out[i] = Math.max(0, Math.sin(Math.PI * i / (n - 1))) ** 1.5;
  return out;
}

/**
 * Inharmonic mode set for a struck metal body. Returns [{ f, t60, amp }].
 * - `ratios` seeds the cluster (e.g. forged-plate or thin-plate sets); extra modes are added above
 *   with a stretched, slightly random spacing so the top is a dense inharmonic cluster.
 * - t60 falls with frequency as (f/f0)^-decayExp (high modes die first), amplitude as (f/f0)^-ampExp.
 * - Per-mode jitter: ±jitterCents on frequency, ±3 dB on amplitude (strike position), from `rng`.
 * @example plateModes({ f0: 220, ratios: [1, 1.47, 2.09, 2.32, 2.93, 3.61, 4.25], count: 32, t60: 0.6, rng })
 */
export function plateModes({ f0, ratios, count = 32, t60 = 0.5, decayExp = 0.8, ampExp = 0.7, jitterCents = 12, stretch = 1.06, rng: r, maxHz = 16000 }) {
  const modes = [];
  let last = ratios[ratios.length - 1];
  const list = [...ratios];
  while (list.length < count) {
    last *= stretch * (1 + 0.08 * r.pm());
    list.push(last);
  }
  for (let i = 0; i < list.length; i++) {
    const ratio = list[i] * 2 ** ((jitterCents * r.pm()) / 1200);
    const f = f0 * ratio;
    if (f > maxHz) break;
    const amp = ratio ** -ampExp * dbToGain(3 * r.pm());
    modes.push({ f, t60: t60 * ratio ** -decayExp, amp });
  }
  return modes;
}

/**
 * Modal body: each mode is a 2nd-order resonator (damped sinusoid) driven by `excitation`.
 * Output length is `seconds`. Optional `glideCents` adds a strike pitch bend (+cents at onset,
 * relaxing over `glideSeconds`) by modulating every resonator's frequency.
 * @example modalBody({ sr, seconds: 0.6, modes, excitation: contactPulse({ sr, ms: 1.5 }) })
 */
export function modalBody({ sr, seconds, modes, excitation, glideCents = 0, glideSeconds = 0.03 }) {
  const n = sec(seconds, sr);
  const out = new Float64Array(n);
  const ng = Math.max(1, sec(glideSeconds, sr));
  for (const m of modes) {
    if (m.f >= sr * 0.49) continue;
    const r = Math.exp(-6.907755 / Math.max(1, m.t60 * sr));
    let y1 = 0; let y2 = 0;
    const a2 = -r * r;
    const base = TAU * m.f / sr;
    let w = base;
    let a1 = 2 * r * Math.cos(w);
    // input scaled by sin(w): the resonator's impulse response is r^n sin((n+1)w) / sin(w), so this
    // gives every mode a unit-amplitude damped sinusoid regardless of its frequency
    let inGain = m.amp * Math.sin(w);
    for (let i = 0; i < n; i++) {
      if (glideCents !== 0 && i <= ng && (i % 16 === 0 || i === ng)) {
        const c = glideCents * (1 - Math.min(1, i / ng));
        w = base * 2 ** (c / 1200);
        a1 = 2 * r * Math.cos(w);
        inGain = m.amp * Math.sin(w);
      }
      const x = i < excitation.length ? excitation[i] * inGain : 0;
      const y = x + a1 * y1 + a2 * y2;
      y2 = y1; y1 = y;
      out[i] += y;
    }
  }
  return out;
}

/**
 * Noise burst: coloured noise through a (possibly sweeping) filter, shaped by an envelope.
 * @example noiseBurst({ sr, seconds: 0.18, color: 'white', filter: { type: 'bandpass', fc: 500, fc1: 300, q: 0.8, sweep: 0.06 }, attack: 0, t60: 0.12, rng })
 */
export function noiseBurst({ sr, seconds, color = 'white', filter = null, attack = 0, hold = 0, t60 = seconds / 3, rng: r }) {
  let x = noise({ sr, seconds, color, rng: r });
  if (filter) {
    const f = biquad(filter.type, filter.fc, filter.q ?? Math.SQRT1_2, sr, filter.gainDb ?? 0);
    x = filter.fc1 !== undefined ? f.sweep(x, filter.fc, filter.fc1, filter.sweep ?? seconds, sr, filter.q ?? Math.SQRT1_2, filter.q1 ?? filter.q ?? Math.SQRT1_2) : f.run(x);
  }
  return multiply(x, env({ sr, seconds, attack, hold, t60 }));
}

/**
 * Random flutter: smoothed noise AM, 1 + depth * lp(noise)/rms. Multiply a buffer by it.
 * @example multiply(x, flutter({ sr, seconds, rateHz: 9, depth: 0.5, rng }))
 */
export function flutter({ sr, seconds, rateHz, depth, rng: r }) {
  const n = sec(seconds, sr);
  const w = noise({ sr, seconds, color: 'white', rng: r });
  const lp = onePole(onePole(w, rateHz, sr), rateHz, sr);
  const norm = rms(lp) || 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(0, 1 + depth * (lp[i] / norm) * 0.7);
  return out;
}

/**
 * Poisson crackle: sparse impulses (`rateHz` per second) each decaying over `tauMs`, band-passed.
 * Impulse amplitude is log-uniform over `dynamicDb`. `rateDecay` (0..1) makes the rate fall over the clip.
 * @example crackle({ sr, seconds: 1.2, rateHz: 60, tauMs: 4, band: [2500, 7000], dynamicDb: 18, rng })
 */
export function crackle({ sr, seconds, rateHz, tauMs = 3, band = [2000, 8000], dynamicDb = 18, rateDecay = 0, rng: r }) {
  const n = sec(seconds, sr);
  const out = new Float64Array(n);
  let t = 0;
  for (;;) {
    const rate = rateHz * (1 - rateDecay * (t / seconds));
    t += -Math.log(Math.max(1e-9, r.next())) / Math.max(0.1, rate);
    if (t >= seconds) break;
    const i0 = sec(t, sr);
    const a = dbToGain(-r.next() * dynamicDb) * (r.chance(0.5) ? 1 : -1);
    const tau = (tauMs / 1000) * sr * r.range(0.6, 1.4);
    const len = Math.min(n - i0, Math.ceil(tau * 7));
    for (let i = 0; i < len; i++) out[i0 + i] += a * Math.exp(-i / tau) * (i === 0 ? 1 : r.pm());
  }
  const bp = biquad('bandpass', Math.sqrt(band[0] * band[1]), Math.sqrt(band[0] * band[1]) / (band[1] - band[0]), sr);
  return bp.run(out);
}

/**
 * Bubbles: random damped sine chirps (f rising x1.6-2.4 over 40-120 ms) at Poisson times.
 * @example bubbles({ sr, seconds: 24, everyS: [0.25, 1.8], f: [70, 220], rng })
 */
export function bubbles({ sr, seconds, everyS = [0.25, 1.8], f = [70, 220], rng: r, pan = null }) {
  const n = sec(seconds, sr);
  const L = new Float64Array(n);
  const R = pan ? new Float64Array(n) : L;
  let t = r.range(0, everyS[1]);
  while (t < seconds) {
    const f0 = r.range(f[0], f[1]);
    const dur = r.range(0.04, 0.12);
    const chirp = tone({ sr, seconds: dur * 2.5, wave: 'sine', f0, f1: f0 * r.range(1.6, 2.4), sweep: dur });
    multiply(chirp, env({ sr, seconds: dur * 2.5, attack: 0.004, t60: dur }));
    const g = dbToGain(r.range(-10, 0));
    const p = pan ? r.range(-pan, pan) : 0;
    const gl = g * Math.cos((p + 1) * Math.PI / 4);
    const gr = g * Math.sin((p + 1) * Math.PI / 4);
    mixInto(L, chirp, t, sr, pan ? gl : g);
    if (pan) mixInto(R, chirp, t, sr, gr);
    t += r.range(everyS[0], everyS[1]);
  }
  return pan ? [L, R] : L;
}

/** tanh soft clip with drive; unity-normalised. */
export function saturate(buf, drive = 2) {
  const k = Math.tanh(drive);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * drive) / k;
  return buf;
}

/** Equal-power constant pan of a mono buffer: returns [L, R]. pan in [-1, 1]. */
export function panMono(buf, pan = 0) {
  const a = (pan + 1) * Math.PI / 4;
  const L = new Float64Array(buf.length); const R = new Float64Array(buf.length);
  const gl = Math.cos(a); const gr = Math.sin(a);
  for (let i = 0; i < buf.length; i++) { L[i] = buf[i] * gl; R[i] = buf[i] * gr; }
  return [L, R];
}

/** Simple stereo widener: delays one side by `ms` and mixes with a decorrelated copy. */
export function haasWiden(buf, ms, sr, amount = 0.3) {
  const d = sec(ms / 1000, sr);
  const L = new Float64Array(buf.length); const R = new Float64Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    L[i] = buf[i] + (i >= d ? buf[i - d] * amount : 0);
    R[i] = buf[i] - (i >= d ? buf[i - d] * amount : 0);
  }
  return [L, R];
}

/**
 * Make a buffer loop seamlessly: cross-fade its last `xfade` seconds into its first `xfade` seconds
 * and cut the overlap. Returns a new buffer of length - xfade.
 */
export function loopify(buf, xfade, sr) {
  const nx = sec(xfade, sr);
  const n = buf.length - nx;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = buf[i];
  for (let i = 0; i < nx; i++) {
    const u = i / nx;
    const a = Math.cos(u * Math.PI / 2); const b = Math.sin(u * Math.PI / 2);
    out[i] = buf[i] * b + buf[n + i] * a;
  }
  return out;
}

// ---- analysis ---------------------------------------------------------------------------------

/** In-place radix-2 FFT (re, im). Length must be a power of two. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -TAU / len;
    const wr = Math.cos(ang); const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1; let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j]; const ui = im[i + j];
        const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ur + vr; im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/**
 * Spectral measurements over the first `window` seconds: centroid (Hz), band energy shares (%) for
 * sub <100, low 100-300, mid 300-1000, pres 1-3k, high 3-8k, air >8k, spectral flatness (0..1).
 */
export function spectrum(buf, sr, window = 0.15) {
  let n = 1;
  const want = Math.min(buf.length, sec(window, sr));
  while (n < want) n <<= 1;
  const re = new Float64Array(n); const im = new Float64Array(n);
  for (let i = 0; i < want; i++) re[i] = buf[i] * (0.5 - 0.5 * Math.cos(TAU * i / want));
  fft(re, im);
  const half = n / 2;
  const edges = [0, 100, 300, 1000, 3000, 8000, 1e9];
  const bands = new Array(6).fill(0);
  let tot = 0; let cen = 0; let logSum = 0;
  for (let k = 1; k < half; k++) {
    const f = k * sr / n;
    const p = re[k] * re[k] + im[k] * im[k];
    tot += p; cen += f * p; logSum += Math.log(p + 1e-20);
    for (let b = 0; b < 6; b++) if (f >= edges[b] && f < edges[b + 1]) { bands[b] += p; break; }
  }
  const flat = Math.exp(logSum / (half - 1)) / (tot / (half - 1) + 1e-20);
  return { centroidHz: tot > 0 ? cen / tot : 0, bandsPct: bands.map((b) => (tot > 0 ? (100 * b) / tot : 0)), flatness: flat };
}

// ---- files ------------------------------------------------------------------------------------

/** 16-bit (or 24-bit) PCM WAV bytes for channel arrays in [-1, 1]. */
export function wavBytes(chs, sr, bits = 24) {
  const n = chs[0].length; const nc = chs.length; const bps = bits / 8;
  const buf = Buffer.alloc(44 + n * nc * bps);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * nc * bps, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(nc, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * nc * bps, 28); buf.writeUInt16LE(nc * bps, 32); buf.writeUInt16LE(bits, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * nc * bps, 40);
  let o = 44;
  const max = bits === 24 ? 8388607 : 32767;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nc; c++) {
      const v = Math.round(Math.max(-1, Math.min(1, chs[c][i])) * max);
      if (bits === 24) buf.writeIntLE(v, o, 3); else buf.writeInt16LE(v, o);
      o += bps;
    }
  }
  return buf;
}
