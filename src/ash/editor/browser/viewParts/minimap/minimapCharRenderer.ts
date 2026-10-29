import { RGBA8 } from '../../../common/core/misc/rgba.js';
import { Constants, getCharIndex } from './minimapCharSheet.js';

/** Paints the compact bitmap font used by the minimap into caller-owned image data. */
export class MinimapCharRenderer {
	_minimapCharRendererBrand: void = undefined;
	private readonly normal: Uint8ClampedArray;
	private readonly light: Uint8ClampedArray;

	constructor(charData: Uint8ClampedArray, public readonly scale: number) {
		this.normal = scaleCoverage(charData, 0.8);
		this.light = scaleCoverage(charData, 5 / 6);
	}

	renderChar(
		target: ImageData,
		x: number,
		y: number,
		charCode: number,
		foreground: RGBA8,
		foregroundAlpha: number,
		background: RGBA8,
		backgroundAlpha: number,
		fontScale: number,
		useLighterFont: boolean,
		force1pxHeight: boolean,
	): void {
		const width = Constants.BASE_CHAR_WIDTH * this.scale;
		const height = force1pxHeight ? 1 : Constants.BASE_CHAR_HEIGHT * this.scale;
		if (!fits(target, x, y, width, height)) return warnOutside();
		const glyphHeight = Constants.BASE_CHAR_HEIGHT * this.scale;
		const glyph = useLighterFont ? this.light : this.normal;
		const start = getCharIndex(charCode, fontScale) * width * glyphHeight;
		paint(target, x, y, width, height, foreground, foregroundAlpha, background, backgroundAlpha, offset => glyph[start + offset] / 255);
	}

	blockRenderChar(
		target: ImageData,
		x: number,
		y: number,
		foreground: RGBA8,
		foregroundAlpha: number,
		background: RGBA8,
		backgroundAlpha: number,
		force1pxHeight: boolean,
	): void {
		const width = Constants.BASE_CHAR_WIDTH * this.scale;
		const height = force1pxHeight ? 1 : Constants.BASE_CHAR_HEIGHT * this.scale;
		if (!fits(target, x, y, width, height)) return warnOutside();
		paint(target, x, y, width, height, foreground, foregroundAlpha, background, backgroundAlpha, () => 0.5);
	}
}

function scaleCoverage(source: Uint8ClampedArray, ratio: number): Uint8ClampedArray {
	return Uint8ClampedArray.from(source, value => Math.floor(value * ratio));
}

function fits(target: ImageData, x: number, y: number, width: number, height: number): boolean {
	return x >= 0 && y >= 0 && x + width <= target.width && y + height <= target.height;
}

function warnOutside(): void {
	console.warn('bad render request outside image data');
}

function paint(
	target: ImageData,
	x: number,
	y: number,
	width: number,
	height: number,
	foreground: RGBA8,
	foregroundAlpha: number,
	background: RGBA8,
	backgroundAlpha: number,
	coverageAt: (offset: number) => number,
): void {
	const alpha = Math.max(foregroundAlpha, backgroundAlpha);
	let sourceOffset = 0;
	for (let row = 0; row < height; row++) {
		let targetOffset = ((y + row) * target.width + x) * Constants.RGBA_CHANNELS_CNT;
		for (let column = 0; column < width; column++) {
			const blend = coverageAt(sourceOffset++) * foregroundAlpha / 255;
			target.data[targetOffset++] = mix(background.r, foreground.r, blend);
			target.data[targetOffset++] = mix(background.g, foreground.g, blend);
			target.data[targetOffset++] = mix(background.b, foreground.b, blend);
			target.data[targetOffset++] = alpha;
		}
	}
}

function mix(background: number, foreground: number, ratio: number): number {
	return background + (foreground - background) * ratio;
}
