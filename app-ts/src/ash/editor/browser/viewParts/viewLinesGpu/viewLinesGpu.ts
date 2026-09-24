import { MutableDisposable, type IReference } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { ViewGpuContext } from '../../gpu/viewGpuContext.js';
import { GPULifecycle } from '../../gpu/gpuDisposable.js';
import { GlyphRasterizer } from '../../gpu/raster/glyphRasterizer.js';
import { BindingId, type IGpuRenderStrategy } from '../../gpu/gpu.js';
import { FullFileRenderStrategy } from '../../gpu/renderStrategy/fullFileRenderStrategy.js';
import { ViewportRenderStrategy } from '../../gpu/renderStrategy/viewportRenderStrategy.js';
import { type RenderingContext } from '../../view/renderingContext.js';
import { ViewPart } from '../../view/viewPart.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { HorizontalPosition, HorizontalRange, type IViewLines, LineVisibleRanges } from '../../view/renderingContext.js';
import { type ViewRevealRangeRequestEvent } from '../../../common/viewEvents.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { type ViewportData } from '../../../common/viewLayout/viewLinesViewportData.js';
import { ViewLineOptions } from '../viewLines/viewLineOptions.js';
import { TextureAtlas } from '../../gpu/atlas/textureAtlas.js';
import { TextureAtlasPage } from '../../gpu/atlas/textureAtlasPage.js';
import { quadVertices } from '../../gpu/gpuUtils.js';
import { createContentSegmenter } from '../../gpu/contentSegmenter.js';
import { CursorColumns } from '../../../common/core/cursorColumns.js';

interface GpuLineGeometry {
	readonly leftByOffset: readonly number[];
	readonly newLineWidth: number;
}

const GLYPH_INFO_FLOATS = 6;

/** Draws eligible visible text rows through the VS Code-aligned WebGPU glyph-atlas path. */
export class ViewLinesGpu extends ViewPart implements IViewLines {
	private readonly canvas: HTMLCanvasElement;
	private readonly vertexBuffer = this._register(new MutableDisposable<IReference<GPUBuffer>>());
	private readonly layoutInfoBuffer = this._register(new MutableDisposable<IReference<GPUBuffer>>());
	private readonly atlasInfoBuffer = this._register(new MutableDisposable<IReference<GPUBuffer>>());
	private readonly glyphStorageBuffer = this._register(new MutableDisposable<IReference<GPUBuffer>>());
	private readonly atlasTexture = this._register(new MutableDisposable<IReference<GPUTexture>>());
	private readonly renderStrategy = this._register(new MutableDisposable<IGpuRenderStrategy>());
	private readonly renderStrategyBindGroupListener = this._register(new MutableDisposable());
	private pipeline: GPURenderPipeline | undefined;
	private sampler: GPUSampler | undefined;
	private bindGroup: GPUBindGroup | undefined;
	private uploadedPageVersions: number[] = [];
	private readonly rasterizer = this._register(new MutableDisposable<GlyphRasterizer>());
	private device: GPUDevice | undefined;
	private initialized = false;
	private pendingViewportData: ViewportData | undefined;
	private lastLineGeometries: ReadonlyMap<number, GpuLineGeometry> | undefined;
	private lastViewportData: ViewportData | undefined;
	private visibleObjectCount = 0;

	constructor(context: ViewContext, private readonly viewGpuContext: ViewGpuContext) {
		super(context);
		this.canvas = this.viewGpuContext.canvas.domNode;
		this._register(autorun(reader => {
			this.viewGpuContext.canvasDevicePixelDimensions.read(reader);
			const viewportData = this.lastViewportData;
			if (!viewportData) return;
			queueMicrotask(() => {
				if (!this.isDisposed && viewportData === this.lastViewportData) this.renderText(viewportData);
			});
		}));
		this._register(autorun(reader => {
			this.viewGpuContext.devicePixelRatio.read(reader);
			if (this.device) this.refreshGlyphRasterizer();
		}));
		void this.initWebgpu();
	}

	public prepareRender(_context: RenderingContext): void {
	}

