import { getMediaMime } from '../../../../base/common/mime.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import type { URI } from '../../../../base/common/uri.js';

// Preserve the existing editor association when moving registration into Workbench.
export const IMAGE_PREVIEW_EDITOR_ID = 'ash.imagePreview';
export const AUDIO_PREVIEW_EDITOR_ID = 'ash.audioPreview';
export const VIDEO_PREVIEW_EDITOR_ID = 'ash.videoPreview';

export const IMAGE_PREVIEW_MAX_BYTES = 16 * 1024 * 1024;
export const IMAGE_PREVIEW_MAX_PIXELS = 12 * 1024 * 1024;
export const PLAYBACK_PREVIEW_MAX_BYTES = 32 * 1024 * 1024;

export const ImagePreviewConfiguration = {
	showImageInfo: 'mediaPreview.image.showImageInfo',
	defaultZoom: 'mediaPreview.image.defaultZoom',
	fitToWindowPercentage: 'mediaPreview.image.fitToWindowPercentage',
} as const;

const imageFormatNames = new Map([
	['image/png', 'PNG'], ['image/jpeg', 'JPEG'], ['image/gif', 'GIF'], ['image/bmp', 'BMP'],
	['image/webp', 'WebP'], ['image/avif', 'AVIF'], ['image/svg+xml', 'SVG'], ['image/x-icon', 'ICO'],
]);

export const imagePreviewFormats = [...imageFormatNames.values()].join(', ');

export function imagePreviewFormatName(mime: string): string {
	return imageFormatNames.get(mime) ?? mime;
}

/** Explicit MIME types take precedence over filenames, including revision-backed resources. */
export function getImageResourceMime(input: IResourceEditorInput): string | undefined {
	const type = input.contentType?.split(';', 1)[0].trim().toLowerCase();
	const mimeType = type && type !== 'application/octet-stream' ? type : getMediaMime(input.resource.path);
	if (mimeType === 'image/vnd.microsoft.icon') return 'image/x-icon';
	return mimeType && imageFormatNames.has(mimeType) ? mimeType : undefined;
}

export function isImageResource(input: IResourceEditorInput): boolean {
	return getImageResourceMime(input) !== undefined;
}

/** Identify recognizable signatures. The browser validates the complete image. */
export function getImageSignatureMime(bytes: Uint8Array): string | undefined {
	const header = String.fromCharCode(...bytes.subarray(0, 16));
	if (header.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png';
	if (header.startsWith('\xff\xd8\xff')) return 'image/jpeg';
	if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif';
	if (header.startsWith('BM')) return 'image/bmp';
	if (header.startsWith('\0\0\x01\0')) return 'image/x-icon';
	if (header.startsWith('RIFF') && header.startsWith('WEBP', 8)) return 'image/webp';
	if (header.length >= 16 && header.startsWith('ftyp', 4)) {
		const isAvifBrand = (brand: string) => brand === 'avif' || brand === 'avis';
		if (isAvifBrand(header.slice(8, 12))) return 'image/avif';
		const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
		for (let offset = 16; offset + 4 <= Math.min(boxSize, bytes.byteLength, 4096); offset += 4) {
			if (isAvifBrand(String.fromCharCode(...bytes.subarray(offset, offset + 4)))) return 'image/avif';
		}
	}
	const xml = new TextDecoder().decode(bytes.subarray(0, 4096));
	return /^\s*(?:<\?xml[^?]*\?>\s*)?<svg(?:[\s/>])/u.test(xml) ? 'image/svg+xml' : undefined;
}

/** Git revisions may contain an LFS pointer instead of the checked-out media bytes. */
export function isGitLfsPointer(resource: URI, bytes: Uint8Array): boolean {
	return resource.scheme === 'git' && bytes.length <= 1024 &&
		/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/.test(new TextDecoder().decode(bytes));
}
