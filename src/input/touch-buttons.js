// Light / Heavy / Guard / Throw on-screen buttons. Pointer Events, each button tracks its own pointer so
// they work simultaneously with the stick and each other. (story-001 AC 3, 4; story-003 UX review #1, #2)
// Event -> action mapping only; layout and visuals belong to ui-programmer (index.html / overlays.css).

/**
 * Pointer-down/up binding with per-element pointer capture.
 * @param {HTMLElement} el @param {(e: PointerEvent) => void} onDown @param {() => void} onUp
 */
function bindPointer(el, onDown, onUp) {
  let activeId = -1;
  el.addEventListener('pointerdown', (e) => {
    if (activeId !== -1) return;
    e.preventDefault();
    activeId = e.pointerId;
    el.setPointerCapture(e.pointerId);
    el.classList.add('down');
    onDown(e);
  });
  const up = (e) => {
    if (e.pointerId !== activeId) return;
    activeId = -1;
    el.classList.remove('down');
    onUp();
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
}

const noop = () => {};

/**
 * Dedicated Throw button. Fires InputState.pressThrow() on pointer-down.
 * `#btn-throw` (label key `throw`) lives in index.html, laid out per
 * production/ux/touch-ux-review-2026-11-04.md change 1/3; main.js passes it as the 5th
 * argument of attachTouchButtons.
 * @param {HTMLElement} throwEl
 * @param {import('./input-snapshot.js').InputState} input
 */
export function attachThrowButton(throwEl, input) {
  bindPointer(throwEl, () => input.pressThrow(), noop);
}

/**
 * @param {HTMLElement} lightEl @param {HTMLElement} heavyEl @param {HTMLElement} guardEl
 * @param {import('./input-snapshot.js').InputState} input
 * @param {HTMLElement | null} [throwEl] optional dedicated Throw button
 */
export function attachTouchButtons(lightEl, heavyEl, guardEl, input, throwEl = null) {
  // Touch Light/Heavy fire immediately (no chord wait); see the InputConfig touchThrowChord flag.
  bindPointer(lightEl, () => input.pressTouch('light', performance.now()), noop);
  bindPointer(heavyEl, () => input.pressTouch('heavy', performance.now()), noop);
  bindPointer(guardEl, () => input.setGuard(true), () => input.setGuard(false));
  if (throwEl) attachThrowButton(throwEl, input);
}
