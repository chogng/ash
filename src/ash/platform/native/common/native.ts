import type { VSBuffer } from '../../../base/common/buffer.js';
import type { IRectangle } from '../../window/common/window.js';

/** Window-scoped platform operations shared by the desktop host adapters. */
export interface ICommonNativeHostService {
	/** Captures PNG bytes. Rectangle coordinates use renderer CSS pixels. */
	getScreenshot(rect?: IRectangle): Promise<VSBuffer | undefined>;
}

/** Raw desktop frames, captured before the workbench opens any selection windows. */
export interface DesktopScreenshot {
	readonly displayId: number;
	readonly bounds: IRectangle;
	readonly image: VSBuffer;
}

export const SCREENSHOT_MAX_BYTES = 20 * 1024 * 1024;
export const SCREENSHOT_MAX_PIXELS = 67_108_864;
