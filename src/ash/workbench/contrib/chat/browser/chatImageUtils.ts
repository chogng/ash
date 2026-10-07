import { localize } from '../../../../nls.js';
import type { ChatContextAttachment } from '../../../services/chat/common/chatContextService.js';

/** Prepares all image inputs consistently before they become persistent draft entries. */
export async function createImageAttachment(name: string, data: Uint8Array, mimeType: string): Promise<ChatContextAttachment> {
	// These are renderer memory/transport bounds, not a model-specific image policy.
	if (data.byteLength > 20 * 1024 * 1024) {
		throw new Error(localize('chat.image.tooLarge', '{0} exceeds the 20 MB image limit', name));
	}
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: mimeType }));
	} catch {
		throw new Error(localize('chat.image.invalid', '{0} could not be decoded as an image', name));
	}
	let bytes = data;
	try {
		const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
		if (scale < 1 || data.byteLength > 1024 * 1024) {
			const canvas = document.createElement('canvas');
			canvas.width = Math.max(1, Math.round(bitmap.width * scale));
			canvas.height = Math.max(1, Math.round(bitmap.height * scale));
			const context = canvas.getContext('2d');
			if (!context) {
				throw new Error(localize('chat.image.unavailable', 'Image processing is unavailable'));
			}
			context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			// PNG keeps transparent screenshots and diagrams intact; JPEG inputs retain their compact encoding.
			const outputType = mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
			const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, outputType, 0.85));
			if (!blob) {
				throw new Error(localize('chat.image.unavailable', 'Image processing is unavailable'));
			}
			bytes = new Uint8Array(await blob.arrayBuffer());
			mimeType = outputType;
		}
	} finally {
		bitmap.close();
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
