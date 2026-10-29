import { SCREENSHOT_MAX_BYTES, SCREENSHOT_MAX_PIXELS } from '../../native/common/native.js';
import { isRecord } from '../../../base/common/types.js';
import { validateJsonValue, type JsonValue } from '../../../base/common/jsonValue.js';

export const IMAGE_VIEW_OPEN_CHANNEL = 'ash:image-view:open';
export const IMAGE_VIEW_CANCEL_CHANNEL = 'ash:image-view:cancel';
export const IMAGE_VIEW_INITIALIZE_CHANNEL = 'ash:image-view:initialize';
export const IMAGE_VIEW_COMPLETE_CHANNEL = 'ash:image-view:complete';
export const IMAGE_VIEW_READY_CHANNEL = 'ash:image-view:ready';
export const IMAGE_VIEW_PERMISSION_CHANNEL = 'ash:image-view:permission';

/** Native presentation carries opaque client data, never editor models or feature settings. */
export interface ImageViewRequest {
	readonly id: string;
	readonly title: string;
	readonly source: 'screen' | 'content';
	readonly html: string;
	readonly input: Readonly<Record<string, JsonValue>>;
}

export interface ImageViewInitialization {
	readonly image: Uint8Array;
	/** Host-owned metadata for a consent guide, instead of screen pixels. */
	readonly permission?: { readonly applicationName: string; readonly icon: Uint8Array };
	readonly presentation: ImageViewRequest;
	readonly locale: string;
	readonly bundles: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export type ImageViewPermissionAction = 'settings' | 'drag' | 'copyPath' | 'retry' | 'cancel';

export function validateImageViewPermissionAction(value: unknown): ImageViewPermissionAction {
	if (typeof value !== 'string' || !['settings', 'drag', 'copyPath', 'retry', 'cancel'].includes(value)) {
		throw new TypeError('Invalid screen permission action');
	}
	return value as ImageViewPermissionAction;
}

export type ImageViewCompletion =
	| { readonly kind: 'cancel' | 'retake' }
	| { readonly kind: 'error'; readonly message: string }
	| { readonly kind: 'attach' | 'copy' | 'save'; readonly image: Uint8Array };

export function validateImageViewId(value: unknown): string {
	if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/u.test(value))
		throw new TypeError('Invalid image view request ID');
	return value;
}

export function validateImageViewRequest(value: unknown): ImageViewRequest {
	if (
		!isRecord(value) ||
		Object.keys(value).sort().join(',') !== 'html,id,input,source,title' ||
		typeof value.title !== 'string' ||
		value.title.length > 1024 ||
		!['screen', 'content'].includes(value.source as string) ||
		typeof value.html !== 'string' ||
		value.html.length > 8 * 1024 * 1024 ||
		!isRecord(value.input)
	) {
		throw new TypeError('Invalid image view request');
	}
	validateImageViewId(value.id);
	validateJsonValue(value.input, {
		maxDepth: 32,
		maxNodes: 1_000_000,
		maxCollectionSize: 65536,
		maxStringLength: 256 * 1024,
	});
	if (JSON.stringify(value.input).length > 8 * 1024 * 1024) throw new RangeError('Image view input is too large');
	return value as unknown as ImageViewRequest;
}

/** Check the PNG header before a host decoder can allocate the uncompressed image. */
export function validateImageViewImage(value: unknown): Uint8Array {
	if (
		!(value instanceof Uint8Array) ||
		value.byteLength < 33 ||
		value.byteLength > SCREENSHOT_MAX_BYTES ||
		![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => value[index] === byte) ||
		new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(8) !== 13 ||
		String.fromCharCode(...value.subarray(12, 16)) !== 'IHDR'
	)
		throw new TypeError('Invalid image PNG');
	const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
	const width = view.getUint32(16);
	const height = view.getUint32(20);
	if (!width || !height || width * height > SCREENSHOT_MAX_PIXELS)
		throw new RangeError('ImageView image is too large');
	return value;
}

export function validateImageViewCompletion(value: unknown): ImageViewCompletion {
	if (!isRecord(value)) throw new TypeError('Invalid image view completion');
	if (
		value.kind === 'error' &&
		Object.keys(value).sort().join(',') === 'kind,message' &&
		typeof value.message === 'string' &&
		value.message.length > 0 &&
		value.message.length <= 4096
	)
		return value as unknown as ImageViewCompletion;
	if ((value.kind === 'cancel' || value.kind === 'retake') && Object.keys(value).length === 1)
		return value as ImageViewCompletion;
	if (
		!['attach', 'copy', 'save'].includes(value.kind as string) ||
		Object.keys(value).sort().join(',') !== 'image,kind'
	)
		throw new TypeError('Invalid image view completion');
	validateImageViewImage(value.image);
	return value as unknown as ImageViewCompletion;
}

export function validateImageViewInitialization(value: unknown): ImageViewInitialization {
	if (
		!isRecord(value) ||
		!['bundles,image,locale,presentation', 'bundles,image,locale,permission,presentation'].includes(
			Object.keys(value).sort().join(','),
		)
	) {
		throw new TypeError('Invalid image view initialization');
	}
	const presentation = validateImageViewRequest(value.presentation);
	if (value.permission !== undefined) {
		if (
			presentation.source !== 'screen' ||
			!isRecord(value.permission) ||
			Object.keys(value.permission).sort().join(',') !== 'applicationName,icon' ||
			typeof value.permission.applicationName !== 'string' ||
			!value.permission.applicationName.length ||
			value.permission.applicationName.length > 1024 ||
			!(value.image instanceof Uint8Array) ||
			value.image.length !== 0
		)
			throw new TypeError('Invalid screen permission initialization');
		validateImageViewImage(value.permission.icon);
	} else if (presentation.source === 'screen') validateImageViewImage(value.image);
	else if (!(value.image instanceof Uint8Array) || value.image.length !== 0)
		throw new TypeError('Content views cannot include screen pixels');
	validateLocalization(value);
	return value as unknown as ImageViewInitialization;
}

function validateLocalization(value: Record<string, unknown>): void {
	if (typeof value.locale !== 'string' || !/^[a-zA-Z0-9-]{1,40}$/u.test(value.locale) || !isRecord(value.bundles)) {
		throw new TypeError('Invalid image view localization');
	}
	for (const bundle of Object.values(value.bundles)) {
		if (
			!isRecord(bundle) ||
			Object.values(bundle).some(message => typeof message !== 'string' || message.length > 100_000)
		)
			throw new TypeError('Invalid image view localization');
	}
}
