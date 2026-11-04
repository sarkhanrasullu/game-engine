// Fixed-timestep loop: simulation at a constant rate, render once per display frame with an
// interpolation alpha. DOM/three-free so it is unit-testable. (story-001 AC 5)

export const SIM_HZ = 60;

export class FixedStepLoop {
  /**
   * @param {{step:(dt:number)=>void, render:(alpha:number)=>void, hz?:number, maxStepsPerFrame?:number, maxFrameMs?:number}} opts
   */
  constructor({ step, render, hz = SIM_HZ, maxStepsPerFrame = 5, maxFrameMs = 250 }) {
    this.step = step;
    this.render = render;
    this.dt = 1 / hz;
    this.maxSteps = maxStepsPerFrame;
    this.maxFrameMs = maxFrameMs;
    this.acc = 0;
    this.last = -1;
  }

  /** Call from requestAnimationFrame / setAnimationLoop with a ms timestamp. */
  frame(timeMs) {
    if (this.last < 0) this.last = timeMs;
    let delta = (timeMs - this.last) / 1000;
    this.last = timeMs;
    const maxDelta = this.maxFrameMs / 1000;
    if (delta > maxDelta) delta = maxDelta; // tab was backgrounded, avoid a catch-up burst
    if (delta < 0) delta = 0;
    this.acc += delta;
    let steps = 0;
    while (this.acc >= this.dt && steps < this.maxSteps) {
      this.step(this.dt);
      this.acc -= this.dt;
      steps++;
    }
    if (this.acc >= this.dt) this.acc = 0; // spiral-of-death guard: drop the backlog
    this.render(this.acc / this.dt);
  }
}
