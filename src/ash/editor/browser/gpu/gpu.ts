import { type IDisposable } from '../../../base/common/lifecycle.js';
import { type ViewConfigurationChangedEvent, type ViewLinesChangedEvent, type ViewLinesDeletedEvent, type ViewLinesInsertedEvent, type ViewScrollChangedEvent, type ViewTokensChangedEvent } from '../../common/viewEvents.js';
import { type ViewportData } from '../../common/viewLayout/viewLinesViewportData.js';
import { type ViewLineOptions } from '../viewParts/viewLines/viewLineOptions.js';
import { type IGlyphRasterizer } from './raster/raster.js';

export const enum BindingId {
	GlyphInfo,
	Cells,
	TextureSampler,
	Texture,
	LayoutInfoUniform,
	AtlasDimensionsUniform,
	ScrollOffset,
}

export interface IGpuRenderStrategy extends IDisposable {
	readonly type: string;
	readonly wgsl: string;
	readonly bindGroupEntries: GPUBindGroupEntry[];
	readonly glyphRasterizer: IGlyphRasterizer;

	onLinesDeleted(event: ViewLinesDeletedEvent): boolean;
	onConfigurationChanged(event: ViewConfigurationChangedEvent): boolean;
	onTokensChanged(event: ViewTokensChangedEvent): boolean;
	onLinesInserted(event: ViewLinesInsertedEvent): boolean;
	onLinesChanged(event: ViewLinesChangedEvent): boolean;
	onScrollChanged(event?: ViewScrollChangedEvent): boolean;

	reset(): void;
	update(viewportData: ViewportData, viewLineOptions: ViewLineOptions): number;
	draw(pass: GPURenderPassEncoder, viewportData: ViewportData): void;
}
