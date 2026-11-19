import { Color } from '../../../../base/common/color.js';
import { Emitter } from '../../../../base/common/event.js';
import { MutableDisposable, toDisposable, type IReference } from '../../../../base/common/lifecycle.js';
import { CursorColumns } from '../../../common/core/cursorColumns.js';
import { editorSelectionForeground } from '../../../common/core/editorColorRegistry.js';
import { type ResolvedSemanticToken } from '../../../common/tokens/languageTokens.js';
import { ViewEventHandler } from '../../../common/viewEventHandler.js';
import { type ViewScrollChangedEvent } from '../../../common/viewEvents.js';
import { type ViewLineRenderingData } from '../../../common/viewModel.js';
import { type InlineDecoration } from '../../../common/viewModel/inlineDecorations.js';
import { type ViewportData } from '../../../common/viewLayout/viewLinesViewportData.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import { type ViewLineOptions } from '../../viewParts/viewLines/viewLineOptions.js';
import { BindingId, type GpuLineGeometry, type IGpuRenderStrategy } from '../gpu.js';
import { BufferDirtyTracker } from '../bufferDirtyTracker.js';
import { createContentSegmenter } from '../contentSegmenter.js';
import { GPULifecycle } from '../gpuDisposable.js';
import { quadVertices } from '../gpuUtils.js';
import { type GlyphRasterizer } from '../raster/glyphRasterizer.js';
import { ViewGpuContext } from '../viewGpuContext.js';
import { fullFileRenderStrategyWgsl } from './fullFileRenderStrategy.wgsl.js';

const FLOATS_PER_CELL = 6;
const BYTES_PER_CELL = FLOATS_PER_CELL * Float32Array.BYTES_PER_ELEMENT;
const emptyCells = new Float32Array(0);

interface GlyphRow extends GpuLineGeometry {
	readonly cells: Float32Array;
	data: ViewLineRenderingData;
	readonly top: number;
	readonly lineHeight: number;
	readonly fixedAdvance: boolean;
	readonly reusable: boolean;
}

/** Owns the glyphs and hit-test geometry of the last visible frame. Strategies choose GPU row addresses. */
export abstract class BaseRenderStrategy extends ViewEventHandler implements IGpuRenderStrategy {
	public abstract readonly type: string;
	public readonly wgsl = fullFileRenderStrategyWgsl;
	public get glyphRasterizer(): GlyphRasterizer { return this.rasterizer.value; }

	private readonly cellBuffer = this._register(new MutableDisposable<IReference<GPUBuffer>>());
	private readonly scrollBuffer: GPUBuffer;
	private readonly scrollOffset = new Float32Array(2);
	private bigNumbersDelta = 0;
	private readonly bindingsChanged = this._register(new Emitter<void>());
	public readonly onDidChangeBindGroupEntries = this.bindingsChanged.event;
	private rows = new Map<number, GlyphRow>();
	public get lineGeometries(): ReadonlyMap<number, GpuLineGeometry> { return this.rows; }
	private staging = new Float32Array(0);
	private gpuCapacity = 0;
	private firstInstance = 0;
	private instanceCount = 0;
	private previousStride = 0;
	private windowStart = 0;

	protected abstract readonly bufferLabel: string;
	protected abstract firstRow(viewport: ViewportData): number;
	protected abstract rowStride(longestRow: number): number;

	public get bindGroupEntries(): GPUBindGroupEntry[] {
		return [
			{ binding: BindingId.Cells, resource: { buffer: this.cellBuffer.value!.object } },
			{ binding: BindingId.ScrollOffset, resource: { buffer: this.scrollBuffer } },
		];
	}

	constructor(
		private readonly context: ViewContext,
		private readonly gpuContext: ViewGpuContext,
		private readonly device: GPUDevice,
		private readonly rasterizer: { value: GlyphRasterizer; },
	) {
		super();
		context.addEventHandler(this);
		this._register(toDisposable(() => context.removeEventHandler(this)));
		this.scrollBuffer = this._register(GPULifecycle.createBuffer(device, {
			label: 'Ash GPU scroll offset', size: this.scrollOffset.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		})).object;
	}

	public override onScrollChanged(event?: ViewScrollChangedEvent): boolean {
		if (this.isDisposed) { return false; }
		const ratio = this.gpuContext.devicePixelRatio.get();
		this.scrollOffset[0] = (event?.scrollLeft ?? this.context.viewLayout.getCurrentScrollLeft()) * ratio;
		this.scrollOffset[1] = ((event?.scrollTop ?? this.context.viewLayout.getCurrentScrollTop()) - this.bigNumbersDelta) * ratio;
		this.device.queue.writeBuffer(this.scrollBuffer, 0, this.scrollOffset);
		return true;
	}

