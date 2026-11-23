import { localize } from '../../../../nls.js';
import { IMAGE_PREVIEW_MAX_PIXELS } from '../common/mediaPreview.js';

type CheckDimensions = (width: number, height: number) => void;

class ImagePreviewPixelLimitError extends RangeError {
	constructor() {
		super(localize('media.image.pixelLimit', 'The image exceeds the preview limit of {0} pixels.', IMAGE_PREVIEW_MAX_PIXELS));
	}
}

export function assertImagePreviewPixelLimit(width: number, height: number): void {
	if (Math.ceil(width) * Math.ceil(height) > IMAGE_PREVIEW_MAX_PIXELS) throw new ImagePreviewPixelLimitError();
}

/** Check encoded canvas dimensions before giving the bytes to the browser decoder. */
export function validateImagePreviewDimensions(bytes: Uint8Array, mime: string, window: Window & typeof globalThis): void {
	let checked = false;
	const check: CheckDimensions = (width, height) => {
		if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new TypeError('Invalid image dimensions');
		checked = true;
		assertImagePreviewPixelLimit(width, height);
	};
	try {
		readDimensions(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), mime, window, check);
		if (!checked) throw new TypeError('Image dimensions are missing');
	} catch (error) {
		if (error instanceof ImagePreviewPixelLimitError) throw error;
		throw new TypeError(localize('media.image.invalid', 'The image data could not be decoded.'), { cause: error });
	}
}

function readDimensions(data: DataView, mime: string, window: Window & typeof globalThis, check: CheckDimensions): void {
	switch (mime) {
		case 'image/png':
			readPngDimensions(data, check);
			return;
		case 'image/jpeg':
			readJpegDimensions(data, check);
			return;
		case 'image/gif':
			check(data.getUint16(6, true), data.getUint16(8, true));
			return;
		case 'image/bmp':
			readBitmapDimensions(data, 14, false, check);
			return;
		case 'image/webp':
			readWebpDimensions(data, check);
			return;
		case 'image/avif':
			readAvifDimensions(data, check);
			return;
		case 'image/x-icon':
			readIconDimensions(data, check);
			return;
		case 'image/svg+xml':
			readSvgDimensions(data, window, check);
	}
}

function readPngDimensions(data: DataView, check: CheckDimensions): void {
	if (data.getUint32(0) !== 0x89504e47 || data.getUint32(4) !== 0x0d0a1a0a || data.getUint32(8) !== 13 || tag(data, 12) !== 'IHDR') {
		throw new TypeError('Invalid PNG header');
	}
	check(data.getUint32(16), data.getUint32(20));
}

function readJpegDimensions(data: DataView, check: CheckDimensions): void {
	if (data.getUint16(0) !== 0xffd8) throw new TypeError('Invalid JPEG header');
	let offset = 2;
	while (offset < data.byteLength) {
		if (data.getUint8(offset++) !== 0xff) throw new TypeError('Invalid JPEG marker');
		while (data.getUint8(offset) === 0xff) offset++;
		const marker = data.getUint8(offset++);
		if (marker === 0xd9 || marker === 0xda) return;
		if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
		const length = data.getUint16(offset);
		if (length < 2 || offset + length > data.byteLength) throw new TypeError('Invalid JPEG segment');
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			if (length < 8) throw new TypeError('Invalid JPEG frame');
			check(data.getUint16(offset + 5), data.getUint16(offset + 3));
			return;
		}
		offset += length;
	}
}

function readBitmapDimensions(data: DataView, offset: number, icon: boolean, check: CheckDimensions): void {
	const size = data.getUint32(offset, true);
	if (size !== 12 && size < 16) throw new TypeError('Invalid bitmap header');
	const width = size === 12 ? data.getUint16(offset + 4, true) : data.getInt32(offset + 4, true);
	const height = size === 12 ? data.getUint16(offset + 6, true) : Math.abs(data.getInt32(offset + 8, true));
	// ICO stores the color bitmap and its mask in the same DIB height.
	check(width, icon ? height / 2 : height);
}

function readIconDimensions(data: DataView, check: CheckDimensions): void {
	if (data.getUint32(0) !== 0x00000100) throw new TypeError('Invalid ICO header');
	const count = data.getUint16(4, true);
	const directoryEnd = 6 + count * 16;
	if (directoryEnd > data.byteLength) throw new TypeError('Invalid ICO directory');
	for (let entry = 6; entry < directoryEnd; entry += 16) {
		const size = data.getUint32(entry + 8, true);
		const offset = data.getUint32(entry + 12, true);
		if (size < 4 || offset < directoryEnd || offset + size > data.byteLength) throw new TypeError('Invalid ICO frame');
		const image = new DataView(data.buffer, data.byteOffset + offset, size);
		if (image.getUint32(0) === 0x89504e47) readPngDimensions(image, check);
		else readBitmapDimensions(image, 0, true, check);
	}
}

function readWebpDimensions(data: DataView, check: CheckDimensions): void {
	if (tag(data, 0) !== 'RIFF' || tag(data, 8) !== 'WEBP') throw new TypeError('Invalid WebP header');
	const end = data.getUint32(4, true) + 8;
	if (end > data.byteLength) throw new TypeError('Invalid WebP size');
	readWebpChunks(data, 12, end, check, true);
}

