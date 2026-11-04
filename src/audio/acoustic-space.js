// Shared acoustic space and phone-speaker bass guard (engine /audio; ADR-0005).
// - makeImpulseResponse: a deterministic procedural stereo IR (decorrelated noise with per-band RT60,
//   pre-delay and sparse low-passed early reflections), unit-energy normalised so the return level
//   in the mix is set by data, not by the IR's length.
// - createAcousticSpace: ONE ConvolverNode (normalize = false) fed by a summing send input and
//   returned through a gain. Buses or events connect sends with createSend(); per-voice cost is
//   zero for bus sends and one GainNode for an optional per-event send.
// - createHarmonicLift: the "phone speaker guard". Small speakers roll off below ~500 Hz, so sub
//   weight vanishes. The lift takes the band below splitHz, soft-clips it (tanh WaveShaper) to
//   generate 2nd/3rd harmonics, band-passes them into 180-360 Hz and mixes them back in at mixDb.
//   Weight stays audible above ~150 Hz without adding more sub-bass. Four nodes per bus, zero per
//   voice. Pure WebAudio graph code: nothing here reads game data. Main thread only.

/** Fixed-seed LCG in (-1, 1): presentation only. */
function lcg(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return (x / 4294967296) * 2 - 1;
  };
}

/**
 * Deterministic stereo impulse response for a mid-sized hard room.
 * @example
 *   const ir = makeImpulseResponse(ctx, { seconds: 2.4, rt60: { low: 2.0, mid: 1.4, high: 0.6 }, predelayMs: 18, seed: 5 });
 *   convolver.buffer = ir;
 * @param {{sampleRate: number, createBuffer: (ch: number, len: number, sr: number) => AudioBuffer}} ctx
 * @param {object} [o]
 * @param {number} [o.seconds] IR length (2.4)
 * @param {{low: number, mid: number, high: number}} [o.rt60] decay to -60 dB per band, seconds
 * @param {[number, number]} [o.crossoverHz] low/mid and mid/high split frequencies ([250, 2500])
 * @param {number} [o.predelayMs] silence before the diffuse tail (18)
 * @param {readonly {ms: number, db: number}[]} [o.early] early reflections (default 7 taps 7..104 ms)
 * @param {number} [o.earlyLowpassHz] one-pole low-pass on the reflections (5000)
 * @param {number} [o.seed] noise seed (1)
 * @returns {AudioBuffer} 2 channels, unit total energy
 */
export function makeImpulseResponse(ctx, {
  seconds = 2.4, rt60 = { low: 2.0, mid: 1.4, high: 0.6 }, crossoverHz = [250, 2500], predelayMs = 18,
  early = [{ ms: 7, db: -6 }, { ms: 13, db: -8 }, { ms: 23, db: -10 }, { ms: 37, db: -12 }, { ms: 59, db: -14 }, { ms: 83, db: -16 }, { ms: 104, db: -18 }],
  earlyLowpassHz = 5000, seed = 1,
} = {}) {
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.ceil(seconds * sr));
  const buf = ctx.createBuffer(2, n, sr);
  const pre = Math.floor((predelayMs / 1000) * sr);
  const kLo = 1 - Math.exp((-2 * Math.PI * crossoverHz[0]) / sr);
  const kHi = 1 - Math.exp((-2 * Math.PI * crossoverHz[1]) / sr);
  const kEarly = 1 - Math.exp((-2 * Math.PI * earlyLowpassHz) / sr);
  const dLo = Math.exp((-6.907755 / rt60.low) / sr); // ln(1000) / rt60 per sample
  const dMid = Math.exp((-6.907755 / rt60.mid) / sr);
  const dHi = Math.exp((-6.907755 / rt60.high) / sr);
  let energy = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const rnd = lcg(seed * 7919 + ch * 104729);
    let lo = 0; let mid = 0; let eLo = 1; let eMid = 1; let eHi = 1;
    for (let i = pre; i < n; i++) {
      const w = rnd();
      lo += kLo * (w - lo);
      mid += kHi * (w - mid);
      const hi = w - mid;
      const band = lo * eLo + (mid - lo) * eMid + hi * eHi;
      eLo *= dLo; eMid *= dMid; eHi *= dHi;
      d[i] = band;
    }
    // early reflections: low-passed clicks, alternating sign, slightly different taps per channel
    let lp = 0;
    for (let k = 0; k < early.length; k++) {
      const at = Math.min(n - 1, Math.floor(((early[k].ms + ch * 1.7) / 1000) * sr));
      const g = 10 ** (early[k].db / 20) * (k % 2 === 0 ? 1 : -1);
      for (let i = at, s = g * 4; i < n && i < at + 64; i++) {
        lp += kEarly * (s - lp);
        d[i] += lp;
        s = 0;
      }
      lp = 0;
    }
    for (let i = 0; i < n; i++) energy += d[i] * d[i];
  }
  const norm = energy > 0 ? 1 / Math.sqrt(energy) : 1;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) d[i] *= norm;
  }
  return buf;
}

