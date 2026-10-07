import { BugIndicatingError } from '../../../../base/common/errors.js';
import { ensureNonNullable } from '../gpuUtils.js';
import { type IRasterizedGlyph } from '../raster/raster.js';
import { UsagePreviewColors, type ITextureAtlasAllocator, type ITextureAtlasPageGlyph } from './atlas.js';

export class TextureAtlasShelfAllocator implements ITextureAtlasAllocator {
	private readonly context: OffscreenCanvasRenderingContext2D;
	private readonly glyphs = new Set<Readonly<ITextureAtlasPageGlyph>>();
	private x = 0;
	private y = 0;
	private rowHeight = 0;
	private nextIndex = 0;

	constructor(private readonly canvas: OffscreenCanvas, private readonly pageIndex: number) {
		this.context = ensureNonNullable(canvas.getContext('2d', { willReadFrequently: true }));
	}

	public allocate(source: IRasterizedGlyph): ITextureAtlasPageGlyph | undefined {
		const width = source.boundingBox.right - source.boundingBox.left + 1;
		const height = source.boundingBox.bottom - source.boundingBox.top + 1;
		if (width > this.canvas.width || height > this.canvas.height) throw new BugIndicatingError('Glyph is too large for the atlas page');
		if (this.x + width > this.canvas.width) {
			this.x = 0;
			this.y += this.rowHeight;
			this.rowHeight = 0;
		}
		if (this.y + height > this.canvas.height) return undefined;
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
		this.x += width;
		this.rowHeight = Math.max(this.rowHeight, height);
		this.glyphs.add(glyph);
		return glyph;
	}

	public getUsagePreview(): Promise<Blob> {
		const preview = new OffscreenCanvas(this.canvas.width, this.canvas.height);
		const context = ensureNonNullable(preview.getContext('2d'));
		context.fillStyle = UsagePreviewColors.Unused;
		context.fillRect(0, 0, preview.width, preview.height);
		context.fillStyle = UsagePreviewColors.Used;
		for (const glyph of this.glyphs) context.fillRect(glyph.x, glyph.y, glyph.w, glyph.h);
		return preview.convertToBlob();
	}

	public getStats(): string {
		const used = [...this.glyphs].reduce((total, glyph) => total + glyph.w * glyph.h, 0);
		return `page${this.pageIndex}: ${used}/${this.canvas.width * this.canvas.height} pixels used`;
	}
}
