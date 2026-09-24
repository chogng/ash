import { BugIndicatingError } from '../../../../base/common/errors.js';
import { ensureNonNullable } from '../gpuUtils.js';
import { type IRasterizedGlyph } from '../raster/raster.js';
import { UsagePreviewColors, type ITextureAtlasAllocator, type ITextureAtlasPageGlyph } from './atlas.js';

export interface TextureAtlasSlabAllocatorOptions {
	readonly minimumSlabSize?: number;
}

export class TextureAtlasSlabAllocator implements ITextureAtlasAllocator {
	private readonly context: OffscreenCanvasRenderingContext2D;
	private readonly glyphs = new Set<Readonly<ITextureAtlasPageGlyph>>();
	private readonly minimumSlabSize: number;
	private x = 0;
	private y = 0;
	private rowHeight = 0;
	private nextIndex = 0;

	constructor(private readonly canvas: OffscreenCanvas, private readonly pageIndex: number, options: TextureAtlasSlabAllocatorOptions = {}) {
		this.context = ensureNonNullable(canvas.getContext('2d', { willReadFrequently: true }));
		this.minimumSlabSize = options.minimumSlabSize ?? 8;
	}

	public allocate(source: IRasterizedGlyph): ITextureAtlasPageGlyph | undefined {
		const width = source.boundingBox.right - source.boundingBox.left + 1;
		const height = source.boundingBox.bottom - source.boundingBox.top + 1;
		const slabSize = Math.max(this.minimumSlabSize, 2 ** Math.ceil(Math.log2(Math.max(1, width, height))));
		if (slabSize > this.canvas.width || slabSize > this.canvas.height) throw new BugIndicatingError('Glyph is too large for the atlas page');
		if (this.x + slabSize > this.canvas.width) {
			this.x = 0;
			this.y += this.rowHeight;
			this.rowHeight = 0;
		}
		if (this.y + slabSize > this.canvas.height) return undefined;
		if (width > 0 && height > 0) this.context.drawImage(source.source, source.boundingBox.left, source.boundingBox.top, width, height, this.x, this.y, width, height);
		const glyph = Object.freeze({
			pageIndex: this.pageIndex,
			glyphIndex: this.nextIndex++,
			x: this.x,
			y: this.y,
			w: width,
			h: height,
			originOffsetX: source.originOffset.x,
			originOffsetY: source.originOffset.y,
			fontBoundingBoxAscent: source.fontBoundingBoxAscent,
			fontBoundingBoxDescent: source.fontBoundingBoxDescent,
		});
		this.x += slabSize;
		this.rowHeight = Math.max(this.rowHeight, slabSize);
		this.glyphs.add(glyph);
		return glyph;
	}

	public async getUsagePreview(): Promise<Blob> {
		const canvas = new OffscreenCanvas(this.canvas.width, this.canvas.height);
		const context = ensureNonNullable(canvas.getContext('2d'));
		context.fillStyle = UsagePreviewColors.Unused;
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.fillStyle = UsagePreviewColors.Used;
		for (const glyph of this.glyphs) context.fillRect(glyph.x, glyph.y, glyph.w, glyph.h);
		return canvas.convertToBlob();
	}

	public getStats(): string {
		const used = [...this.glyphs].reduce((total, glyph) => total + glyph.w * glyph.h, 0);
		return `page${this.pageIndex}: ${used}/${this.canvas.width * this.canvas.height} pixels used`;
	}
}