/**
 * The shared reverb bus: sends -> input -> convolver -> return gain -> `destination`.
 * @example
 *   const space = createAcousticSpace(ctx, { ir: makeImpulseResponse(ctx), returnDb: -6 });
 *   space.connect(master);
 *   const send = createSend(ctx, buses.combat, space, -14); // post-fader bus send
 *   space.setTier('low'); // short IR / bypass handled by the caller through setIr / setReturnDb
 * @param {AudioContext} ctx
 * @param {{ir: AudioBuffer, returnDb?: number}} o
 */
export function createAcousticSpace(ctx, { ir, returnDb = -6 }) {
  const input = ctx.createGain();
  const conv = ctx.createConvolver();
  conv.normalize = false;
  conv.buffer = ir;
  const out = ctx.createGain();
  out.gain.value = 10 ** (returnDb / 20);
  input.connect(conv).connect(out);
  return {
    /** Summing point for sends. */
    input,
    /** Return gain (connect it to the master). */
    output: out,
    convolver: conv,
    /** @param {AudioNode} dest */
    connect(dest) { out.connect(dest); return dest; },
    /** @param {number} db return level; ramps over `ms` */
    setReturnDb(db, ms = 50) {
      const t = ctx.currentTime;
      out.gain.cancelScheduledValues(t);
      out.gain.setTargetAtTime(10 ** (db / 20), t, Math.max(0.001, ms / 3000));
    },
    /** Swap the IR (e.g. a shorter one on the low perf tier); null bypasses (silent return). */
    setIr(buffer) { conv.buffer = buffer; },
    dispose() { input.disconnect(); conv.disconnect(); out.disconnect(); },
  };
}

/**
 * Connect `from` to the space at `db`. Returns the send gain (keep it to disconnect / re-level).
 * @example const send = createSend(ctx, voiceOut, space, -12); // one GainNode per voice with a per-event send
 * @param {AudioContext} ctx @param {AudioNode} from @param {{input: AudioNode}} space @param {number} db
 */
export function createSend(ctx, from, space, db) {
  const g = ctx.createGain();
  g.gain.value = 10 ** (db / 20);
  from.connect(g).connect(space.input);
  return g;
}

/** tanh soft-clip curve for a WaveShaperNode (symmetric, unity at full scale). */
export function makeTanhCurve(drive = 2.5, size = 1024) {
  const c = new Float32Array(size);
  const k = Math.tanh(drive);
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    c[i] = Math.tanh(drive * x) / k;
  }
  return c;
}

/**
 * Harmonic lift insert for one bus (phone-speaker bass guard). Insert between the bus gain and the
 * master: bus -> lift.input, lift.output -> master. The dry path is unity; the lifted band adds
 * harmonics of the sub content at mixDb so weight survives a 500 Hz speaker roll-off.
 * @example
 *   const lift = createHarmonicLift(ctx, { splitHz: 120, drive: 2.5, bandHz: [180, 360], mixDb: -8 });
 *   bus.connect(lift.input); lift.output.connect(master);
 * @param {AudioContext} ctx
 * @param {{splitHz?: number, drive?: number, bandHz?: [number, number], mixDb?: number}} [o]
 */
export function createHarmonicLift(ctx, { splitHz = 120, drive = 2.5, bandHz = [180, 360], mixDb = -8 } = {}) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(output); // dry, unity
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = splitHz;
  lp.Q.value = 0.7;
  const shaper = ctx.createWaveShaper();
  shaper.curve = makeTanhCurve(drive);
  shaper.oversample = '2x';
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  const fc = Math.sqrt(bandHz[0] * bandHz[1]);
  bp.frequency.value = fc;
  bp.Q.value = fc / (bandHz[1] - bandHz[0]);
  const mix = ctx.createGain();
  mix.gain.value = 10 ** (mixDb / 20);
  input.connect(lp).connect(shaper).connect(bp).connect(mix).connect(output);
  return {
    input,
    output,
    /** @param {number} db lifted-band level (-Infinity-ish like -120 to bypass) */
    setMixDb(db) { mix.gain.value = 10 ** (db / 20); },
    dispose() { for (const n of [input, lp, shaper, bp, mix, output]) n.disconnect(); },
  };
}