	public override onConfigurationChanged(): boolean {
		this.refreshGlyphRasterizer();
		this.renderStrategy.value?.reset();
		return true;
	}
	public override onCursorStateChanged(): boolean { return true; }
	public override onDecorationsChanged(): boolean { return true; }
	public override onFlushed(): boolean { return true; }
	public override onLinesChanged(): boolean { return true; }
	public override onLinesDeleted(): boolean { return true; }
	public override onLinesInserted(): boolean { return true; }
	public override onLineMappingChanged(): boolean { return true; }
	public override onRevealRangeRequest(_event: ViewRevealRangeRequestEvent): boolean { return true; }
	public override onScrollChanged(): boolean { return true; }
	public override onThemeChanged(): boolean { return true; }
	public override onZonesChanged(): boolean { return true; }

	public render(context: RenderingContext): void {
		this.renderText(context.viewportData);
	}

	public linesVisibleRangesForRange(range: Range, includeNewLines: boolean): LineVisibleRanges[] | null {
		const lineGeometries = this.lastLineGeometries;
		if (!lineGeometries || !this.lastViewportData || !Range.areIntersectingOrTouching(range, this.lastViewportData.visibleRange)) return null;
		const result: LineVisibleRanges[] = [];
		let nextModelLineNumber = includeNewLines
			? this._context.viewModel.coordinatesConverter.convertViewPositionToModelPosition(new Position(range.startLineNumber, 1)).lineNumber
			: 0;
		for (let lineNumber = range.startLineNumber; lineNumber <= range.endLineNumber; lineNumber += 1) {
			const currentModelLineNumber = nextModelLineNumber;
			const continuesInNextLine = lineNumber !== range.endLineNumber;
			if (includeNewLines && continuesInNextLine) {
				nextModelLineNumber = this._context.viewModel.coordinatesConverter.convertViewPositionToModelPosition(new Position(lineNumber + 1, 1)).lineNumber;
			}
			const geometry = lineGeometries.get(lineNumber - 1);
			if (!geometry) continue;
			const startColumn = lineNumber === range.startLineNumber ? range.startColumn : 1;
			const endColumn = continuesInNextLine ? geometry.leftByOffset.length : range.endColumn;
			const left = geometry.leftByOffset[startColumn - 1];
			const right = geometry.leftByOffset[endColumn - 1];
			if (left === undefined || right === undefined) continue;
			let newLineWidth = 0;
			if (includeNewLines && continuesInNextLine) {
				if (currentModelLineNumber !== nextModelLineNumber) newLineWidth = geometry.newLineWidth;
			}
			result.push(new LineVisibleRanges(
				false,
				lineNumber,
				[new HorizontalRange(left, Math.max(0, right - left) + newLineWidth)],
				continuesInNextLine,
			));
		}
		return result.length > 0 ? result : null;
	}

	public visibleRangeForPosition(position: Position): HorizontalPosition | null {
		const geometry = this.lastLineGeometries?.get(position.lineNumber - 1);
		if (!geometry) return null;
		const left = geometry.leftByOffset[position.column - 1];
		return left === undefined ? null : new HorizontalPosition(false, left);
	}

	public getLineWidth(lineNumber: number): number | undefined {
		const geometry = this.lastLineGeometries?.get(lineNumber - 1);
		return geometry?.leftByOffset.at(-1);
	}

	public getPositionAtCoordinate(lineNumber: number, mouseContentHorizontalOffset: number): Position | undefined {
		if (!Number.isFinite(mouseContentHorizontalOffset)) throw new RangeError('GPU hit-test offset must be finite');
		const geometry = this.lastLineGeometries?.get(lineNumber - 1);
		if (!geometry) return undefined;
		const offsets = geometry.leftByOffset;
		let column = 0;
		while (column + 1 < offsets.length) {
			const left = offsets[column];
			let nextColumn = column + 1;
			while (nextColumn < offsets.length && offsets[nextColumn] === left) nextColumn += 1;
			const right = offsets[nextColumn];
			if (left === undefined || right === undefined || mouseContentHorizontalOffset < left + (right - left) / 2) break;
			column = nextColumn;
		}
		return new Position(lineNumber, column + 1);
	}

	public renderText(viewportData: ViewportData): void {
		if (!this.initialized || !this.device) {
			this.pendingViewportData = viewportData;
			return;
		}
		const viewLineOptions = new ViewLineOptions(this._context.configuration, this._context.theme.type);
		this.refreshGlyphRasterizer();
		this.ensureRenderStrategy(viewportData);
		this.ensureGpuResources();
		this.visibleObjectCount = this.renderStrategy.value!.update(viewportData, viewLineOptions);
		this.updateAtlasStorageAndTexture();
		const gpuLineIndexes = this.readGpuLineIndexes(viewportData, viewLineOptions);
		this.lastLineGeometries = this.computeLineGeometries(viewportData, viewLineOptions, gpuLineIndexes);
		this.lastViewportData = viewportData;
		this.draw(viewportData);
	}

