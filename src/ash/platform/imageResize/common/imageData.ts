import { SCREENSHOT_MAX_BYTES, SCREENSHOT_MAX_PIXELS } from '../../native/common/native.js';

/** Check the PNG header before a host decoder can allocate the uncompressed image. */
export function validatePngImage(value: unknown): Uint8Array {
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
		throw new RangeError('PNG image is too large');
	return value;
}
