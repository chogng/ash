import { getMediaMime } from '../../../../base/common/mime.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import type { URI } from '../../../../base/common/uri.js';

// Preserve the existing editor association when moving registration into Workbench.
export const IMAGE_PREVIEW_EDITOR_ID = 'ash.imagePreview';
export const AUDIO_PREVIEW_EDITOR_ID = 'ash.audioPreview';
export const VIDEO_PREVIEW_EDITOR_ID = 'ash.videoPreview';

export const ImagePreviewConfiguration = {
	showImageInfo: 'mediaPreview.image.showImageInfo',
	defaultZoom: 'mediaPreview.image.defaultZoom',
	fitToWindowPercentage: 'mediaPreview.image.fitToWindowPercentage',
} as const;

/** Explicit MIME types take precedence over filenames, including revision-backed resources. */
export function getImageResourceMime(input: IResourceEditorInput): string | undefined {
	const type = input.contentType?.split(';', 1)[0].trim().toLowerCase();
	const mimeType = type && type !== 'application/octet-stream' ? type : getMediaMime(input.resource.path);
	return mimeType && /^(image\/(png|jpeg|gif|bmp|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon))$/.test(mimeType) ? mimeType : undefined;
}

export function isImageResource(input: IResourceEditorInput): boolean {
	return getImageResourceMime(input) !== undefined;
}

/** Git revisions may contain an LFS pointer instead of the checked-out media bytes. */
export function isGitLfsPointer(resource: URI, bytes: Uint8Array): boolean {
	return resource.scheme === 'git' && bytes.length <= 1024 &&
		/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/.test(new TextDecoder().decode(bytes));
}
