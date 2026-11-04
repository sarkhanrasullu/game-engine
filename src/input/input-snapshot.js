// Per-frame input snapshot. DOM-free: touch and keyboard layers call into InputState,
// the fixed-step sim calls sample() once per step. The tuning (InputConfig) and the keyboard
// bindings (KeyBindings: KeyboardEvent.code -> action) are injected by the game.
//
// InputConfig (all numbers unless noted):
//   doubleTapWindowMs         max gap between two stick taps in the same vertical direction (sidestep)
//   stickTapThreshold         |stick.y| above this enters a vertical "tap" zone
//   stickTapReleaseThreshold  a tap zone is only left once |stick.y| drops below this (hysteresis)
//   stickDeadZone             radial touch-stick dead zone (fraction of the stick radius)
//   throwWindowMs             keyboard: max gap between Light and Heavy presses to resolve as Throw
//   touchThrowChord           (boolean) touch Light/Heavy use the chord (and its delay)
//   stickRadiusPx, stickEdgeMarginPx, stickKnobRadiusPx   touch-stick geometry (touch-stick.js)
// Actions: 'left' | 'right' | 'up' | 'down' | 'light' | 'heavy' | 'guard' | 'throw'.

/**
 * Snapshot consumed by the sim. stick.y: +1 up. light/heavy/throw are one-step events,
 * guard is held, sidestep is 0 or +1 (up, away from camera) / -1 (down, toward camera).
 * @returns {{stick:{x:number,y:number},light:boolean,heavy:boolean,guard:boolean,throw:boolean,sidestep:number}}
 */
export function createSnapshot() {
  return { stick: { x: 0, y: 0 }, light: false, heavy: false, guard: false, throw: false, sidestep: 0 };
}

/**
 * Detects two taps of the stick into the same vertical zone within a window. A zone is entered
 * above `threshold` and only left below `releaseThreshold` (hysteresis), so a thumb resting near
 * the threshold cannot jitter out a sidestep.
 */
export class DoubleTapDetector {
  /**
   * @example const taps = new DoubleTapDetector(300, 0.65, 0.45); taps.update(stickY, nowMs); // -1 | 0 | 1
   * @param {number} windowMs @param {number} threshold @param {number} releaseThreshold
   */
  constructor(windowMs, threshold, releaseThreshold) {
    this.windowMs = windowMs;
    this.threshold = threshold;
    this.releaseThreshold = Math.min(releaseThreshold, threshold);
    this.zone = 0;
    this.lastDir = 0;
    this.lastTime = -Infinity;
  }

  /**
   * @param {number} y stick vertical axis (+up)
   * @param {number} now ms
   * @returns {number} +1 / -1 when a double tap just completed, else 0
   */
  update(y, now) {
    let zone = this.zone;
    if (zone !== 0 && y * zone < this.releaseThreshold) zone = 0;
    if (y > this.threshold) zone = 1;
    else if (y < -this.threshold) zone = -1;
    let fired = 0;
    if (zone !== this.zone) {
      if (zone !== 0) {
        if (this.lastDir === zone && now - this.lastTime <= this.windowMs) {
          fired = zone;
          this.lastDir = 0;
        } else {
          this.lastDir = zone;
          this.lastTime = now;
        }
      }
      this.zone = zone;
    }
    return fired;
  }

  reset() {
    this.zone = 0;
    this.lastDir = 0;
    this.lastTime = -Infinity;
  }
}

/** Collects raw input from any source and turns it into snapshots. No allocation in sample(). */
export class InputState {
  /**
   * @example
   *   const input = new InputState(myInputConfig, { KeyJ: 'light', KeyK: 'heavy', ArrowLeft: 'left' });
   *   input.keyDown('KeyJ', performance.now()); input.sample(snapshot, performance.now());
   * @param {Readonly<Record<string, number|boolean>>} config InputConfig (see the file header)
   * @param {Readonly<Record<string, string>>} bindings KeyboardEvent.code -> action
   */
  constructor(config, bindings) {
    this.config = config;
    this.bindings = bindings;
    this.tapDetector = new DoubleTapDetector(
      config.doubleTapWindowMs,
      config.stickTapThreshold,
      config.stickTapReleaseThreshold,
    );
    this.touchX = 0;
    this.touchY = 0;
    this.guardTouch = false;
    this.keys = { left: false, right: false, up: false, down: false, light: false, heavy: false, guard: false, throw: false };
    this.pending = null; // 'light' | 'heavy' awaiting a possible throw partner
    this.pendingTime = 0;
    this.latchLight = false;
    this.latchHeavy = false;
    this.latchThrow = false;
  }