	public override onThemeChanged(): boolean { this.reset(); return true; }
	public reset(): void {
		this.instanceCount = 0;
		this.rows = new Map();
		this.previousStride = 0;
	}

	public update(viewport: ViewportData, options: ViewLineOptions): number {
		this.bigNumbersDelta = viewport.bigNumbersDelta;
		this.onScrollChanged();
		const { rows, longest } = this.encodeViewport(viewport, options);
		this.uploadRows(viewport, rows, this.rowStride(longest));
		this.rows = rows;
		return this.instanceCount;
	}

	private encodeViewport(viewport: ViewportData, options: ViewLineOptions): { rows: Map<number, GlyphRow>; longest: number; } {
		const next = new Map<number, GlyphRow>();
		const foreground = this.context.theme.value.getColor(editorSelectionForeground)?.toNumber32Bit();
		let longest = 0;
		for (let lineNumber = viewport.startLineNumber; lineNumber <= viewport.endLineNumber; lineNumber++) {
			const data = viewport.getViewLineRenderingData(lineNumber);
			if (!this.gpuContext.canRender(options, viewport, lineNumber, data)) { continue; }
			const top = viewport.relativeVerticalOffset[lineNumber - viewport.startLineNumber]!;
			const semantic = this.gpuContext.getSemanticTokens(lineNumber);
			const selected = foreground !== undefined && viewport.selections.some(s => !s.isEmpty() && s.startLineNumber <= lineNumber && s.endLineNumber >= lineNumber);
			// Decorations can change through CSS, and semantic styles can change independently of text.
			// Re-encode styled rows and compare the resulting cells before sending them to the device.
			const reusable = !selected && data.inlineDecorations.length === 0 && semantic.length === 0;
			const previous = this.rows.get(lineNumber - 1);
			const fixedAdvance = options.useMonospaceOptimizations && data.isBasicASCII;
			let row: GlyphRow;
			if (reusable && previous?.reusable && previous.top === top && previous.lineHeight === viewport.lineHeight
				&& previous.newLineWidth === options.spaceWidth && previous.fixedAdvance === fixedAdvance
				&& previous.data.minColumn === data.minColumn && previous.data.tabSize === data.tabSize
				&& previous.data.content === data.content && previous.data.tokens.equals(data.tokens)) {
				// Keep the current token and text backing stores when equal rows survive a document replacement.
				previous.data = data;
				row = previous;
			} else {
				row = this.encodeRow(lineNumber, data, viewport, options, semantic, selected ? foreground : undefined, top, fixedAdvance, reusable);
			}
			next.set(lineNumber - 1, row);
			longest = Math.max(longest, row.cells.length / FLOATS_PER_CELL);
		}
		return { rows: next, longest };
	}

	private uploadRows(viewport: ViewportData, next: ReadonlyMap<number, GlyphRow>, stride: number): void {
		const first = this.firstRow(viewport) * stride;
		const count = (viewport.endLineNumber - viewport.startLineNumber + 1) * stride;
		const required = first + count;
		const block = Math.min(8192, 2 ** Math.ceil(Math.log2(Math.max(1, required))));
		const capacity = Math.max(1, Math.ceil(required / block)) * block;
		// Leave headroom for resizing. Release large buffers once the visible workload is much smaller.
		if (required > this.gpuCapacity || capacity <= this.gpuCapacity / 4 || !this.cellBuffer.value) {
			this.gpuCapacity = capacity;
			this.cellBuffer.value = GPULifecycle.createBuffer(this.device, {
				label: this.bufferLabel, size: this.gpuCapacity * BYTES_PER_CELL, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			});
			this.previousStride = 0;
			this.bindingsChanged.fire();
		}

		// The CPU mirror covers only the drawable window, even for document-relative GPU addresses.
		const rebuild = this.previousStride !== stride || this.firstInstance !== first || this.instanceCount !== count || this.windowStart !== viewport.startLineNumber;
		if (this.staging.length < count * FLOATS_PER_CELL || this.staging.length > 4 * count * FLOATS_PER_CELL) {
			this.staging = new Float32Array(count * FLOATS_PER_CELL);
		} else if (rebuild) {
			this.staging.fill(0, 0, count * FLOATS_PER_CELL);
		}
		const dirty = new BufferDirtyTracker();
		for (let lineNumber = viewport.startLineNumber; lineNumber <= viewport.endLineNumber; lineNumber++) {
			const row = next.get(lineNumber - 1);
			const previous = this.rows.get(lineNumber - 1);
			const offset = (lineNumber - viewport.startLineNumber) * stride * FLOATS_PER_CELL;
			if (rebuild) {
				if (row) { this.staging.set(row.cells, offset); }
			} else if (row === previous || !this.stageChangedCells(offset, row?.cells ?? emptyCells, previous?.cells.length ?? 0, dirty)) {
				// Combine consecutive changed rows in one submission. Unchanged rows separate runs.
				this.uploadDirty(first, dirty);
			}
		}
		if (rebuild && count > 0) { dirty.flag(0, count * FLOATS_PER_CELL); }
		this.uploadDirty(first, dirty);
		this.windowStart = viewport.startLineNumber;
		this.firstInstance = first;
		this.instanceCount = count;
		this.previousStride = stride;
	}

