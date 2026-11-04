// Hitstop (freeze frames) counter for the fixed-step sim (story-002 AC 3). DOM/three-free.

/** Counts down freeze ticks. Overlapping triggers keep the longer freeze, they do not stack. */
export class Hitstop {
  constructor() {
    this.remaining = 0;
  }

  /** Request `frames` freeze ticks starting next tick. */
  trigger(frames) {
    if (frames > this.remaining) this.remaining = frames;
  }

  /**
   * Call once per sim tick before simulating.
   * @returns {boolean} true if this tick is frozen (consumes one freeze tick)
   */
  tick() {
    if (this.remaining <= 0) return false;
    this.remaining--;
    return true;
  }

  reset() {
    this.remaining = 0;
  }
}
