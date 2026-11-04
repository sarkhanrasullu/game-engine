// Test fixture (not shipped): the engine with fixture defaults bound in, mirroring a consumer's
// default-bound re-export layer so the copied unit tests run against frozen tuning data.
import {
  HANDEDNESS, resolveHandedness as engineResolveHandedness, stickZoneSide as engineStickZoneSide,
} from '../../../src/input/index.js';

export const INPUT_CONFIG = Object.freeze({
  /** Max gap between two stick taps in the same vertical direction to count as a sidestep (UX #10). */
  doubleTapWindowMs: 300,
  /** |stick.y| above this enters a vertical "tap" zone (UX #9; matches the sim's verticalThreshold target). */
  stickTapThreshold: 0.65,
  /** A tap zone is only left once |stick.y| drops below this (hysteresis, UX #9). */
  stickTapReleaseThreshold: 0.45,
  /** Radial touch-stick dead zone, fraction of stickRadiusPx. Below: (0,0); above: raw, no rescale (UX #8). */
  stickDeadZone: 0.15,
  /** Keyboard only: max gap between Light and Heavy presses to resolve as Throw. Light/Heavy wait this long. */
  throwWindowMs: 50,
  /** Touch Light/Heavy use the chord (and its delay) only if true. Off: touch has a dedicated Throw button (UX #2). */
  touchThrowChord: false,
  /** Virtual stick travel radius in CSS px. */
  stickRadiusPx: 64,
  /** Min gap in CSS px between the floating stick ring and the safe-area / zone edge (UX #6). */
  stickEdgeMarginPx: 8,
  /**
   * Knob radius in CSS px (index.html #stick-knob is 64x64). The knob centre travels up to
   * stickRadiusPx from the origin, so the origin clamp must also reserve this, or a knob on the rim
   * pokes up to this many px past the safe edge.
   */
  stickKnobRadiusPx: 32,
  /**
   * Default control handedness: 'right' = stick on the left, buttons on the right; 'left' mirrors it
   * (UX #5). Story 004 persists the player's choice; read through resolveHandedness().
   */
  handedness: 'right',
});

/** Keyboard code -> abstract action (injected into the engine InputState). Same actions the touch layer drives. */
export const KEY_BINDINGS = Object.freeze({
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  KeyW: 'up',
  ArrowUp: 'up',
  KeyS: 'down',
  ArrowDown: 'down',
  KeyJ: 'light',
  KeyK: 'heavy',
  KeyL: 'guard',
  KeyU: 'throw',
});

export { HANDEDNESS };

/** @param {unknown} hand @returns {'right'|'left'} unknown values fall back to the config default. */
export function resolveHandedness(hand) {
  return engineResolveHandedness(hand, INPUT_CONFIG.handedness);
}

/** Screen half the stick zone covers: right-handed players steer with the left thumb. */
export function stickZoneSide(hand) {
  return engineStickZoneSide(hand, INPUT_CONFIG.handedness);
}
