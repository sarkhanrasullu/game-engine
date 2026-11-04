// Control handedness helpers: which screen half the touch stick covers. Pure, DOM-free.
// 'right' = stick on the left, buttons on the right (right-handed); 'left' mirrors it.

/** Valid handedness values. */
export const HANDEDNESS = Object.freeze(['right', 'left']);

/**
 * @example resolveHandedness('sideways', 'right') // 'right'
 * @param {unknown} hand
 * @param {'right'|'left'} fallback the game's default (unknown values fall back to it)
 * @returns {'right'|'left'}
 */
export function resolveHandedness(hand, fallback) {
  return HANDEDNESS.includes(/** @type {string} */ (hand)) ? /** @type {'right'|'left'} */ (hand) : fallback;
}

/**
 * Screen half the stick zone covers: right-handed players steer with the left thumb.
 * @example stickZoneSide('left', 'right') // 'right'
 * @param {unknown} hand @param {'right'|'left'} fallback
 */
export function stickZoneSide(hand, fallback) {
  return resolveHandedness(hand, fallback) === 'left' ? 'right' : 'left';
}
