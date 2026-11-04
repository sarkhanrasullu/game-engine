// Seeded PRNG for AI decisions (story-004 AC 7). Pure, DOM-free, allocation-free per call.

/**
 * mulberry32: small, fast, 32-bit state. Same seed -> same sequence on every platform.
 */
export class SeededRng {
  /** @param {number} seed any integer (coerced to uint32) */
  constructor(seed = 1) {
    this.state = seed >>> 0;
  }

  /** @returns {number} float in [0, 1) */
  next() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** @param {number} p probability 0..1 @returns {boolean} true with probability p */
  chance(p) {
    return this.next() < p;
  }

  /** @param {number} n @returns {number} integer in [0, n) */
  int(n) {
    return Math.floor(this.next() * n);
  }
}
