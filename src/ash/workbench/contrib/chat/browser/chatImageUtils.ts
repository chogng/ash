import type { IImageResizeService } from '../../../../platform/imageResize/common/imageResizeService.js';
import { localize } from '../../../../nls.js';
import type { ChatContextAttachment } from '../../../services/chat/common/chatContextService.js';

/** Prepares all image inputs consistently before they become persistent draft entries. */
export async function createImageAttachment(name: string, data: Uint8Array, mimeType: string, images: IImageResizeService): Promise<ChatContextAttachment> {
	// These are renderer memory/transport bounds, not a model-specific image policy.
	if (data.byteLength > 20 * 1024 * 1024) {
		throw new Error(localize('chat.image.tooLarge', '{0} exceeds the 20 MB image limit', name));
	}
	let bytes: Uint8Array;
	try {
		bytes = await images.resizeImage(data, mimeType, { maxDimension: 2048 });
	} catch {
		throw new Error(localize('chat.image.invalid', '{0} could not be decoded as an image', name));
	}
	if (bytes !== data) {
		mimeType = mimeType === 'image/jpeg' || mimeType === 'image/jpg' ? 'image/jpeg' : 'image/png';
	}
	const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(data));
	const id = `image:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 8192) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
	}
	const content = `data:${mimeType};base64,${btoa(binary)}`;
	return { id, kind: 'image', name, resolve: async () => ({ name, content, kind: 'image' }) };
}
