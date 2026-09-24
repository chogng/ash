import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { NKeyMap } from '../../../../base/common/map.js';
import { type IBoundingBox, type IGlyphRasterizer } from '../raster/raster.js';
import { type GlyphMap, type IReadableTextureAtlasPage, type ITextureAtlasAllocator, type ITextureAtlasPageGlyph } from './atlas.js';
import { TextureAtlasShelfAllocator } from './textureAtlasShelfAllocator.js';
import { TextureAtlasSlabAllocator } from './textureAtlasSlabAllocator.js';

export type AllocatorType = 'shelf' | 'slab' | ((canvas: OffscreenCanvas, textureIndex: number) => ITextureAtlasAllocator);

export class TextureAtlasPage extends Disposable implements IReadableTextureAtlasPage {
	public static readonly maximumGlyphCount = 5_000;
	private _version = 0;
	private _usedArea: IBoundingBox = { left: 0, top: 0, right: 0, bottom: 0 };
	private readonly _canvas: OffscreenCanvas;
	private readonly _glyphMap: GlyphMap<ITextureAtlasPageGlyph> = new NKeyMap();
	private readonly _glyphInOrderSet = new Set<ITextureAtlasPageGlyph>();
	private readonly _allocator: ITextureAtlasAllocator;

	constructor(textureIndex: number, pageSize: number, allocatorType: AllocatorType, private readonly _colorMap: string[]) {
		super();
		this._canvas = new OffscreenCanvas(pageSize, pageSize);
		this._allocator = typeof allocatorType === 'function'
			? allocatorType(this._canvas, textureIndex)
			: allocatorType === 'shelf'
				? new TextureAtlasShelfAllocator(this._canvas, textureIndex)
				: new TextureAtlasSlabAllocator(this._canvas, textureIndex);
		this._register(toDisposable(() => {
			this._canvas.width = 1;
			this._canvas.height = 1;
		}));
	}

	public get version(): number { return this._version; }
	public get usedArea(): Readonly<IBoundingBox> { return this._usedArea; }
	public get source(): OffscreenCanvas { return this._canvas; }
	public get glyphs(): IterableIterator<ITextureAtlasPageGlyph> { return this._glyphInOrderSet.values(); }

	public getGlyph(rasterizer: IGlyphRasterizer, chars: string, tokenMetadata: number, decorationStyleSetId: number): Readonly<ITextureAtlasPageGlyph> | undefined {
		return this._glyphMap.get(chars, tokenMetadata, decorationStyleSetId, rasterizer.cacheKey)
			?? this._createGlyph(rasterizer, chars, tokenMetadata, decorationStyleSetId);
	}

	private _createGlyph(rasterizer: IGlyphRasterizer, chars: string, tokenMetadata: number, decorationStyleSetId: number): Readonly<ITextureAtlasPageGlyph> | undefined {
		if (this._glyphInOrderSet.size >= TextureAtlasPage.maximumGlyphCount) return undefined;
		const glyph = this._allocator.allocate(rasterizer.rasterizeGlyph(chars, tokenMetadata, decorationStyleSetId, this._colorMap));
		if (!glyph) return undefined;
		this._glyphMap.set(glyph, chars, tokenMetadata, decorationStyleSetId, rasterizer.cacheKey);
		this._glyphInOrderSet.add(glyph);
		this._version++;
		this._usedArea = {
			left: 0,
			top: 0,
			right: Math.max(this._usedArea.right, glyph.x + glyph.w),
			bottom: Math.max(this._usedArea.bottom, glyph.y + glyph.h),
		};
		return glyph;
	}

	public getUsagePreview(): Promise<Blob> { return this._allocator.getUsagePreview(); }
	public getStats(): string { return this._allocator.getStats(); }
}
