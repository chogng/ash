import './media/chatImagePreview.css';
import { addDisposableListener, h } from '../../base/browser/dom.js';
import { createObjectUrl } from '../../base/browser/fileAccess.js';
import { timeout } from '../../base/common/async.js';
import { DisposableStore, type IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { LRUCache } from '../../base/common/map.js';
import { getMediaMime } from '../../base/common/mime.js';
import type { URI } from '../../base/common/uri.js';
import { localize } from '../../nls.js';

const maxThumbnailDimension = 768;
const thumbnailTimeoutMs = 10_000;
const thumbnailCache = new LRUCache<string, Promise<Blob | undefined>>(50);

interface ChatImageHoverOptions {
	readonly ownerDocument?: Document;
	readonly mimeType?: string;
	/** The attachment owns the loaded image and its URL throughout the hover. */
	readonly loadedImage?: HTMLImageElement;
	/** Preserve the dimensions reported by the accessible view for a captured image. */
	readonly preserveOriginal?: boolean;
}

/** Renders a local image preview with a lifetime bounded by its owning hover. */
export function createChatImageHoverContent(
	resource: URI | undefined,
	fullName: string,
	buffer: ArrayBuffer | Uint8Array | Blob | (() => Blob),
	cacheKey: string,
	onContentsChanged?: () => void,
	clickHandler?: () => void,
	onImageUrl?: (url: string, isThumbnail: boolean, image: HTMLImageElement) => void,
	imageAlt = '',
	showImageInHover = true,
	onImageError?: () => void,
	options?: ChatImageHoverOptions,
): { readonly element: HTMLElement; readonly disposable: IDisposable; } {
	const document = options?.ownerDocument ?? globalThis.document;
	const ownerWindow = document.defaultView!;
	const resources = new DisposableStore();
	const element = h(document, 'div', { className: 'ash-chat-image-hover' });
	const image = h(document, 'img');
	image.alt = imageAlt;
	image.draggable = false;
	let imageControl: HTMLElement = image;
	if (showImageInHover && clickHandler) {
		const button = h(document, 'button', { className: 'ash-chat-image-hover-open' });
		button.type = 'button';
		button.setAttribute('aria-label', localize('chat.openImagePreview', 'Open in Images Preview'));
		button.append(image);
		resources.add(addDisposableListener(button, 'click', clickHandler));
		imageControl = button;
	}
	if (showImageInHover) {
		imageControl.hidden = true;
		element.append(imageControl);
	}
	if (resource) {
		element.append(h(document, 'div', { className: 'ash-chat-image-hover-caption' }, fullName));
	}

	resources.add(addDisposableListener(image, 'load', () => {
		imageControl.hidden = false;
		onContentsChanged?.();
	}));
	resources.add(addDisposableListener(image, 'error', () => {
		imageControl.remove();
		onImageError?.();
	}));
	resources.add(toDisposable(() => {
		element.remove();
		image.removeAttribute('src');
	}));
	const loadedImage = options?.loadedImage;
	if (loadedImage?.naturalWidth && Math.max(loadedImage.naturalWidth, loadedImage.naturalHeight) <= maxThumbnailDimension) {
		image.src = loadedImage.currentSrc || loadedImage.src;
		onImageUrl?.(image.src, false, image);
		return { element, disposable: resources };
	}

	const data = typeof buffer === 'function' ? buffer() : buffer;
	const source = 'size' in data ? data : new Blob([
		ArrayBuffer.isView(data) ? new Uint8Array(data) : data,
	], { type: options?.mimeType ?? getMediaMime(resource?.path ?? fullName) });
	const thumbnail = options?.preserveOriginal || source.type === 'image/gif'
		? Promise.resolve(undefined)
		: getThumbnail(document, source, cacheKey);
	void thumbnail.then(result => {
		if (resources.isDisposed) return;
		const { url, registration } = createObjectUrl(ownerWindow, result ?? source);
		resources.add(registration);
		image.src = url.href;
		onImageUrl?.(url.href, result !== undefined, image);
	});
	return { element, disposable: resources };
}

function getThumbnail(document: Document, source: Blob, cacheKey: string): Promise<Blob | undefined> {
	const key = JSON.stringify([cacheKey, source.size, source.type]);
	const cached = thumbnailCache.get(key);
	if (cached) return cached;

	const deadline = timeout(thumbnailTimeoutMs);
	const thumbnail = Promise.race([
		renderThumbnail(document, source).catch(() => undefined),
		deadline.then(() => undefined),
	]).finally(() => deadline.cancel());
	thumbnailCache.set(key, thumbnail);
	void thumbnail.then(result => {
		// Small or undecodable images have no derived data to retain.
		if (!result && thumbnailCache.peek(key) === thumbnail) thumbnailCache.delete(key);
	});
	return thumbnail;
}

async function renderThumbnail(document: Document, source: Blob): Promise<Blob | undefined> {
	const bitmap = await document.defaultView!.createImageBitmap(source);
	try {
		const scale = maxThumbnailDimension / Math.max(bitmap.width, bitmap.height);
		if (scale >= 1) return undefined;
		const canvas = h(document, 'canvas');
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		const context = canvas.getContext('2d');
		if (!context) return undefined;
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		return new Promise(resolve => canvas.toBlob(blob => resolve(blob ?? undefined), 'image/webp', 1));
	} finally {
		bitmap.close();
	}
}
