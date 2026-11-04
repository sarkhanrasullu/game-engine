// Test fixture (not shipped): the engine with fixture defaults bound in, mirroring a consumer's
// default-bound re-export layer so the copied unit tests run against frozen tuning data.
export {
  createSnapshot,
} from '../../../src/input/index.js';
import * as E from '../../../src/input/index.js';
import { INPUT_CONFIG, KEY_BINDINGS } from './input-config.js';

export { KEY_BINDINGS };
export class DoubleTapDetector extends E.DoubleTapDetector {
  constructor(
    windowMs = INPUT_CONFIG.doubleTapWindowMs,
    threshold = INPUT_CONFIG.stickTapThreshold,
    releaseThreshold = INPUT_CONFIG.stickTapReleaseThreshold,
  ) {
    super(windowMs, threshold, releaseThreshold);
  }
}
export class InputState extends E.InputState {
  constructor(config = INPUT_CONFIG, bindings = KEY_BINDINGS) {
    super(config, bindings);
  }
}
