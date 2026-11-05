// @sarkhanrasullu/game-engine/audio: SFX data schema (injected cue list; tone / noise / partials /
// sample layers), dB helper, sample banks, the shared acoustic space + phone-speaker harmonic lift,
// rate-limited haptics over an injectable backend (ADR-0005), and the hit-frame cost tools: a reusable
// node pool and the oscillator wave-table warmer (AUDIO-PERF).
export * from './sfx-schema.js';
export * from './sample-bank.js';
export * from './acoustic-space.js';
export * from './haptics.js';
export * from './node-pool.js';
