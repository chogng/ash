import type { VSBuffer } from '../../../base/common/buffer.js';
import type { IRectangle } from '../../window/common/window.js';
import type { CancellationToken } from '../../../base/common/cancellation.js';

/** Window-scoped platform operations shared by the desktop host adapters. */
export interface ICommonNativeHostService {
	/** Captures this host's window as PNG, independent of desktop focus. Rectangle coordinates use renderer CSS pixels. */
	getScreenshot(rect?: IRectangle): Promise<VSBuffer | undefined>;
	showToast(options: IToastOptions, token: CancellationToken): Promise<IToastResult>;
}

export const SHOW_TOAST_CHANNEL = 'ash:host:showToast';
export const CANCEL_TOAST_CHANNEL = 'ash:host:cancelToast';
export const REQUEST_MICROPHONE_ACCESS_CHANNEL = 'ash:host:requestMicrophoneAccess';

export interface IToastOptions {
	readonly id: string;
	readonly title: string;
	readonly body?: string;
	readonly dedupeKey?: string;
	readonly onlyWhenUnfocused?: boolean;
}

export interface IToastResult {
	readonly supported: boolean;
	readonly clicked: boolean;
	readonly suppressed?: boolean;
}

/** Raw desktop frames, captured before the image-view host opens any selection windows. */
export interface DesktopScreenshot {
	readonly displayId: number;
	readonly bounds: IRectangle;
	readonly image: VSBuffer;
}

export const SCREENSHOT_MAX_BYTES = 20 * 1024 * 1024;
export const SCREENSHOT_MAX_PIXELS = 67_108_864;

export const APPLICATION_BADGE_CHANNEL = 'ash:native:applicationBadge';

export interface IApplicationBadge {
	readonly count: number;
	readonly description: string;
	readonly iconDataURL?: string;
}
