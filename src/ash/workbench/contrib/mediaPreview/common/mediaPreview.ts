import { getMediaMime } from '../../../../base/common/mime.js';
import type { IResourceEditorInput } from '../../../common/editor.js';

// Preserve the existing editor association when moving registration into Workbench.
export const IMAGE_PREVIEW_EDITOR_ID = 'ash.imagePreview';

export const ImagePreviewConfiguration = {
	showImageInfo: 'mediaPreview.image.showImageInfo',
	defaultZoom: 'mediaPreview.image.defaultZoom',
	fitToWindowPercentage: 'mediaPreview.image.fitToWindowPercentage',
} as const;

/** Explicit MIME types take precedence over filenames, including revision-backed resources. */
export function isImageResource(input: IResourceEditorInput): boolean {
	const type = input.contentType?.split(';', 1)[0].trim().toLowerCase();
	return /^(image\/(png|jpeg|gif|bmp|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon))$/.test(
		type && type !== 'application/octet-stream' ? type : getMediaMime(input.resource.path) ?? '',
	);
}
