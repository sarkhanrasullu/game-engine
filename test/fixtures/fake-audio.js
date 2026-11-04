// Headless WebAudio stand-in for engine tests (no real audio in node). Records nodes, connections and
// AudioParam automation; exponential ramps to <= 0 throw like the real API. Generic: no game names.

export class FakeParam {
  constructor(v = 0) {
    this.value = v;
    this.events = [];
  }
  setValueAtTime(v, t) { this.events.push(['set', v, t]); this.value = v; return this; }
  exponentialRampToValueAtTime(v, t) {
    if (!(v > 0)) throw new RangeError('exponential ramp target must be > 0');
    this.events.push(['exp', v, t]);
    return this;
  }
  linearRampToValueAtTime(v, t) { this.events.push(['lin', v, t]); return this; }
  setTargetAtTime(v, t, c) { this.events.push(['target', v, t, c]); return this; }
  cancelScheduledValues(t) { this.events.push(['cancel', t]); return this; }
}

export class FakeNode {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.outputs = [];
    ctx.nodes.push(this);
  }
  connect(n) { this.outputs.push(n); return n; }
  disconnect() { this.outputs.length = 0; }
}

export class FakeSource extends FakeNode {
  start(t = 0, offset = 0) { this.startAt = t; this.offset = offset; }
  stop(t = 0) { this.stopAt = t; }
}

/** Minimal AudioContext with every node type the engine audio modules create. */
export class FakeAudioContext {
  constructor(opts) {
    this.opts = opts;
    this.state = 'suspended';
    this.currentTime = 0;
    this.sampleRate = 8000;
    this.nodes = [];
    this.destination = new FakeNode(this, 'destination');
    this.decoded = [];
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  createGain() { const n = new FakeNode(this, 'gain'); n.gain = new FakeParam(1); return n; }
  createOscillator() {
    const n = new FakeSource(this, 'osc');
    n.type = 'sine';
    n.frequency = new FakeParam(440);
    n.detune = new FakeParam(0);
    return n;
  }
  createBufferSource() {
    const n = new FakeSource(this, 'buffer');
    n.buffer = null; n.loop = false; n.loopStart = 0; n.loopEnd = 0;
    n.playbackRate = new FakeParam(1);
    n.detune = new FakeParam(0);
    return n;
  }
  createBiquadFilter() {
    const n = new FakeNode(this, 'biquad');
    n.type = 'lowpass';
    n.frequency = new FakeParam(350);
    n.Q = new FakeParam(1);
    n.detune = new FakeParam(0);
    n.gain = new FakeParam(0);
    return n;
  }
  createDynamicsCompressor() {
    const n = new FakeNode(this, 'compressor');
    for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = new FakeParam(0);
    n.reduction = 0;
    return n;
  }
  createConvolver() { const n = new FakeNode(this, 'convolver'); n.buffer = null; n.normalize = true; return n; }
  createWaveShaper() { const n = new FakeNode(this, 'shaper'); n.curve = null; n.oversample = 'none'; return n; }
  createStereoPanner() { const n = new FakeNode(this, 'panner'); n.pan = new FakeParam(0); return n; }
  createChannelMerger(k = 6) { const n = new FakeNode(this, 'merger'); n.inputs = k; return n; }
  createChannelSplitter(k = 6) { const n = new FakeNode(this, 'splitter'); n.outputs2 = k; return n; }
  createConstantSource() { const n = new FakeSource(this, 'constant'); n.offset = new FakeParam(1); return n; }
  createDelay(max = 1) { const n = new FakeNode(this, 'delay'); n.delayTime = new FakeParam(0); n.max = max; return n; }
  createBuffer(ch, len, sr) {
    const data = [];
    for (let c = 0; c < ch; c++) data.push(new Float32Array(len));
    return { numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr, getChannelData: (c) => data[c] };
  }
  /** Decodes any ArrayBuffer into a 1-channel buffer of byteLength/4 samples; a 0-byte buffer rejects. */
  decodeAudioData(ab) {
    if (!ab || ab.byteLength === 0) return Promise.reject(new Error('decode failed'));
    const b = this.createBuffer(1, Math.max(1, ab.byteLength >> 2), this.sampleRate);
    this.decoded.push(b);
    return Promise.resolve(b);
  }
  count(kind) { return this.nodes.filter((n) => n.kind === kind).length; }
}

/** Fake window: AudioContext ctor, listeners, document with visibility, timers that run on demand. */
export function fakeWindow() {
  const listeners = {};
  const docListeners = {};
  const timers = [];
  const win = {
    contexts: [],
    AudioContext: class extends FakeAudioContext {
      constructor(o) { super(o); win.contexts.push(this); }
    },
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    fire(type) { for (const fn of listeners[type] ?? []) fn({ type }); },
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].fn = null; },
    /** Run every pending timer callback (tests). */
    runTimers() { const t = timers.splice(0); for (const x of t) if (x.fn) x.fn(); },
    document: {
      hidden: false,
      addEventListener(type, fn) { (docListeners[type] ??= []).push(fn); },
      fire(type) { for (const fn of docListeners[type] ?? []) fn({ type }); },
    },
  };
  return win;
}

/** Recording navigator.vibrate. */
export function fakeNavigator() {
  const calls = [];
  return { calls, vibrate(p) { calls.push(p); return true; } };
}

/** fetch stand-in: `files` maps URL -> byte length (0 = decode failure); unknown URLs 404. */
export function fakeFetch(files) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (!(url in files)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(files[url]) };
  };
  fetch.calls = calls;
  return fetch;
}
