// Keyboard adapter: routes window key events into an InputState (its bindings decide which keys
// count) and drops held state when focus or orientation changes. DOM only at attach time.

/**
 * Attach keydown/keyup (preventDefault on bound keys), blur and orientationchange (input.reset())
 * listeners to `target`. Returns a detach function that removes all four.
 * @example const detach = attachKeyboard(window, input); // later: detach();
 * @param {{addEventListener: Function, removeEventListener: Function}} target usually window
 * @param {{keyDown(code: string, now: number): boolean, keyUp(code: string): boolean, reset(): void}} input
 * @param {() => number} [now] ms clock for chord timing (default performance.now)
 * @returns {() => void}
 */
export function attachKeyboard(target, input, now = () => performance.now()) {
  const down = (e) => {
    if (input.keyDown(e.code, now())) e.preventDefault();
  };
  const up = (e) => {
    if (input.keyUp(e.code)) e.preventDefault();
  };
  const reset = () => input.reset();
  target.addEventListener('keydown', down);
  target.addEventListener('keyup', up);
  target.addEventListener('blur', reset);
  target.addEventListener('orientationchange', reset);
  return () => {
    target.removeEventListener('keydown', down);
    target.removeEventListener('keyup', up);
    target.removeEventListener('blur', reset);
    target.removeEventListener('orientationchange', reset);
  };
}
