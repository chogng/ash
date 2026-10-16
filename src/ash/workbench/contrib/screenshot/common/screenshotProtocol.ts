import type { ScreenshotPermission } from './screenshot.js';
import { SCREENSHOT_MAX_BYTES, SCREENSHOT_MAX_PIXELS } from '../../../../platform/native/common/native.js';
import { isRecord } from '../../../../base/common/types.js';

export const SCREENSHOT_SHORTCUT_CHANNEL = 'ash:screenshot:shortcut';
export const SCREENSHOT_TRIGGER_CHANNEL = 'ash:screenshot:trigger';

export const SCREENSHOT_PERMISSION_CHANNEL = 'ash:screenshot:permission';

export const SCREENSHOT_CAPTURE_CHANNEL = 'ash:screenshot:capture';
export const SCREENSHOT_CANCEL_CHANNEL = 'ash:screenshot:cancel';
export const SCREENSHOT_INITIALIZE_CHANNEL = 'ash:screenshot:initialize';
export const SCREENSHOT_COMPLETE_CHANNEL = 'ash:screenshot:complete';
export const SCREENSHOT_READY_CHANNEL = 'ash:screenshot:ready';

/** Manual screen capture is separate from the sender-bound window capture API. */
export interface ScreenshotRequest {
	readonly id: string;
	readonly styles: Readonly<Record<string, string>>;
	readonly colorScheme: 'light' | 'dark' | 'hcDark' | 'hcLight';
	readonly accessibilityHints: boolean;
}

export interface ScreenshotInitialization {
	readonly image: Uint8Array;
	readonly presentation: ScreenshotRequest;
	readonly locale: string;
	readonly bundles: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export type ScreenshotCompletion =
	{ readonly kind: 'cancel' | 'retake'; } | { readonly kind: 'attach' | 'copy' | 'save'; readonly image: Uint8Array; };

export function validateScreenshotId(value: unknown): string {
	if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/u.test(value))
		throw new TypeError('Invalid screenshot request ID');
	return value;
}

export function validateScreenshotRequest(value: unknown): ScreenshotRequest {
	if (
		!isRecord(value) ||
		Object.keys(value).sort().join(',') !== 'accessibilityHints,colorScheme,id,styles' ||
		!['light', 'dark', 'hcDark', 'hcLight'].includes(value.colorScheme as string) ||
		typeof value.accessibilityHints !== 'boolean' ||
		!isRecord(value.styles) ||
		Object.keys(value.styles).length > 100
	)
		throw new TypeError('Invalid screenshot request');
	validateScreenshotId(value.id);
	for (const [key, entry] of Object.entries(value.styles)) {
		if (
			!/^--ash-[a-zA-Z0-9-]+$/u.test(key) ||
			typeof entry !== 'string' ||
			entry.length > 256 ||
			/[;{}]|url\s*\(/iu.test(entry)
		)
			throw new TypeError('Invalid screenshot appearance');
	}
	return value as unknown as ScreenshotRequest;
}

/** Check the PNG header before a host decoder can allocate the uncompressed image. */
export function validateScreenshotImage(value: unknown): Uint8Array {
	if (
		!(value instanceof Uint8Array) ||
		value.byteLength < 33 ||
		value.byteLength > SCREENSHOT_MAX_BYTES ||
		![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => value[index] === byte) ||
		new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(8) !== 13 ||
		String.fromCharCode(...value.subarray(12, 16)) !== 'IHDR'
	)
		throw new TypeError('Invalid screenshot PNG');
	const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
	const width = view.getUint32(16);
	const height = view.getUint32(20);
	if (!width || !height || width * height > SCREENSHOT_MAX_PIXELS)
		throw new RangeError('Screenshot image is too large');
	return value;
}

export function validateScreenshotCompletion(value: unknown): ScreenshotCompletion {
	if (!isRecord(value)) throw new TypeError('Invalid screenshot completion');
	if ((value.kind === 'cancel' || value.kind === 'retake') && Object.keys(value).length === 1)
		return value as ScreenshotCompletion;
	if (
		!['attach', 'copy', 'save'].includes(value.kind as string) ||
		Object.keys(value).sort().join(',') !== 'image,kind'
	)
		throw new TypeError('Invalid screenshot completion');
	validateScreenshotImage(value.image);
	return value as unknown as ScreenshotCompletion;
}

export function validateScreenshotInitialization(value: unknown): ScreenshotInitialization {
	if (
		!isRecord(value) ||
		Object.keys(value).sort().join(',') !== 'bundles,image,locale,presentation' ||
		typeof value.locale !== 'string' ||
		!/^[a-zA-Z0-9-]{1,40}$/u.test(value.locale) ||
		!isRecord(value.bundles)
	)
		throw new TypeError('Invalid screenshot initialization');
	validateScreenshotImage(value.image);
	validateScreenshotRequest(value.presentation);
	for (const bundle of Object.values(value.bundles)) {
		if (
			!isRecord(bundle) ||
			Object.values(bundle).some((message) => typeof message !== 'string' || message.length > 100_000)
		)
			throw new TypeError('Invalid screenshot localization');
	}
	return value as unknown as ScreenshotInitialization;
}

export function validateScreenshotPermissionAction(value: unknown): 'status' | 'open-settings' | 'reveal-application' {
	if (value !== 'status' && value !== 'open-settings' && value !== 'reveal-application')
		throw new TypeError('Invalid screenshot permission action');
	return value;
}

export function validateScreenshotPermission(value: unknown): ScreenshotPermission {
	if (
		!isRecord(value) ||
		Object.keys(value).sort().join(',') !== 'applicationPath,canOpenSystemSettings,status' ||
		!['not-determined', 'granted', 'denied', 'restricted', 'unknown', 'browser'].includes(value.status as string) ||
		typeof value.canOpenSystemSettings !== 'boolean' ||
		typeof value.applicationPath !== 'string' ||
		value.applicationPath.length > 8192 ||
		(value.canOpenSystemSettings && !value.applicationPath.startsWith('/'))
	)
		throw new TypeError('Invalid screenshot permission status');
	return value as unknown as ScreenshotPermission;
}

export interface ScreenshotShortcutRequest {
	readonly accelerator: string;
	readonly label: string;
	readonly global: boolean;
}

export function validateScreenshotShortcutRequest(value: unknown): ScreenshotShortcutRequest {
	if (
		!isRecord(value) ||
		Object.keys(value).sort().join(',') !== 'accelerator,global,label' ||
		typeof value.global !== 'boolean' ||
		typeof value.label !== 'string' ||
		value.label.length > 256 ||
		typeof value.accelerator !== 'string' ||
		value.accelerator.length > 128 ||
		(value.accelerator !== '' &&
			!/^(?:(?:Command|Control|Alt|Shift)\+)*(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Down|Left|Right|Up|Backspace|Delete|End|Enter|Escape|Home|PageDown|PageUp|Tab)$/u.test(
				value.accelerator
			))
	)
		throw new TypeError('Invalid screenshot shortcut');
	return value as unknown as ScreenshotShortcutRequest;
}

export function validateScreenshotShortcutResult(value: unknown): {
	readonly available: boolean;
	readonly activeLabel: string;
} {
	if (
		!isRecord(value) ||
		Object.keys(value).sort().join(',') !== 'activeLabel,available' ||
		typeof value.available !== 'boolean' ||
		typeof value.activeLabel !== 'string' ||
		value.activeLabel.length > 256
	)
		throw new TypeError('Invalid screenshot shortcut result');
	return value as unknown as { readonly available: boolean; readonly activeLabel: string; };
}