	private stageChangedCells(offset: number, cells: Float32Array, previousLength: number, dirty: BufferDirtyTracker): boolean {
		const length = Math.max(previousLength, cells.length);
		let start = 0;
		while (start < length && this.staging[offset + start] === (cells[start] ?? 0)) { start++; }
		if (start === length) { return false; }
		let end = length;
		while (end > start && this.staging[offset + end - 1] === (cells[end - 1] ?? 0)) { end--; }
		// Keep complete cells together, including old glyphs cleared by deletion or DOM fallback.
		start -= start % FLOATS_PER_CELL;
		end = Math.ceil(end / FLOATS_PER_CELL) * FLOATS_PER_CELL;
		this.staging.set(cells.subarray(start, end), offset + start);
		if (end > cells.length) { this.staging.fill(0, offset + Math.max(start, cells.length), offset + end); }
		dirty.flag(offset + start, end - start);
		return true;
	}

	private uploadDirty(firstInstance: number, dirty: BufferDirtyTracker): void {
		if (!dirty.isDirty) { return; }
		const offset = dirty.dataOffset! * Float32Array.BYTES_PER_ELEMENT;
		this.device.queue.writeBuffer(this.cellBuffer.value!.object, firstInstance * BYTES_PER_CELL + offset,
			this.staging.buffer, offset, dirty.dirtySize! * Float32Array.BYTES_PER_ELEMENT);
		dirty.clear();
	}

	public draw(pass: GPURenderPassEncoder, _viewport: ViewportData): void {
		if (this.instanceCount > 0) { pass.draw(quadVertices.length / 2, this.instanceCount, 0, this.firstInstance); }
	}

	private encodeRow(lineNumber: number, data: ViewLineRenderingData, viewport: ViewportData, options: ViewLineOptions,
		semantic: readonly ResolvedSemanticToken[], foreground: number | undefined, top: number, fixedAdvance: boolean, reusable: boolean): GlyphRow {
		const ratio = this.gpuContext.devicePixelRatio.get();
		const segmenter = createContentSegmenter(data, options);
		const tokens = data.tokens;
		const cells = new Float32Array(data.content.length * FLOATS_PER_CELL);
		const leftByOffset = new Array<number>(data.content.length + 1);
		let x = (data.minColumn - 1) * options.spaceWidth * ratio;
		let tabOffset = 0;
		let glyphCount = 0;
		let semanticIndex = 0;
		let tokenIndex = 0;
		leftByOffset[0] = x / ratio;
		for (let i = 0; i < data.content.length; i++) {
			const chars = segmenter.getSegmentAtIndex(i);
			if (chars === undefined) { continue; }
			const start = x;
			const advance = fixedAdvance ? options.spaceWidth * ratio : this.glyphRasterizer.getTextMetrics(chars === '\t' ? ' ' : chars).width;
			if (chars === '\t') {
				const column = i + tabOffset;
				const next = CursorColumns.nextRenderTabStop(column, data.tabSize);
				x += (next - column) * advance;
				tabOffset = next - i - 1;
			} else {
				x += advance;
			}
			for (let j = i; j < i + chars.length; j++) { leftByOffset[j] = start / ratio; }
			leftByOffset[i + chars.length] = x / ratio;
			if (chars === ' ' || chars === '\t') { continue; }
			while (semanticIndex < semantic.length && semantic[semanticIndex]!.endColumn <= i) { semanticIndex++; }
			while (tokenIndex + 1 < tokens.getCount() && i >= tokens.getEndOffset(tokenIndex)) { tokenIndex++; }
			const token = semantic[semanticIndex];
			const style = this.gpuContext.resolveSemanticStyle(token && token.startColumn <= i ? token : undefined, tokens.getCount() ? tokens.getMetadata(tokenIndex) : 0);
			const selected = foreground !== undefined && viewport.selections.some(s => !s.isEmpty() && s.containsPosition({ lineNumber, column: i + 1 })
				&& (s.endLineNumber !== lineNumber || i + 1 < s.endColumn));
			const styleId = decorationStyleSetId(this.gpuContext, lineNumber, i, data.inlineDecorations, style.color, selected ? foreground : undefined);
			const glyph = this.gpuContext.atlas.getGlyph(this.glyphRasterizer, chars, style.tokenMetadata, styleId, start);
			const index = glyphCount++ * FLOATS_PER_CELL;
			cells[index] = Math.floor(start);
			cells[index + 1] = Math.round(top * ratio + Math.floor((viewport.lineHeight * ratio - glyph.fontBoundingBoxAscent - glyph.fontBoundingBoxDescent) / 2) + glyph.fontBoundingBoxAscent);
			cells[index + 4] = glyph.glyphIndex;
			cells[index + 5] = glyph.pageIndex;
		}
		return { data, top, fixedAdvance, reusable, lineHeight: viewport.lineHeight, cells: cells.subarray(0, glyphCount * FLOATS_PER_CELL), leftByOffset, newLineWidth: options.spaceWidth };
	}
}

