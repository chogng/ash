import { Color } from '../../../../base/common/color.js';
import { CursorColumns } from '../../../common/core/cursorColumns.js';
import { type ViewConfigurationChangedEvent, type ViewDecorationsChangedEvent, type ViewLineMappingChangedEvent, type ViewLinesChangedEvent, type ViewLinesDeletedEvent, type ViewLinesInsertedEvent, type ViewScrollChangedEvent, type ViewThemeChangedEvent, type ViewTokensChangedEvent, type ViewZonesChangedEvent } from '../../../common/viewEvents.js';
import { type ViewportData } from '../../../common/viewLayout/viewLinesViewportData.js';
import { type InlineDecoration } from '../../../common/viewModel/inlineDecorations.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import { type ViewLineOptions } from '../../viewParts/viewLines/viewLineOptions.js';
import { BindingId } from '../gpu.js';
import { GPULifecycle } from '../gpuDisposable.js';
import { quadVertices } from '../gpuUtils.js';
import { createContentSegmenter } from '../contentSegmenter.js';
import { type GlyphRasterizer } from '../raster/glyphRasterizer.js';
import { ViewGpuContext } from '../viewGpuContext.js';
import { BaseRenderStrategy } from './baseRenderStrategy.js';
import { fullFileRenderStrategyWgsl } from './fullFileRenderStrategy.wgsl.js';

const FLOATS_PER_CELL = 6;


function writeCells(
	viewGpuContext: ViewGpuContext,
	glyphRasterizer: GlyphRasterizer,
	viewportData: ViewportData,
	viewLineOptions: ViewLineOptions,
	target: Float32Array,
	targetStartLineNumber: number,
	maximumColumns: number,
): number {
	const devicePixelRatio = viewGpuContext.devicePixelRatio.get();
	for (let lineNumber = viewportData.startLineNumber; lineNumber <= viewportData.endLineNumber; lineNumber++) {
		if (!viewGpuContext.canRender(viewLineOptions, viewportData, lineNumber)) continue;
		const lineData = viewportData.getViewLineRenderingData(lineNumber);
		const segmenter = createContentSegmenter(lineData, viewLineOptions);
		const tokens = lineData.tokens;
		const semanticTokens = viewGpuContext.getSemanticTokens(lineNumber);
		let semanticIndex = 0;
		let tokenIndex = 0;
		let tokenEndOffset = tokens.getCount() > 0 ? tokens.getEndOffset(0) : lineData.content.length;
		let absoluteOffsetX = (lineData.minColumn - 1) * viewLineOptions.spaceWidth * devicePixelRatio;
		let tabColumnOffset = 0;
		const lineTop = viewportData.relativeVerticalOffset[lineNumber - viewportData.startLineNumber]! * devicePixelRatio;
		for (let columnIndex = 0; columnIndex < lineData.content.length && columnIndex < maximumColumns; columnIndex++) {
			while (semanticIndex < semanticTokens.length && semanticTokens[semanticIndex]!.endColumn <= columnIndex) semanticIndex++;
			while (tokenIndex + 1 < tokens.getCount() && columnIndex >= tokenEndOffset) {
				tokenIndex++;
				tokenEndOffset = tokens.getEndOffset(tokenIndex);
			}
			const chars = segmenter.getSegmentAtIndex(columnIndex);
			if (chars === undefined) continue;
			const useFixedAdvance = lineData.isBasicASCII && viewLineOptions.useMonospaceOptimizations;
			const advance = useFixedAdvance
				? viewLineOptions.spaceWidth * devicePixelRatio
				: glyphRasterizer.getTextMetrics(chars === '\t' ? ' ' : chars).width;
			if (chars === '\t') {
				const previousColumn = columnIndex + tabColumnOffset;
				const nextColumn = CursorColumns.nextRenderTabStop(previousColumn, lineData.tabSize);
				absoluteOffsetX += advance * (nextColumn - previousColumn);
				tabColumnOffset = nextColumn - columnIndex - 1;
				continue;
			}
			if (chars === ' ') {
				absoluteOffsetX += advance;
				continue;
			}
			const semanticToken = semanticTokens[semanticIndex];
			const style = viewGpuContext.resolveSemanticStyle(semanticToken && semanticToken.startColumn <= columnIndex ? semanticToken : undefined, tokens.getCount() > 0 ? tokens.getMetadata(tokenIndex) : 0);
			const styleSetId = decorationStyleSetId(viewGpuContext, lineNumber, columnIndex, lineData.inlineDecorations, style.color);
			const glyph = viewGpuContext.atlas.getGlyph(glyphRasterizer, chars, style.tokenMetadata, styleSetId, absoluteOffsetX);
			const baseline = Math.round(
				lineTop + Math.floor((viewportData.lineHeight * devicePixelRatio - glyph.fontBoundingBoxAscent - glyph.fontBoundingBoxDescent) / 2) + glyph.fontBoundingBoxAscent,
			);
			const cellIndex = ((lineNumber - targetStartLineNumber) * maximumColumns + columnIndex) * FLOATS_PER_CELL;
			if (cellIndex < 0 || cellIndex + FLOATS_PER_CELL > target.length) continue;
			target[cellIndex] = Math.floor(absoluteOffsetX);
			target[cellIndex + 1] = baseline;
			target[cellIndex + 4] = glyph.glyphIndex;
			target[cellIndex + 5] = glyph.pageIndex;
			absoluteOffsetX += advance;
		}
	}
	return (viewportData.endLineNumber - viewportData.startLineNumber + 1) * maximumColumns;
}

