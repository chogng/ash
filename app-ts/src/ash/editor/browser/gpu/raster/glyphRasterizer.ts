import { Disposable } from '../../../../base/common/lifecycle.js';
import { ColorId, FontStyle, TokenMetadata } from '../../../common/encodedTokenAttributes.js';
import { type DecorationStyleCache } from '../css/decorationStyleCache.js';
import { ensureNonNullable } from '../gpuUtils.js';
import { type IBoundingBox, type IGlyphRasterizer, type IRasterizedGlyph } from './raster.js';

let nextId = 0;

/** Rasterizes editor token metadata into the shared texture-atlas format. */
export class GlyphRasterizer extends Disposable implements IGlyphRasterizer {
	public readonly id = nextId++;
	public readonly cacheKey: string;
	private readonly _canvas: OffscreenCanvas;
	private readonly _ctx: OffscreenCanvasRenderingContext2D;
	private readonly _workGlyph: IRasterizedGlyph;
	private _workGlyphConfig: { chars: string | undefined; tokenMetadata: number; decorationStyleSetId: number } = {
		chars: undefined,
		tokenMetadata: 0,
		decorationStyleSetId: 0,
	};

	constructor(
		public readonly fontSize: number,
		public readonly fontFamily: string,
		public readonly devicePixelRatio: number,
		private readonly _decorationStyleCache: DecorationStyleCache,
	) {
		super();
		this.cacheKey = `${fontFamily}_${fontSize}px_${devicePixelRatio}`;
		const dimension = Math.max(3, Math.ceil(fontSize * devicePixelRatio) * 3);
		this._canvas = new OffscreenCanvas(dimension, dimension);
		this._ctx = ensureNonNullable(this._canvas.getContext('2d', { alpha: true, willReadFrequently: true }));
		this._workGlyph = {
			source: this._canvas,
			boundingBox: { left: 0, top: 0, right: 0, bottom: 0 },
			originOffset: { x: 0, y: 0 },
			fontBoundingBoxAscent: 0,
			fontBoundingBoxDescent: 0,
		};
	}

	public rasterizeGlyph(chars: string, tokenMetadata: number, decorationStyleSetId: number, colorMap: string[]): Readonly<IRasterizedGlyph> {
		if (this._workGlyphConfig.chars === chars && this._workGlyphConfig.tokenMetadata === tokenMetadata && this._workGlyphConfig.decorationStyleSetId === decorationStyleSetId) {
			return this._workGlyph;
		}
		this._workGlyphConfig = { chars, tokenMetadata, decorationStyleSetId };
		return this._rasterizeGlyph(chars, tokenMetadata, decorationStyleSetId, colorMap);
	}

	public _rasterizeGlyph(chars: string, tokenMetadata: number, decorationStyleSetId: number, colorMap: string[]): Readonly<IRasterizedGlyph> {
		if (chars === '') {
			return {
				source: this._canvas,
				boundingBox: { left: 0, top: 0, right: -1, bottom: -1 },
				originOffset: { x: 0, y: 0 },
				fontBoundingBoxAscent: 0,
				fontBoundingBoxDescent: 0,
			};
		}

		const deviceFontSize = Math.ceil(this.fontSize * this.devicePixelRatio);
		const dimension = Math.max(3, deviceFontSize * 3);
		if (this._canvas.width !== dimension || this._canvas.height !== dimension) {
			this._canvas.width = dimension;
			this._canvas.height = dimension;
		}
		const decoration = this._decorationStyleCache.getStyleSet(decorationStyleSetId);
		const fontStyle = TokenMetadata.getFontStyle(tokenMetadata);
		const italic = (fontStyle & FontStyle.Italic) !== 0;
		const bold = decoration?.bold ?? ((fontStyle & FontStyle.Bold) !== 0);
		this._ctx.clearRect(0, 0, dimension, dimension);
		this._ctx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${deviceFontSize}px ${this.fontFamily}`;
		this._ctx.textBaseline = 'top';
		this._ctx.globalAlpha = decoration?.opacity ?? 1;
		this._ctx.fillStyle = decoration?.color === undefined
			? colorMap[TokenMetadata.getForeground(tokenMetadata)] ?? colorMap[ColorId.DefaultForeground] ?? '#ffffff'
			: `#${decoration.color.toString(16).padStart(8, '0')}`;
		const metrics = this._ctx.measureText(chars);
		const origin = deviceFontSize;
		const subPixelX = (tokenMetadata & 0b1111) / 10;
		this._ctx.fillText(chars, origin + subPixelX, origin);
		if (decoration?.strikethrough) {
			const thickness = Math.max(1, Math.round((decoration.strikethroughThickness ?? this.fontSize / 10) * this.devicePixelRatio));
			if (decoration.strikethroughColor !== undefined) this._ctx.fillStyle = `#${decoration.strikethroughColor.toString(16).padStart(8, '0')}`;
			this._ctx.fillRect(origin, Math.round(origin + metrics.actualBoundingBoxAscent / 2), Math.ceil(metrics.width), thickness);
		}
		this._ctx.globalAlpha = 1;

		const imageData = this._ctx.getImageData(0, 0, dimension, dimension);
		findBoundingBox(imageData, this._workGlyph.boundingBox);
		this._workGlyph.originOffset.x = this._workGlyph.boundingBox.left - origin;
		this._workGlyph.originOffset.y = this._workGlyph.boundingBox.top - origin;
		this._workGlyph.fontBoundingBoxAscent = metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent;
		this._workGlyph.fontBoundingBoxDescent = metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent;
		return this._workGlyph;
	}

	public getTextMetrics(text: string): TextMetrics {
		this._ctx.font = `${Math.ceil(this.fontSize * this.devicePixelRatio)}px ${this.fontFamily}`;
		return this._ctx.measureText(text);
	}
}

function findBoundingBox(imageData: ImageData, result: IBoundingBox): void {
	const { width, height, data } = imageData;
	let left = width;
	let top = height;
	let right = -1;
	let bottom = -1;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (data[(y * width + x) * 4 + 3] === 0) continue;
			left = Math.min(left, x);
			top = Math.min(top, y);
			right = Math.max(right, x);
			bottom = Math.max(bottom, y);
		}
	}
	result.left = right < 0 ? 0 : left;
	result.top = bottom < 0 ? 0 : top;
	result.right = right;
	result.bottom = bottom;
}
