/** A request owns its cloned bitmap until PNG encoding settles. */
export class ImageEncoderWorker {
	public async $encodePng(bitmap: ImageBitmap): Promise<ArrayBuffer> {
		if (!(bitmap instanceof ImageBitmap)) {
			throw new TypeError('PNG encoding requires an ImageBitmap');
		}
		try {
			if (bitmap.width === 0 || bitmap.height === 0) {
				throw new RangeError('Cannot encode an empty image');
			}
			const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
			const context = canvas.getContext('2d');
			if (!context) {
				throw new Error('PNG encoding requires a 2D canvas context');
			}
			context.drawImage(bitmap, 0, 0);
			return await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
		} finally {
			bitmap.close();
		}
	}
}
