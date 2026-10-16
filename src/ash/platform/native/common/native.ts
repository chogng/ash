import type { VSBuffer } from '../../../base/common/buffer.js';
import type { IRectangle } from '../../window/common/window.js';

/** Window-scoped platform operations shared by the desktop host adapters. */
export interface ICommonNativeHostService {
	/** Captures PNG bytes. Rectangle coordinates use renderer CSS pixels. */
	getScreenshot(rect?: IRectangle): Promise<VSBuffer | undefined>;
}
