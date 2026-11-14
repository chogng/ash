import { isRecord } from '../../../base/common/types.js';
import { validateJsonValue, type JsonValue } from '../../../base/common/jsonValue.js';
import { validatePngImage } from '../../imageResize/common/imageData.js';
import type { IRectangle } from '../../window/common/window.js';

export const SCREENSHOT_OPEN_CHANNEL = 'ash:screenshot:open';
export const SCREENSHOT_CANCEL_CHANNEL = 'ash:screenshot:cancel';
export const SCREENSHOT_INITIALIZE_CHANNEL = 'ash:screenshot:initialize';
export const SCREENSHOT_COMPLETE_CHANNEL = 'ash:screenshot:complete';
export const SCREENSHOT_READY_CHANNEL = 'ash:screenshot:ready';
export const SCREENSHOT_ATTACH_CHANNEL = 'ash:screenshot:attach';
export const SCREENSHOT_PIN_CHANNEL = 'ash:screenshot:pin';

/** Native desktop overlays have one bundled presentation and never accept provider HTML. */
export interface ScreenshotWindowRequest {
	readonly id: string;
	readonly input: Readonly<Record<string, JsonValue>>;
}
export interface ScreenshotPinRequest {
	readonly image: Uint8Array;
	readonly input: Readonly<Record<string, JsonValue>>;
}
export interface ScreenshotInitialization extends ScreenshotPinRequest {
	readonly kind: 'capture' | 'pinned';
	readonly agentWindow: boolean;
	readonly locale: string;
	readonly bundles: Readonly<Record<string, Readonly<Record<string, string>>>>;
	/** Visible window rectangles in the frozen display image's pixels, frontmost first. */
	readonly windowBounds?: readonly IRectangle[];
}
export type ScreenshotCompletion =
	{ readonly kind: 'cancel' | 'retake'; } | { readonly kind: 'error'; readonly message: string; }
	| { readonly kind: 'attach' | 'copy' | 'save' | 'pin'; readonly image: Uint8Array; };

export function validateScreenshotId(value: unknown): string {
	if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/u.test(value)) { throw new TypeError('Invalid screenshot request ID'); }
	return value;
}
function validateInput(input: unknown): void {
	if (!isRecord(input) || Object.keys(input).some(key => !['defaultAction', 'colorScheme', 'accessibilityHints', 'theme', 'help'].includes(key))) { throw new TypeError('Invalid screenshot input'); }
	if ('defaultAction' in input && !['copy', 'attach'].includes(input.defaultAction as string)) { throw new TypeError('Invalid screenshot action'); }
	if ('colorScheme' in input && !['dark', 'light', 'hcDark', 'hcLight'].includes(input.colorScheme as string)) { throw new TypeError('Invalid screenshot appearance'); }
	if ('accessibilityHints' in input && typeof input.accessibilityHints !== 'boolean') { throw new TypeError('Invalid screenshot hints'); }
	if ('help' in input && (typeof input.help !== 'string' || input.help.length > 65536)) { throw new TypeError('Invalid screenshot help'); }
	if ('theme' in input && (!isRecord(input.theme) || !isRecord(input.theme.colors) || !isRecord(input.theme.metrics) || typeof input.theme.shadow !== 'string')) { throw new TypeError('Invalid screenshot theme'); }
	validateJsonValue(input, { maxDepth: 16, maxNodes: 100000, maxCollectionSize: 65536, maxStringLength: 256 * 1024 });
	if (JSON.stringify(input).length > 1024 * 1024) { throw new RangeError('Screenshot input is too large'); }
}
export function validateScreenshotRequest(value: unknown): ScreenshotWindowRequest {
	if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'id,input') { throw new TypeError('Invalid screenshot request'); }
	validateScreenshotId(value.id);
	validateInput(value.input);
	return value as unknown as ScreenshotWindowRequest;
}
export function validateScreenshotPinRequest(value: unknown): ScreenshotPinRequest {
	if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'image,input') { throw new TypeError('Invalid screenshot pin request'); }
	validatePngImage(value.image);
	validateInput(value.input);
	return value as unknown as ScreenshotPinRequest;
}
export function validateScreenshotCompletion(value: unknown): ScreenshotCompletion {
	if (!isRecord(value)) { throw new TypeError('Invalid screenshot completion'); }
	if ((value.kind === 'cancel' || value.kind === 'retake') && Object.keys(value).length === 1) { return value as ScreenshotCompletion; }
	if (value.kind === 'error' && Object.keys(value).sort().join(',') === 'kind,message' && typeof value.message === 'string' && value.message.length > 0 && value.message.length <= 4096) { return value as unknown as ScreenshotCompletion; }
	if (!['attach', 'copy', 'save', 'pin'].includes(value.kind as string) || Object.keys(value).sort().join(',') !== 'image,kind') { throw new TypeError('Invalid screenshot completion'); }
	validatePngImage(value.image);
	return value as unknown as ScreenshotCompletion;
}
export function validateScreenshotInitialization(value: unknown): ScreenshotInitialization {
	if (!isRecord(value) || Object.keys(value).some(key => !['agentWindow', 'bundles', 'image', 'input', 'kind', 'locale', 'windowBounds'].includes(key))
		|| typeof value.agentWindow !== 'boolean' || !['capture', 'pinned'].includes(value.kind as string) || typeof value.locale !== 'string' || !/^[a-zA-Z0-9-]{1,40}$/u.test(value.locale) || !isRecord(value.bundles)) { throw new TypeError('Invalid screenshot initialization'); }
	const image = validatePngImage(value.image);
	if ('windowBounds' in value) {
		const png = new DataView(image.buffer, image.byteOffset, image.byteLength);
		const width = png.getUint32(16);
		const height = png.getUint32(20);
		if (value.kind !== 'capture' || !Array.isArray(value.windowBounds) || value.windowBounds.length > 10_000
			|| !value.windowBounds.every(rect => isRecord(rect) && Object.keys(rect).sort().join(',') === 'height,width,x,y'
				&& typeof rect.x === 'number' && typeof rect.y === 'number' && typeof rect.width === 'number' && typeof rect.height === 'number'
				&& [rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger)
				&& rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0
				&& rect.x + rect.width <= width && rect.y + rect.height <= height)) {
			throw new TypeError('Invalid screenshot window bounds');
		}
	}
	validateInput(value.input);
	for (const bundle of Object.values(value.bundles)) {
		if (!isRecord(bundle) || Object.values(bundle).some(message => typeof message !== 'string' || message.length > 100000)) { throw new TypeError('Invalid screenshot localization'); }
	}
	return value as unknown as ScreenshotInitialization;
}
