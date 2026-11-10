import { getWindow } from '../../../../base/browser/dom.js';
import { createObjectUrl } from '../../../../base/browser/fileAccess.js';
import { localize } from '../../../../nls.js';
import { WebWorkerDescriptor } from '../../../../platform/webWorker/browser/webWorkerDescriptor.js';
import type { IWebWorkerService } from '../../../../platform/webWorker/browser/webWorkerService.js';
import type { ImageEncoderWorker } from './imageEncoderWorker.js';

export async function encodeImageBlobAsPng(source: Blob, document: Document, workers: IWebWorkerService): Promise<Uint8Array> {
	const image = document.createElement('img');
	const { url, registration } = createObjectUrl(getWindow(image), source);
	using lifetime = registration;
	image.src = url.toString();
	return await encodeImageAsPng(image, workers);
}

/** Keep each copy independent of tab changes, and terminate its Worker when encoding settles. */
export async function encodeImageAsPng(image: HTMLImageElement, workers: IWebWorkerService): Promise<Uint8Array> {
	try {
		await image.decode();
		const bitmap = await getWindow(image).createImageBitmap(image);
		try {
			using worker = workers.createWorkerClient<ImageEncoderWorker>(new WebWorkerDescriptor({
				label: 'ash-image-encoder',
				createWorker: () => new Worker(new URL('./imageEncoderWorkerMain.ts', import.meta.url), { type: 'module', name: 'ash-image-encoder' }),
			}));
			return new Uint8Array(await worker.proxy.$encodePng(bitmap));
		} finally {
			bitmap.close();
		}
	} catch (error) {
		throw new Error(localize('media.image.encodingFailed', 'Could not encode the image as PNG: {0}', error instanceof Error ? error.message : String(error)), { cause: error });
	}
}