function decorationStyleSetId(viewGpuContext: ViewGpuContext, lineNumber: number, columnIndex: number, decorations: readonly InlineDecoration[], semanticColor: number | undefined): number {
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
	return ViewGpuContext.decorationStyleCache.getOrCreateEntry(color, bold, opacity, strikethrough, strikethroughThickness, strikethroughColor);
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

export class FullFileRenderStrategy extends BaseRenderStrategy {
	public static readonly maxSupportedLines = 3_000;
	public static readonly maxSupportedColumns = 200;
	public readonly type = 'fullfile';
	public readonly wgsl = fullFileRenderStrategyWgsl;
	private readonly _cellBindBuffer: GPUBuffer;
	private readonly _scrollOffsetBindBuffer: GPUBuffer;
	private readonly _scrollOffsetValueBuffer = new Float32Array(2);
	private _bigNumbersDelta = 0;
	private _visibleObjectCount = 0;

	public get bindGroupEntries(): GPUBindGroupEntry[] {
		return [
			{ binding: BindingId.Cells, resource: { buffer: this._cellBindBuffer } },
			{ binding: BindingId.ScrollOffset, resource: { buffer: this._scrollOffsetBindBuffer } },
		];
	}

	constructor(context: ViewContext, viewGpuContext: ViewGpuContext, device: GPUDevice, glyphRasterizer: { value: GlyphRasterizer }) {
		super(context, viewGpuContext, device, glyphRasterizer);
		this._cellBindBuffer = this._register(GPULifecycle.createBuffer(device, {
			label: 'Ash full-file GPU cells',
			size: FullFileRenderStrategy.maxSupportedLines * FullFileRenderStrategy.maxSupportedColumns * FLOATS_PER_CELL * Float32Array.BYTES_PER_ELEMENT,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		})).object;
		this._scrollOffsetBindBuffer = this._register(GPULifecycle.createBuffer(device, {
			label: 'Ash full-file GPU scroll offset',
			size: this._scrollOffsetValueBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		})).object;
	}

	public override onConfigurationChanged(_event: ViewConfigurationChangedEvent): boolean { this.reset(); return true; }
	public override onDecorationsChanged(_event: ViewDecorationsChangedEvent): boolean { this.reset(); return true; }
	public override onLineMappingChanged(_event: ViewLineMappingChangedEvent): boolean { this.reset(); return true; }
	public override onLinesChanged(_event: ViewLinesChangedEvent): boolean { this.reset(); return true; }
	public override onLinesDeleted(_event: ViewLinesDeletedEvent): boolean { this.reset(); return true; }
	public override onLinesInserted(_event: ViewLinesInsertedEvent): boolean { this.reset(); return true; }
	public override onThemeChanged(_event: ViewThemeChangedEvent): boolean { this.reset(); return true; }
	public override onTokensChanged(_event: ViewTokensChangedEvent): boolean { this.reset(); return true; }
	public override onZonesChanged(_event: ViewZonesChangedEvent): boolean { this.reset(); return true; }

	public override onScrollChanged(event?: ViewScrollChangedEvent): boolean {
		if (this.isDisposed) return false;
		const devicePixelRatio = this._viewGpuContext.devicePixelRatio.get();
		this._scrollOffsetValueBuffer[0] = (event?.scrollLeft ?? this._context.viewLayout.getCurrentScrollLeft()) * devicePixelRatio;
		this._scrollOffsetValueBuffer[1] = ((event?.scrollTop ?? this._context.viewLayout.getCurrentScrollTop()) - this._bigNumbersDelta) * devicePixelRatio;
		this._device.queue.writeBuffer(this._scrollOffsetBindBuffer, 0, this._scrollOffsetValueBuffer as Float32Array<ArrayBuffer>);
		return true;
	}

	public reset(): void {
		this._visibleObjectCount = 0;
	}

	public update(viewportData: ViewportData, viewLineOptions: ViewLineOptions): number {
		this._bigNumbersDelta = viewportData.bigNumbersDelta;
		this.onScrollChanged();
		const lineCount = viewportData.endLineNumber - viewportData.startLineNumber + 1;
		const cells = new Float32Array(lineCount * FullFileRenderStrategy.maxSupportedColumns * FLOATS_PER_CELL);
		this._visibleObjectCount = writeCells(this._viewGpuContext, this.glyphRasterizer, viewportData, viewLineOptions, cells, viewportData.startLineNumber, FullFileRenderStrategy.maxSupportedColumns);
		const rowByteLength = FullFileRenderStrategy.maxSupportedColumns * FLOATS_PER_CELL * Float32Array.BYTES_PER_ELEMENT;
		for (let lineOffset = 0; lineOffset < lineCount; lineOffset++) {
			this._device.queue.writeBuffer(
				this._cellBindBuffer,
				(viewportData.startLineNumber - 1 + lineOffset) * rowByteLength,
				cells.buffer,
				lineOffset * rowByteLength,
				rowByteLength,
			);
		}
		return this._visibleObjectCount;
	}

	public draw(pass: GPURenderPassEncoder, viewportData: ViewportData): void {
		if (this._visibleObjectCount === 0) return;
		pass.draw(
			quadVertices.length / 2,
			this._visibleObjectCount,
			0,
			(viewportData.startLineNumber - 1) * FullFileRenderStrategy.maxSupportedColumns,
		);
	}
}
