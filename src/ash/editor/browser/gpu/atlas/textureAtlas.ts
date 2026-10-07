import { getActiveWindow } from '../../../../base/browser/dom.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, dispose, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { NKeyMap } from '../../../../base/common/map.js';
import { MetadataConsts } from '../../../common/encodedTokenAttributes.js';
import { GlyphRasterizer } from '../raster/glyphRasterizer.js';
import { type IGlyphRasterizer } from '../raster/raster.js';
import { type DecorationStyleCache } from '../css/decorationStyleCache.js';
import { createIdleTaskQueue, type ITaskQueue } from '../taskQueue.js';
import { type GlyphMap, type IReadableTextureAtlasPage, type ITextureAtlasPageGlyph } from './atlas.js';
import { type AllocatorType, TextureAtlasPage } from './textureAtlasPage.js';

export interface ITextureAtlasOptions {
	readonly allocatorType?: AllocatorType;
}

export class TextureAtlas extends Disposable {
	public static readonly maximumPageCount = 16;
	private readonly _warmUpTask = this._register(new MutableDisposable<ITaskQueue>());
	private readonly _warmedUpRasterizers = new Set<number>();
	private readonly _allocatorType: AllocatorType;
	private readonly _pages: TextureAtlasPage[] = [];
	private readonly _glyphPageIndex: GlyphMap<number> = new NKeyMap();
	private readonly _onDidDeleteGlyphs = this._register(new Emitter<void>());
	public readonly onDidDeleteGlyphs: Event<void> = this._onDidDeleteGlyphs.event;
	public readonly pageSize: number;

	constructor(maxTextureSize: number, options: ITextureAtlasOptions | undefined, private readonly _decorationStyleCache: DecorationStyleCache, private readonly _colorMap: string[]) {
		super();
		if (!Number.isSafeInteger(maxTextureSize) || maxTextureSize < 64) throw new RangeError('WebGPU texture size must be an integer of at least 64 pixels');
		this._allocatorType = options?.allocatorType ?? 'slab';
		this.pageSize = Math.min(1024 * Math.max(1, Math.floor(getActiveWindow().devicePixelRatio)), maxTextureSize);
		this._initFirstPage();
		this._register(toDisposable(() => {
			dispose(this._pages);
			this._pages.length = 0;
		}));
	}

	public get pages(): IReadableTextureAtlasPage[] { return this._pages; }

	private _initFirstPage(): void {
		const firstPage = new TextureAtlasPage(0, this.pageSize, this._allocatorType, this._colorMap);
		this._pages.push(firstPage);
		const nullRasterizer = new GlyphRasterizer(1, '', 1, this._decorationStyleCache);
		firstPage.getGlyph(nullRasterizer, '', 0, 0);
		nullRasterizer.dispose();
	}

	public clear(): void {
		this._warmUpTask.clear();
		this._warmedUpRasterizers.clear();
		dispose(this._pages);
		this._pages.length = 0;
		this._glyphPageIndex.clear();
		this._initFirstPage();
		this._onDidDeleteGlyphs.fire();
	}

	public getGlyph(rasterizer: IGlyphRasterizer, chars: string, tokenMetadata: number, decorationStyleSetId: number, x: number): Readonly<ITextureAtlasPageGlyph> {
		tokenMetadata &= ~(MetadataConsts.LANGUAGEID_MASK | MetadataConsts.TOKEN_TYPE_MASK | MetadataConsts.BALANCED_BRACKETS_MASK);
		tokenMetadata |= Math.floor((x % 1) * 10);
		if (!this._warmedUpRasterizers.has(rasterizer.id)) {
			this._warmedUpRasterizers.add(rasterizer.id);
			this._warmUpAtlas(rasterizer);
		}
		const pageIndex = this._glyphPageIndex.get(chars, tokenMetadata, decorationStyleSetId, rasterizer.cacheKey) ?? 0;
		return this._tryGetGlyph(pageIndex, rasterizer, chars, tokenMetadata, decorationStyleSetId);
	}

	private _tryGetGlyph(pageIndex: number, rasterizer: IGlyphRasterizer, chars: string, tokenMetadata: number, decorationStyleSetId: number): Readonly<ITextureAtlasPageGlyph> {
		this._glyphPageIndex.set(pageIndex, chars, tokenMetadata, decorationStyleSetId, rasterizer.cacheKey);
		return this._pages[pageIndex]!.getGlyph(rasterizer, chars, tokenMetadata, decorationStyleSetId)
			?? (pageIndex + 1 < this._pages.length
				? this._tryGetGlyph(pageIndex + 1, rasterizer, chars, tokenMetadata, decorationStyleSetId)
				: this._getGlyphFromNewPage(rasterizer, chars, tokenMetadata, decorationStyleSetId));
	}

	private _getGlyphFromNewPage(rasterizer: IGlyphRasterizer, chars: string, tokenMetadata: number, decorationStyleSetId: number): Readonly<ITextureAtlasPageGlyph> {
		if (this._pages.length >= TextureAtlas.maximumPageCount) throw new RangeError('WebGPU texture atlas exhausted its page limit');
		const pageIndex = this._pages.length;
		const page = new TextureAtlasPage(pageIndex, this.pageSize, this._allocatorType, this._colorMap);
		this._pages.push(page);
		this._glyphPageIndex.set(pageIndex, chars, tokenMetadata, decorationStyleSetId, rasterizer.cacheKey);
		const glyph = page.getGlyph(rasterizer, chars, tokenMetadata, decorationStyleSetId);
		if (!glyph) throw new RangeError('WebGPU glyph exceeds the texture atlas page size');
		return glyph;
	}

	public getUsagePreview(): Promise<Blob[]> { return Promise.all(this._pages.map(page => page.getUsagePreview())); }
	public getStats(): string[] { return this._pages.map(page => page.getStats()); }

	private _warmUpAtlas(rasterizer: IGlyphRasterizer): void {
		const ownerWindow = getActiveWindow();
		this._warmUpTask.value?.clear();
		const queue = this._warmUpTask.value = createIdleTaskQueue(ownerWindow);
		for (let code = 33; code <= 126; code++) {
			queue.enqueue(() => {
				if (!this.isDisposed) this.getGlyph(rasterizer, String.fromCharCode(code), MetadataConsts.FOREGROUND_MASK & (1 << MetadataConsts.FOREGROUND_OFFSET), 0, 0);
			});
		}
	}
}
