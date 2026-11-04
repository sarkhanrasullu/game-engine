// GPU capability probes (ADR-0001): can this device render to half-float colour attachments? The
// bloom composer needs a HalfFloatType render target (WebGL2 EXT_color_buffer_float, or the older
// EXT_color_buffer_half_float); without one the high tier is removed for the session.

/**
 * Probe half-float render-target support on a throwaway WebGL2 context (released at once).
 * Returns false when WebGL2 or both extensions are missing, or when the probe throws.
 * @param {Document} [doc]
 * @returns {boolean}
 * @example if (!supportsHalfFloatTargets()) console.info('bloom tier disabled');
 */
export function supportsHalfFloatTargets(doc = typeof document === 'undefined' ? null : document) {
  if (!doc) return false;
  try {
    const gl = doc.createElement('canvas').getContext('webgl2');
    if (!gl) return false;
    const ok = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return ok;
  } catch {
    return false;
  }
}