function decorationStyleSetId(viewGpuContext: ViewGpuContext, lineNumber: number, columnIndex: number, decorations: readonly InlineDecoration[], semanticColor: number | undefined, selectionColor: number | undefined): number {
	let color = semanticColor;
	let bold: boolean | undefined;
	let opacity: number | undefined;
	let strikethrough: boolean | undefined;
	let strikethroughThickness: number | undefined;
	let strikethroughColor: number | undefined;
	for (const decoration of decorations) {
		if (lineNumber < decoration.range.startLineNumber || lineNumber > decoration.range.endLineNumber) continue;
		if (lineNumber === decoration.range.startLineNumber && columnIndex < decoration.range.startColumn - 1) continue;
		if (lineNumber === decoration.range.endLineNumber && columnIndex >= decoration.range.endColumn - 1) continue;
		for (const rule of ViewGpuContext.decorationCssRuleExtractor.getStyleRules(viewGpuContext.canvas.domNode, decoration.inlineClassName)) {
			for (const property of rule.style) {
				const value = rule.style.getPropertyValue(property).trim();
				switch (property) {
					case 'color': color = Color.Format.CSS.parse(resolveCssColor(viewGpuContext, value))?.toNumber32Bit(); break;
					case 'font-weight': bold = parseFontWeight(value) >= 600; break;
					case 'opacity': opacity = parseOpacity(value); break;
					case 'text-decoration':
					case 'text-decoration-line': strikethrough ||= value.includes('line-through'); break;
					case 'text-decoration-thickness': strikethroughThickness = parsePixelSize(value); break;
					case 'text-decoration-color': strikethroughColor = Color.Format.CSS.parse(resolveCssColor(viewGpuContext, value))?.toNumber32Bit(); break;
				}
			}
		}
	}
	return ViewGpuContext.decorationStyleCache.getOrCreateEntry(selectionColor ?? color, bold, opacity, strikethrough, strikethroughThickness, strikethroughColor);
}

function parseFontWeight(value: string): number {
	if (value === 'bold' || value === 'bolder') return 700;
	if (value === 'normal' || value === 'lighter') return 400;
	return Number.parseInt(value, 10) || 400;
}

function parseOpacity(value: string): number | undefined {
	const parsed = value.endsWith('%') ? Number.parseFloat(value) / 100 : Number.parseFloat(value);
	return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : undefined;
}

function parsePixelSize(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)px$/.exec(value);
	return match ? Number.parseFloat(match[1]!) : undefined;
}

function resolveCssColor(viewGpuContext: ViewGpuContext, value: string): string {
	const match = /^var\((--[^,)]+)(?:,[^)]+)?\)$/.exec(value);
	return match ? ViewGpuContext.decorationCssRuleExtractor.resolveCssVariable(viewGpuContext.canvas.domNode, match[1]!) : value;
}