	public async initWebgpu(): Promise<void> {
		this.device = ViewGpuContext.deviceSync ?? await ViewGpuContext.device;
		if (this.isDisposed) return;
		const atlas = ViewGpuContext.atlas;
		this._register(atlas.onDidDeleteGlyphs(() => {
			this.uploadedPageVersions.length = 0;
			this.renderStrategy.value?.reset();
		}));
		this.initialized = true;
		const viewportData = this.pendingViewportData;
		this.pendingViewportData = undefined;
		if (viewportData) this.renderText(viewportData);
	}

	private ensureGpuResources(): void {
		const device = this.device!;
		if (!this.pipeline) {
			const presentationFormat = this.canvas.ownerDocument.defaultView!.navigator.gpu.getPreferredCanvasFormat();
			this.viewGpuContext.ctx.configure({ device, format: presentationFormat, alphaMode: 'premultiplied' });
			const shader = device.createShaderModule({ label: 'Ash ViewLinesGpu shader', code: this.renderStrategy.value!.wgsl });
			this.pipeline = device.createRenderPipeline({
				label: 'Ash ViewLinesGpu pipeline',
				layout: 'auto',
				vertex: {
					module: shader,
					entryPoint: 'vs',
					buffers: [{
						arrayStride: 2 * Float32Array.BYTES_PER_ELEMENT,
						attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
					}],
				},
				fragment: {
					module: shader,
					entryPoint: 'fs',
					targets: [{
						format: presentationFormat,
						blend: {
							color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
							alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
						},
					}],
				},
				primitive: { topology: 'triangle-list' },
			});
			this.sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
			this.vertexBuffer.value = GPULifecycle.createBuffer(device, {
				label: 'Ash ViewLinesGpu quad',
				size: quadVertices.byteLength,
				usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
			}, quadVertices as Float32Array<ArrayBuffer>);
			this.layoutInfoBuffer.value = GPULifecycle.createBuffer(device, {
				label: 'Ash ViewLinesGpu layout',
				size: 6 * Float32Array.BYTES_PER_ELEMENT,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
			});
			this.atlasInfoBuffer.value = GPULifecycle.createBuffer(device, {
				label: 'Ash ViewLinesGpu atlas dimensions',
				size: 2 * Float32Array.BYTES_PER_ELEMENT,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
			});
			this.glyphStorageBuffer.value = GPULifecycle.createBuffer(device, {
				label: 'Ash ViewLinesGpu glyph metadata',
				size: TextureAtlas.maximumPageCount * TextureAtlasPage.maximumGlyphCount * GLYPH_INFO_FLOATS * Float32Array.BYTES_PER_ELEMENT,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			});
		}
		if (!this.atlasTexture.value) this.createAtlasTexture();
	}

	private createAtlasTexture(): void {
		const atlas = this.viewGpuContext.atlas;
		this.renderStrategy.value?.reset();
		this.atlasTexture.value = GPULifecycle.createTexture(this.device!, {
			label: 'Stanza ViewLinesGpu glyph atlas',
			size: { width: atlas.pageSize, height: atlas.pageSize, depthOrArrayLayers: TextureAtlas.maximumPageCount },
			format: 'rgba8unorm',
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
		});
		this.uploadedPageVersions = [];
		this.device!.queue.writeBuffer(this.atlasInfoBuffer.value!.object, 0, new Float32Array([atlas.pageSize, atlas.pageSize]));
		this.rebuildBindGroup();
	}

	private rebuildBindGroup(): void {
		if (!this.pipeline || !this.atlasTexture.value || !this.layoutInfoBuffer.value || !this.atlasInfoBuffer.value || !this.glyphStorageBuffer.value || !this.renderStrategy.value) return;
		this.bindGroup = this.device!.createBindGroup({
			label: 'Stanza ViewLinesGpu bindings',
			layout: this.pipeline!.getBindGroupLayout(0),
			entries: [
				{ binding: BindingId.GlyphInfo, resource: { buffer: this.glyphStorageBuffer.value.object } },
				{ binding: BindingId.Texture, resource: this.atlasTexture.value.object.createView({ dimension: '2d-array' }) },
				{ binding: BindingId.TextureSampler, resource: this.sampler! },
				{ binding: BindingId.LayoutInfoUniform, resource: { buffer: this.layoutInfoBuffer.value.object } },
				{ binding: BindingId.AtlasDimensionsUniform, resource: { buffer: this.atlasInfoBuffer.value.object } },
				...this.renderStrategy.value!.bindGroupEntries,
			],
		});
	}

