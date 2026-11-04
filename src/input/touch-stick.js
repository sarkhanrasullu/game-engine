// Floating virtual stick: appears where the stick-zone touch lands. Pointer Events, multi-touch safe
// (tracks one pointerId). No game logic; writes into InputState. (story-001 AC 1, 4)
// story-003 (touch UX review #5, #6): the origin is clamped inside the
// safe area and the zone, so the ring never sits under a notch; the zone side follows handedness.
// The radial dead zone (#8) is applied in InputState.setStick.

/**
 * Pure: clamp a stick origin so the whole ring (radius r + margin) and a fully deflected knob
 * (r + knobR + margin) stay inside both the stick zone and the safe viewport. If the allowed span is
 * empty on an axis, uses its midpoint.
 * @param {number} x @param {number} y touch-down point (CSS px, viewport coords)
 * @param {{left:number,top:number,right:number,bottom:number}} zone zone rect (viewport coords)
 * @param {{top:number,right:number,bottom:number,left:number}} safe safe-area insets (px)
 * @param {{width:number,height:number}} viewport
 * @param {number} r stick radius px @param {number} margin px
 * @param {number} [knobR] knob radius px (0 = clamp the ring only)
 * @returns {{x:number,y:number}}
 */
export function clampStickOrigin(x, y, zone, safe, viewport, r, margin, knobR = 0) {
  const pad = r + knobR + margin;
  const clampAxis = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : v < lo ? lo : v > hi ? hi : v);
  const minX = Math.max(zone.left, safe.left) + pad;
  const maxX = Math.min(zone.right, viewport.width - safe.right) - pad;
  const minY = Math.max(zone.top, safe.top) + pad;
  const maxY = Math.min(zone.bottom, viewport.height - safe.bottom) - pad;
  return { x: clampAxis(x, minX, maxX), y: clampAxis(y, minY, maxY) };
}

/**
 * Pure: the stick zone rect for a handedness ('right' hand = stick on the left half).
 * ui-programmer's CSS (`#controls[data-hand="left"]`) must match this.
 * @param {'right'|'left'} side from stickZoneSide() @param {{width:number,height:number}} viewport
 */
export function stickZoneRect(side, viewport) {
  const half = viewport.width / 2;
  return side === 'right'
    ? { left: half, top: 0, right: viewport.width, bottom: viewport.height }
    : { left: 0, top: 0, right: half, bottom: viewport.height };
}

/**
 * Reads resolved safe-area insets via a probe element (custom properties holding env() may not be
 * resolved by getPropertyValue). Call once per resize. Unverified on device.
 * @returns {{top:number,right:number,bottom:number,left:number}}
 */
export function readSafeInsets(doc = document) {
  const probe = doc.createElement('div');
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;' +
    'padding:var(--safe-top,0px) var(--safe-right,0px) var(--safe-bottom,0px) var(--safe-left,0px)';
  doc.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const insets = {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
  };
  probe.remove();
  return insets;
}

/**
 * @param {HTMLElement} zone element receiving pointers (left or right half, per handedness CSS)
 * @param {HTMLElement} base ring element (moved to touch-down point)
 * @param {HTMLElement} knob knob element inside base
 * @param {import('./input-snapshot.js').InputState} input its config supplies stickRadiusPx,
 *   stickEdgeMarginPx and stickKnobRadiusPx
 * @param {number} [radius] stick travel radius px (default input.config.stickRadiusPx)
 * @example attachTouchStick(zoneEl, baseEl, knobEl, input);
 */
export function attachTouchStick(zone, base, knob, input, radius = input.config.stickRadiusPx) {
  let activeId = -1;
  let ox = 0;
  let oy = 0;
  let safe = null;
  window.addEventListener('resize', () => {
    safe = null;
  });

  const release = (e) => {
    if (e.pointerId !== activeId) return;
    activeId = -1;
    input.setStick(0, 0);
    base.style.display = 'none';
  };

  zone.addEventListener('pointerdown', (e) => {
    if (activeId !== -1) return;
    e.preventDefault();
    activeId = e.pointerId;
    zone.setPointerCapture(e.pointerId);
    if (safe === null) safe = readSafeInsets();
    // Zone rect read live, so a handedness swap (CSS moves the zone) needs no re-attach.
    const o = clampStickOrigin(
      e.clientX,
      e.clientY,
      zone.getBoundingClientRect(),
      safe,
      { width: window.innerWidth, height: window.innerHeight },
      radius,
      input.config.stickEdgeMarginPx,
      input.config.stickKnobRadiusPx,
    );
    ox = o.x;
    oy = o.y;
    base.style.display = 'block';
    base.style.transform = `translate(${ox - radius}px, ${oy - radius}px)`;
    knob.style.transform = 'translate(0px, 0px)';
    input.setStick(0, 0);
  });

  zone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== activeId) return;
    let dx = e.clientX - ox;
    let dy = e.clientY - oy;
    const len = Math.hypot(dx, dy);
    if (len > radius) {
      dx = (dx / len) * radius;
      dy = (dy / len) * radius;
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    input.setStick(dx / radius, -dy / radius);
  });

  zone.addEventListener('pointerup', release);
  zone.addEventListener('pointercancel', release);
  zone.addEventListener('lostpointercapture', release);
}
