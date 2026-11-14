import { decodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import type { CodeImageSnapshot } from '../../../services/imageEditor/common/imageEditorService.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

export interface IScreenshotToolOptions {
	readonly image?: VSBuffer;
	readonly code?: CodeImageSnapshot;
	readonly defaultAction?: 'attach' | 'copy';
}

/** Owns Ash's frozen-desktop selection and annotation workflow; hosts only present its view. */
export interface IScreenshotToolService {
	readonly isSupported: boolean;
	readonly accessibilityHelp: string;
	captureAndEdit(signal: AbortSignal, options?: IScreenshotToolOptions): Promise<VSBuffer | undefined>;
	show(options: IScreenshotToolOptions, signal: AbortSignal): Promise<void>;
}
export const IScreenshotToolService = createServiceIdentifier<IScreenshotToolService>('screenshotToolService');

/** Screenshot pixels and intrinsic dimensions, independent of their native acquisition source. */
export interface IScreenshotToolImage {
	readonly dataUrl: string;
	readonly width: number;
	readonly height: number;
}

export function getScreenshotToolImageData(image: IScreenshotToolImage): { readonly data: VSBuffer; readonly mimeType: string; } {
	const separator = image.dataUrl.indexOf(',');
	return {
		data: decodeBase64(image.dataUrl.slice(separator + 1)),
		mimeType: image.dataUrl.slice(5, image.dataUrl.indexOf(';')),
	};
}

/** Product operations shared by the local editor and the native screenshot adapter. */
export type ScreenshotToolCompletion =
	{ readonly kind: 'cancel' | 'retake'; } | { readonly kind: 'error'; readonly message: string; }
	| { readonly kind: 'copy' | 'save' | 'attach' | 'pin'; readonly image: Uint8Array; };