function readWebpChunks(data: DataView, offset: number, end: number, check: CheckDimensions, allowAnimation: boolean): void {
	while (offset + 8 <= end) {
		const kind = tag(data, offset);
		const length = data.getUint32(offset + 4, true);
		const start = offset + 8;
		offset = start + length + length % 2;
		if (offset > end) throw new TypeError('Invalid WebP chunk');
		if (kind === 'VP8X' && length >= 10) {
			check(uint24LE(data, start + 4) + 1, uint24LE(data, start + 7) + 1);
		} else if (kind === 'VP8 ' && length >= 10) {
			if (uint24LE(data, start + 3) !== 0x2a019d) throw new TypeError('Invalid VP8 frame');
			check(data.getUint16(start + 6, true) & 0x3fff, data.getUint16(start + 8, true) & 0x3fff);
		} else if (kind === 'VP8L' && length >= 5) {
			if (data.getUint8(start) !== 0x2f) throw new TypeError('Invalid VP8L frame');
			const dimensions = data.getUint32(start + 1, true);
			check((dimensions & 0x3fff) + 1, ((dimensions >>> 14) & 0x3fff) + 1);
		} else if (kind === 'ANMF' && allowAnimation && length >= 16) {
			check(uint24LE(data, start + 6) + 1, uint24LE(data, start + 9) + 1);
			readWebpChunks(data, start + 16, start + length, check, false);
		}
	}
}

function uint24LE(data: DataView, offset: number): number {
	return data.getUint16(offset, true) | (data.getUint8(offset + 2) << 16);
}

function tag(data: DataView, offset: number): string {
	return String.fromCharCode(data.getUint8(offset), data.getUint8(offset + 1), data.getUint8(offset + 2), data.getUint8(offset + 3));
}

interface Box { readonly kind: string; readonly start: number; readonly end: number; }

function* boxes(data: DataView, start: number, end: number): Iterable<Box> {
	for (let offset = start; offset < end;) {
		if (offset + 8 > end) throw new TypeError('Invalid image box');
		const shortSize = data.getUint32(offset);
		const headerSize = shortSize === 1 ? 16 : 8;
		if (offset + headerSize > end) throw new TypeError('Invalid image box header');
		const size = shortSize === 1 ? Number(data.getBigUint64(offset + 8)) : shortSize || end - offset;
		if (size < headerSize || size > end - offset) throw new TypeError('Invalid image box size');
		yield { kind: tag(data, offset + 4), start: offset + headerSize, end: offset + size };
		offset += size;
	}
}

function readAvifDimensions(data: DataView, check: CheckDimensions): void {
	const visit = (start: number, end: number, path: string): void => {
		for (const box of boxes(data, start, end)) {
			const child = `${path}/${box.kind}`;
			switch (child) {
				case '/meta': visit(box.start + 4, box.end, child); break;
				case '/meta/iprp':
				case '/meta/iprp/ipco':
				case '/moov':
				case '/moov/trak':
				case '/moov/trak/mdia':
				case '/moov/trak/mdia/minf':
				case '/moov/trak/mdia/minf/stbl': visit(box.start, box.end, child); break;
				case '/moov/trak/mdia/minf/stbl/stsd': visit(box.start + 8, box.end, child); break;
				case '/meta/iprp/ipco/ispe':
					if (box.start + 12 > box.end) throw new TypeError('Invalid AVIF dimensions');
					check(data.getUint32(box.start + 4), data.getUint32(box.start + 8));
					break;
				case '/moov/trak/mdia/minf/stbl/stsd/av01':
					if (box.start + 28 > box.end) throw new TypeError('Invalid AVIF track dimensions');
					check(data.getUint16(box.start + 24), data.getUint16(box.start + 26));
					break;
			}
		}
	};
	visit(0, data.byteLength, '');
}

function readSvgDimensions(data: DataView, window: Window & typeof globalThis, check: CheckDimensions): void {
	const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
	const document = new window.DOMParser().parseFromString(new TextDecoder(encoding).decode(bytes), 'image/svg+xml');
	const svg = document.documentElement;
	if (!(svg instanceof window.SVGSVGElement)) throw new TypeError('Invalid SVG document');
	const intrinsic = (attribute: 'width' | 'height'): number | undefined => {
		if (!svg.hasAttribute(attribute)) return undefined;
		const value = svg[attribute].baseVal;
		if (value.unitType === window.SVGLength.SVG_LENGTHTYPE_PERCENTAGE) return undefined;
		if (value.unitType === window.SVGLength.SVG_LENGTHTYPE_EMS) return value.valueInSpecifiedUnits * 16;
		if (value.unitType === window.SVGLength.SVG_LENGTHTYPE_EXS) return value.valueInSpecifiedUnits * 8;
		return value.value;
	};
	const width = intrinsic('width');
	const height = intrinsic('height');
	const { width: viewWidth, height: viewHeight } = svg.viewBox.baseVal;
	if (viewWidth > 0 && viewHeight > 0) {
		if (width !== undefined && height === undefined) return check(width, width * viewHeight / viewWidth);
		if (height !== undefined && width === undefined) return check(height * viewWidth / viewHeight, height);
	}
	// The default replaced-element viewport is at most 300 × 150 without intrinsic dimensions.
	check(width ?? 300, height ?? 150);
}