  /** Virtual stick position, each axis in [-1, 1], +y up. Radial dead zone: (0,0) inside, raw outside. */
  setStick(x, y) {
    const dz = this.config.stickDeadZone ?? 0;
    if (x * x + y * y < dz * dz) {
      x = 0;
      y = 0;
    }
    this.touchX = x;
    this.touchY = y;
  }

  setGuard(held) {
    this.guardTouch = held;
  }

  /**
   * On-screen Light/Heavy press. Fires on the next sample() with no chord wait, unless the
   * config opts touch back into the chord (touchThrowChord).
   */
  pressTouch(name, now) {
    if (name !== 'light' && name !== 'heavy') return;
    if (this.config.touchThrowChord) {
      this.pressButton(name, now);
      return;
    }
    if (name === 'light') this.latchLight = true;
    else this.latchHeavy = true;
  }

  /** Dedicated Throw (touch button or KeyU). Same snapshot flag the chord sets, so the same throw start. */
  pressThrow() {
    this.latchThrow = true;
  }

  /** Chorded Light/Heavy press (keyboard). Light+Heavy within throwWindowMs resolves to Throw only. */
  pressButton(name, now) {
    if (name !== 'light' && name !== 'heavy') return;
    if (this.pending !== null) {
      if (this.pending !== name && now - this.pendingTime <= this.config.throwWindowMs) {
        this.latchThrow = true;
        this.pending = null;
        return;
      }
      this.#flushPending();
    }
    this.pending = name;
    this.pendingTime = now;
  }

  #flushPending() {
    if (this.pending === 'light') this.latchLight = true;
    else if (this.pending === 'heavy') this.latchHeavy = true;
    this.pending = null;
  }

  /** @returns {boolean} true if the key is bound (caller may preventDefault). */
  keyDown(code, now) {
    const action = this.bindings[code];
    if (action === undefined) return false;
    if (this.keys[action]) return true; // auto-repeat
    this.keys[action] = true;
    if (action === 'light' || action === 'heavy') this.pressButton(action, now);
    else if (action === 'throw') this.pressThrow();
    return true;
  }

  keyUp(code) {
    const action = this.bindings[code];
    if (action === undefined) return false;
    this.keys[action] = false;
    return true;
  }

  /** Drop all held state (window blur, orientation change). */
  reset() {
    this.touchX = 0;
    this.touchY = 0;
    this.guardTouch = false;
    for (const k in this.keys) this.keys[k] = false;
    this.pending = null;
    this.latchLight = this.latchHeavy = this.latchThrow = false;
    this.tapDetector.reset();
  }

  /**
   * Fill `out` for one sim step and clear one-shot events.
   * @param {ReturnType<typeof createSnapshot>} out
   * @param {number} now ms
   */
  sample(out, now) {
    if (this.pending !== null && now - this.pendingTime >= this.config.throwWindowMs) this.#flushPending();
    const k = this.keys;
    const x = this.touchX + (k.right ? 1 : 0) - (k.left ? 1 : 0);
    const y = this.touchY + (k.up ? 1 : 0) - (k.down ? 1 : 0);
    out.stick.x = x > 1 ? 1 : x < -1 ? -1 : x;
    out.stick.y = y > 1 ? 1 : y < -1 ? -1 : y;
    out.sidestep = this.tapDetector.update(out.stick.y, now);
    out.light = this.latchLight;
    out.heavy = this.latchHeavy;
    out.throw = this.latchThrow;
    out.guard = this.guardTouch || k.guard;
    this.latchLight = this.latchHeavy = this.latchThrow = false;
    return out;
  }
}