	private updateAtlasStorageAndTexture(): void {
		const atlas = this.viewGpuContext.atlas;
		for (let pageIndex = 0; pageIndex < atlas.pages.length; pageIndex++) {
			const page = atlas.pages[pageIndex]!;
			if (this.uploadedPageVersions[pageIndex] === page.version) continue;
			const glyphValues = new Float32Array(TextureAtlasPage.maximumGlyphCount * GLYPH_INFO_FLOATS);
			for (const glyph of page.glyphs) {
				const offset = glyph.glyphIndex * GLYPH_INFO_FLOATS;
				glyphValues[offset] = glyph.x;
				glyphValues[offset + 1] = glyph.y;
				glyphValues[offset + 2] = glyph.w;
				glyphValues[offset + 3] = glyph.h;
				glyphValues[offset + 4] = glyph.originOffsetX;
				glyphValues[offset + 5] = glyph.originOffsetY;
			}
			this.device!.queue.writeBuffer(
				this.glyphStorageBuffer.value!.object,
				pageIndex * glyphValues.byteLength,
				glyphValues as Float32Array<ArrayBuffer>,
			);
			if (page.usedArea.right > 0 && page.usedArea.bottom > 0) {
				this.device!.queue.copyExternalImageToTexture(
					{ source: page.source },
					{ texture: this.atlasTexture.value!.object, origin: { x: 0, y: 0, z: pageIndex } },
					{ width: page.usedArea.right, height: page.usedArea.bottom },
				);
			}
			this.uploadedPageVersions[pageIndex] = page.version;
		}
	}

	private draw(viewportData: ViewportData): void {
		const dimensions = this.viewGpuContext.canvasDevicePixelDimensions.get();
		const contentLeft = Math.ceil(this.viewGpuContext.contentLeft.get() * this.viewGpuContext.devicePixelRatio.get());
		this.device!.queue.writeBuffer(this.layoutInfoBuffer.value!.object, 0, new Float32Array([
			dimensions.width,
			dimensions.height,
			contentLeft,
			0,
			Math.max(0, dimensions.width - contentLeft),
			dimensions.height,
		]));
		const encoder = this.device!.createCommandEncoder({ label: 'Stanza ViewLinesGpu frame' });
		const textureView = this.viewGpuContext.ctx.getCurrentTexture().createView();
		this.viewGpuContext.rectangleRenderer.draw(viewportData);
		const pass = encoder.beginRenderPass({
			label: 'Stanza ViewLinesGpu pass',
			colorAttachments: [{
				view: textureView,
				clearValue: { r: 0, g: 0, b: 0, a: 0 },
				loadOp: 'load',
				storeOp: 'store',
			}],
		});
		if (this.visibleObjectCount > 0 && contentLeft < dimensions.width) {
			pass.setPipeline(this.pipeline!);
			pass.setBindGroup(0, this.bindGroup!);
			pass.setVertexBuffer(0, this.vertexBuffer.value!.object);
			pass.setScissorRect(contentLeft, 0, dimensions.width - contentLeft, dimensions.height);
			this.renderStrategy.value!.draw(pass, viewportData);
		}
		pass.end();
		this.device!.queue.submit([encoder.finish()]);
	}

	private refreshGlyphRasterizer(): void {
		const fontFamily = this._context.configuration.options.get(EditorOption.fontFamily);
		const fontSize = this._context.configuration.options.get(EditorOption.fontSize);
		const devicePixelRatio = this.viewGpuContext.devicePixelRatio.get();
		const current = this.rasterizer.value;
		if (current && current.fontFamily === fontFamily && current.fontSize === fontSize && current.devicePixelRatio === devicePixelRatio) return;
		this.rasterizer.value = new GlyphRasterizer(fontSize, fontFamily, devicePixelRatio, ViewGpuContext.decorationStyleCache);
		this.renderStrategy.clear();
		this.renderStrategyBindGroupListener.clear();
	}

