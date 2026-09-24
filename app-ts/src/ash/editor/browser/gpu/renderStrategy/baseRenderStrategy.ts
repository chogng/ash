import { toDisposable } from '../../../../base/common/lifecycle.js';
import { ViewEventHandler } from '../../../common/viewEventHandler.js';
import { type ViewportData } from '../../../common/viewLayout/viewLinesViewportData.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import { type IGpuRenderStrategy } from '../gpu.js';
import { type GlyphRasterizer } from '../raster/glyphRasterizer.js';
import { type ViewGpuContext } from '../viewGpuContext.js';
import { type ViewLineOptions } from '../../viewParts/viewLines/viewLineOptions.js';

export abstract class BaseRenderStrategy extends ViewEventHandler implements IGpuRenderStrategy {
	public abstract readonly type: string;
	public abstract readonly wgsl: string;
	public abstract readonly bindGroupEntries: GPUBindGroupEntry[];
	public get glyphRasterizer(): GlyphRasterizer { return this._glyphRasterizer.value; }

	constructor(
		protected readonly _context: ViewContext,
		protected readonly _viewGpuContext: ViewGpuContext,
		protected readonly _device: GPUDevice,
		protected readonly _glyphRasterizer: { value: GlyphRasterizer },
	) {
		super();
		this._context.addEventHandler(this);
		this._register(toDisposable(() => this._context.removeEventHandler(this)));
	}

	public abstract reset(): void;
	public abstract update(viewportData: ViewportData, viewLineOptions: ViewLineOptions): number;
	public abstract draw(pass: GPURenderPassEncoder, viewportData: ViewportData): void;
}
