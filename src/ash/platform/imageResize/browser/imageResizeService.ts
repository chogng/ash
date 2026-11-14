import { decodeBase64 } from '../../../base/common/buffer.js';
import { IImageResizeService, type IImageResizeOptions } from '../common/imageResizeService.js';

export class ImageResizeService implements IImageResizeService {
	declare readonly _serviceBrand: undefined;
	public async resizeImage(data: Uint8Array | string, mimeType = 'image/png', options?: IImageResizeOptions): Promise<Uint8Array> {
		const bytes = typeof data === 'string' ? decodeBase64(data.includes(',') ? data.slice(data.indexOf(',') + 1) : data).buffer : data;
		const maximum = options?.maxDimension ?? 768;
		if (!Number.isInteger(maximum) || maximum < 1 || maximum > 16384) {
			throw new RangeError('Invalid image dimension limit');
		}
		const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mimeType }));
		try {
			const scale = Math.min(1, maximum / Math.max(bitmap.width, bitmap.height));
			if (scale === 1 && bytes.byteLength <= 1024 * 1024) {
				return bytes;
			}
			const canvas = document.createElement('canvas');
			canvas.width = Math.max(1, Math.round(bitmap.width * scale));
			canvas.height = Math.max(1, Math.round(bitmap.height * scale));
			const context = canvas.getContext('2d');
			if (!context) { throw new Error('Image processing is unavailable'); }
			context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			const outputType = mimeType === 'image/jpeg' || mimeType === 'image/jpg' ? 'image/jpeg' : 'image/png';
			const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, outputType, 0.85));
			if (!blob) { throw new Error('Image encoding failed'); }
			return new Uint8Array(await blob.arrayBuffer());
		} finally {
			bitmap.close();
		}
	}
}