	private readGpuLineIndexes(viewportData: ViewportData, viewLineOptions: ViewLineOptions): ReadonlySet<number> {
		const result = new Set<number>();
		for (let lineNumber = viewportData.startLineNumber; lineNumber <= viewportData.endLineNumber; lineNumber++) {
			if (this.viewGpuContext.canRender(viewLineOptions, viewportData, lineNumber)) result.add(lineNumber - 1);
		}
		return result;
	}

	private computeLineGeometries(viewportData: ViewportData, viewLineOptions: ViewLineOptions, gpuLineIndexes: ReadonlySet<number>): ReadonlyMap<number, GpuLineGeometry> {
		const result = new Map<number, GpuLineGeometry>();
		const devicePixelRatio = this.viewGpuContext.devicePixelRatio.get();
		for (const lineIndex of gpuLineIndexes) {
			const lineData = viewportData.getViewLineRenderingData(lineIndex + 1);
			const segmenter = createContentSegmenter(lineData, viewLineOptions);
			const leftByOffset = new Array<number>(lineData.content.length + 1);
			let deviceX = (lineData.minColumn - 1) * viewLineOptions.spaceWidth * devicePixelRatio;
			let tabColumnOffset = 0;
			leftByOffset[0] = this.contentLeft + deviceX / devicePixelRatio;
			for (let index = 0; index < lineData.content.length; index++) {
				const chars = segmenter.getSegmentAtIndex(index);
				if (chars === undefined) continue;
				const start = this.contentLeft + deviceX / devicePixelRatio;
				const useFixedAdvance = lineData.isBasicASCII && viewLineOptions.useMonospaceOptimizations;
				const advance = useFixedAdvance
					? viewLineOptions.spaceWidth * devicePixelRatio
					: this.renderStrategy.value!.glyphRasterizer.getTextMetrics(chars === '\t' ? ' ' : chars).width;
				if (chars === '\t') {
					const previousColumn = index + tabColumnOffset;
					const nextColumn = CursorColumns.nextRenderTabStop(previousColumn, lineData.tabSize);
					deviceX += advance * (nextColumn - previousColumn);
					tabColumnOffset = nextColumn - index - 1;
				} else {
					deviceX += advance;
				}
				for (let offset = index; offset < index + chars.length; offset++) leftByOffset[offset] = start;
				leftByOffset[index + chars.length] = this.contentLeft + deviceX / devicePixelRatio;
			}
			result.set(lineIndex, Object.freeze({
				leftByOffset: Object.freeze(leftByOffset),
				newLineWidth: viewLineOptions.spaceWidth,
			}));
		}
		return result;
	}

	private get contentLeft(): number {
		return this._context.configuration.options.get(EditorOption.layoutInfo).contentLeft;
	}

	private ensureRenderStrategy(viewportData: ViewportData): void {
		const expectedType = this.canUseFullFileStrategy() ? 'fullfile' : 'viewport';
		if (this.renderStrategy.value?.type === expectedType) return;
		const strategy = this.createRenderStrategy(this.rasterizer.value!, viewportData);
		this.renderStrategy.value = strategy;
		this.renderStrategyBindGroupListener.value = strategy instanceof ViewportRenderStrategy
			? strategy.onDidChangeBindGroupEntries(() => this.rebuildBindGroup())
			: undefined;
		this.rebuildBindGroup();
	}

	private createRenderStrategy(rasterizer: GlyphRasterizer, viewportData: ViewportData): IGpuRenderStrategy {
		const rasterizerReference = { value: rasterizer };
		return this.canUseFullFileStrategy()
			? new FullFileRenderStrategy(this._context, this.viewGpuContext, this.device!, rasterizerReference)
			: new ViewportRenderStrategy(this._context, this.viewGpuContext, this.device!, rasterizerReference);
	}

	private canUseFullFileStrategy(): boolean {
		const lineCount = this._context.viewModel.getLineCount();
		if (lineCount > FullFileRenderStrategy.maxSupportedLines) return false;
		for (let lineNumber = 1; lineNumber <= lineCount; lineNumber++) {
			if (this._context.viewModel.getLineMaxColumn(lineNumber) - 1 > FullFileRenderStrategy.maxSupportedColumns) return false;
		}
		return true;
	}
}
