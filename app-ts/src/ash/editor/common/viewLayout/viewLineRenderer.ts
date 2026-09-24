import { StringBuilder } from '../core/stringBuilder.js';
import { OffsetRange } from '../core/ranges/offsetRange.js';
import { TextDirection } from '../model.js';
import { IViewLineTokens } from '../tokens/lineTokens.js';
import { InlineDecorationType } from '../viewModel/inlineDecorations.js';
import { LineDecoration } from './lineDecorations.js';

export const enum RenderWhitespace {
	None = 0,
	Boundary = 1,
	Selection = 2,
	Trailing = 3,
	All = 4,
}

export interface IRenderLineInputOptions {
	useMonospaceOptimizations: boolean;
	canUseHalfwidthRightwardsArrow: boolean;
	lineContent: string;
	continuesWithWrappedLine: boolean;
	isBasicASCII: boolean;
	containsRTL: boolean;
	fauxIndentLength: number;
	lineTokens: IViewLineTokens;
	lineDecorations: LineDecoration[];
	tabSize: number;
	startVisibleColumn: number;
	spaceWidth: number;
	middotWidth: number;
	wsmiddotWidth: number;
	stopRenderingLineAfter: number;
	renderWhitespace: 'none' | 'boundary' | 'selection' | 'trailing' | 'all';
	renderControlCharacters: boolean;
	fontLigatures: boolean;
	selectionsOnLine: OffsetRange[] | null;
	textDirection: TextDirection | null;
	verticalScrollbarSize: number;
	renderNewLineWhenEmpty: boolean;
}

/** Immutable description of one logical line rendering pass. */
export class RenderLineInput {
	public readonly renderWhitespace: RenderWhitespace;
	public readonly renderSpaceWidth: number;
	public readonly renderSpaceCharCode: number;
	public readonly lineDecorations: LineDecoration[];
	public readonly selectionsOnLine: OffsetRange[] | null;

	constructor(
		public readonly useMonospaceOptimizations: boolean,
		public readonly canUseHalfwidthRightwardsArrow: boolean,
		public readonly lineContent: string,
		public readonly continuesWithWrappedLine: boolean,
		public readonly isBasicASCII: boolean,
		public readonly containsRTL: boolean,
		public readonly fauxIndentLength: number,
		public readonly lineTokens: IViewLineTokens,
		lineDecorations: LineDecoration[],
		public readonly tabSize: number,
		public readonly startVisibleColumn: number,
		public readonly spaceWidth: number,
		middotWidth: number,
		wsmiddotWidth: number,
		public readonly stopRenderingLineAfter: number,
		renderWhitespace: 'none' | 'boundary' | 'selection' | 'trailing' | 'all',
		public readonly renderControlCharacters: boolean,
		public readonly fontLigatures: boolean,
		selectionsOnLine: OffsetRange[] | null,
		public readonly textDirection: TextDirection | null,
		public readonly verticalScrollbarSize: number,
		public readonly renderNewLineWhenEmpty = false,
	) {
		this.lineDecorations = [...lineDecorations].sort(LineDecoration.compare);
		this.selectionsOnLine = selectionsOnLine ? [...selectionsOnLine].sort((a, b) => a.start - b.start) : null;
		this.renderWhitespace = whitespaceMode(renderWhitespace);
		const useWordSeparator = Math.abs(wsmiddotWidth - spaceWidth) < Math.abs(middotWidth - spaceWidth);
		this.renderSpaceWidth = useWordSeparator ? wsmiddotWidth : middotWidth;
		this.renderSpaceCharCode = useWordSeparator ? 0x2E31 : 0xB7;
	}

	get isLTR(): boolean {
		return !this.containsRTL && this.textDirection !== TextDirection.RTL;
	}

	equals(other: RenderLineInput): boolean {
		return this.useMonospaceOptimizations === other.useMonospaceOptimizations
			&& this.canUseHalfwidthRightwardsArrow === other.canUseHalfwidthRightwardsArrow
			&& this.lineContent === other.lineContent
			&& this.continuesWithWrappedLine === other.continuesWithWrappedLine
			&& this.isBasicASCII === other.isBasicASCII
			&& this.containsRTL === other.containsRTL
			&& this.fauxIndentLength === other.fauxIndentLength
			&& this.lineTokens.equals(other.lineTokens)
			&& LineDecoration.equalsArr(this.lineDecorations, other.lineDecorations)
			&& this.tabSize === other.tabSize
			&& this.startVisibleColumn === other.startVisibleColumn
			&& this.spaceWidth === other.spaceWidth
			&& this.renderSpaceWidth === other.renderSpaceWidth
			&& this.renderSpaceCharCode === other.renderSpaceCharCode
			&& this.stopRenderingLineAfter === other.stopRenderingLineAfter
			&& this.renderWhitespace === other.renderWhitespace
			&& this.renderControlCharacters === other.renderControlCharacters
			&& this.fontLigatures === other.fontLigatures
			&& sameRanges(this.selectionsOnLine, other.selectionsOnLine)
			&& this.textDirection === other.textDirection
			&& this.verticalScrollbarSize === other.verticalScrollbarSize
			&& this.renderNewLineWhenEmpty === other.renderNewLineWhenEmpty;
	}
}

export class DomPosition {
	constructor(public readonly partIndex: number, public readonly charIndex: number) {}
}

/** Bidirectional mapping between one-based source columns and rendered span positions. */
export class CharacterMapping {
	public readonly length: number;
	private readonly positions: DomPosition[];
	private readonly horizontalOffsets: number[];

	constructor(length: number, _partCount: number) {
		this.length = Math.max(0, length);
		this.positions = Array.from({ length: this.length }, () => new DomPosition(0, 0));
		this.horizontalOffsets = Array.from({ length: this.length }, () => 0);
	}

	setColumnInfo(column: number, partIndex: number, charIndex: number, horizontalOffset: number): void {
		if (column < 1 || column > this.length) return;
		this.positions[column - 1] = new DomPosition(partIndex, charIndex);
		this.horizontalOffsets[column - 1] = horizontalOffset;
	}

	getHorizontalOffset(column: number): number {
		if (this.length === 0) return 0;
		return this.horizontalOffsets[clamp(column - 1, 0, this.length - 1)]!;
	}

	getDomPosition(column: number): DomPosition {
		if (this.length === 0) return new DomPosition(0, 0);
		return this.positions[clamp(column - 1, 0, this.length - 1)]!;
	}

	getColumn(position: DomPosition, partLength: number): number {
		if (this.length === 0) return 1;
		let lastIndexInPart = -1;
		let lastCharInPart = -1;
		for (let index = 0; index < this.positions.length; index++) {
			const candidate = this.positions[index]!;
			if (candidate.partIndex !== position.partIndex) continue;
			if (candidate.charIndex === position.charIndex) return index + 1;
			if (candidate.charIndex > lastCharInPart) {
				lastIndexInPart = index;
				lastCharInPart = candidate.charIndex;
			}
		}
		if (position.charIndex >= partLength && lastIndexInPart >= 0 && lastIndexInPart + 1 < this.positions.length) {
			return lastIndexInPart + 2;
		}
		let nearestIndex = 0;
		let nearestDistance = Number.POSITIVE_INFINITY;
		const targetChar = clamp(position.charIndex, 0, partLength);
		for (let index = 0; index < this.positions.length; index++) {
			const candidate = this.positions[index]!;
			const partDistance = Math.abs(candidate.partIndex - position.partIndex);
			const distance = partDistance * 0x10000 + Math.abs(candidate.charIndex - targetChar);
			if (distance < nearestDistance) {
				nearestDistance = distance;
				nearestIndex = index;
			}
		}
		return nearestIndex + 1;
	}

	inflate(): [number, number, number][] {
		return this.positions.map((position, index) => [position.partIndex, position.charIndex, this.horizontalOffsets[index]!]);
	}
}

export const enum ForeignElementType {
	None = 0,
	Before = 1,
	After = 2,
}

export class RenderLineOutput {
	_renderLineOutputBrand: void = undefined;
	constructor(
		readonly characterMapping: CharacterMapping,
		readonly containsForeignElements: ForeignElementType,
	) {}
}

export class RenderLineOutput2 {
	constructor(
		public readonly characterMapping: CharacterMapping,
		public readonly html: string,
		public readonly containsForeignElements: ForeignElementType,
	) {}
}

export function renderViewLine(input: RenderLineInput, builder: StringBuilder): RenderLineOutput {
	const rendered = render(input);
	builder.appendString(rendered.html);
	return new RenderLineOutput(rendered.mapping, rendered.foreignElements);
}

export function renderViewLine2(input: RenderLineInput): RenderLineOutput2 {
	const builder = new StringBuilder(10_000);
	const output = renderViewLine(input, builder);
	return new RenderLineOutput2(output.characterMapping, builder.build(), output.containsForeignElements);
}

interface RenderedLine {
	readonly html: string;
	readonly mapping: CharacterMapping;
	readonly foreignElements: ForeignElementType;
}

function render(input: RenderLineInput): RenderedLine {
	if (input.lineContent.length === 0) return renderEmpty(input);
	const limit = input.stopRenderingLineAfter < 0 ? input.lineContent.length : Math.min(input.lineContent.length, input.stopRenderingLineAfter);
	const text = input.lineContent.slice(0, limit);
	const boundaries = collectBoundaries(input, limit);
	const mapping = new CharacterMapping(text.length + 1, boundaries.length);
	const trailingStart = text.search(/\s*$/);
	let visibleColumn = input.startVisibleColumn;
	let partIndex = 0;
	let foreignElements = ForeignElementType.None;
	const parts: string[] = [];

	for (let boundaryIndex = 0; boundaryIndex + 1 < boundaries.length; boundaryIndex++) {
		const start = boundaries[boundaryIndex]!;
		const end = boundaries[boundaryIndex + 1]!;
		const pseudo = input.lineDecorations.filter(decoration => decoration.startColumn - 1 === start && isForeign(decoration.type));
		for (const decoration of pseudo) {
			parts.push(`<span class="${escapeAttribute(decoration.className)}"></span>`);
			foreignElements |= decoration.type === InlineDecorationType.After ? ForeignElementType.After : ForeignElementType.Before;
			partIndex++;
		}
		if (end <= start) continue;
		const classes = classesAt(input, start);
		let content = '';
		let charIndex = 0;
		for (let offset = start; offset < end; offset++) {
			mapping.setColumnInfo(offset + 1, partIndex, charIndex, visibleColumn);
			const cell = renderCell(input, text, offset, visibleColumn, trailingStart);
			content += cell.html;
			charIndex += cell.domLength;
			visibleColumn += cell.width;
		}
		parts.push(classes.length > 0
			? `<span class="${escapeAttribute(classes.join(' '))}">${content}</span>`
			: `<span>${content}</span>`);
		if (end === text.length) mapping.setColumnInfo(text.length + 1, partIndex, charIndex, visibleColumn);
		partIndex++;
	}

	if (limit < input.lineContent.length) parts.push('<span class="mtkcontrol">…</span>');
	const direction = input.textDirection === TextDirection.RTL ? ' dir="rtl"' : '';
	return {
		html: `<span class="stanza-editor-line-text"${direction}>${parts.join('')}</span>`,
		mapping,
		foreignElements,
	};
}

function renderEmpty(input: RenderLineInput): RenderedLine {
	const decorations = input.lineDecorations.filter(decoration => isForeign(decoration.type));
	let foreignElements = ForeignElementType.None;
	const spans = decorations.map(decoration => {
		foreignElements |= decoration.type === InlineDecorationType.After ? ForeignElementType.After : ForeignElementType.Before;
		return `<span class="${escapeAttribute(decoration.className)}"></span>`;
	}).join('');
	if (decorations.length > 0) {
		const mapping = new CharacterMapping(1, decorations.length);
		mapping.setColumnInfo(1, decorations.filter(decoration => decoration.type !== InlineDecorationType.After).length, 0, 0);
		return { html: `<span>${spans}</span>`, mapping, foreignElements };
	}
	return {
		html: input.renderNewLineWhenEmpty ? '<span><span>\n</span></span>' : '<span><span></span></span>',
		mapping: new CharacterMapping(0, 0),
		foreignElements,
	};
}

function collectBoundaries(input: RenderLineInput, length: number): number[] {
	const boundaries = new Set<number>([0, length]);
	for (let index = 0; index < input.lineTokens.getCount(); index++) boundaries.add(clamp(input.lineTokens.getEndOffset(index), 0, length));
	for (const decoration of input.lineDecorations) {
		boundaries.add(clamp(decoration.startColumn - 1, 0, length));
		boundaries.add(clamp(decoration.endColumn - 1, 0, length));
	}
	return [...boundaries].sort((a, b) => a - b);
}

function classesAt(input: RenderLineInput, offset: number): string[] {
	const classes: string[] = [];
	const tokenIndex = input.lineTokens.findTokenIndexAtOffset(offset);
	const tokenClass = input.lineTokens.getCount() > 0 ? input.lineTokens.getClassName(tokenIndex) : '';
	if (tokenClass) classes.push(tokenClass);
	for (const decoration of input.lineDecorations) {
		if (isForeign(decoration.type)) continue;
		if (decoration.startColumn - 1 <= offset && offset < decoration.endColumn - 1) classes.push(decoration.className);
	}
	return classes;
}

interface RenderedCell { readonly html: string; readonly domLength: number; readonly width: number }

function renderCell(input: RenderLineInput, text: string, offset: number, visibleColumn: number, trailingStart: number): RenderedCell {
	const code = text.charCodeAt(offset);
	if (code === 9) {
		const width = input.tabSize - visibleColumn % input.tabSize;
		const show = shouldRenderWhitespace(input, offset, trailingStart);
		const marker = input.canUseHalfwidthRightwardsArrow ? '→' : '→';
		const value = show ? marker + '\u00a0'.repeat(Math.max(0, width - 1)) : '\u00a0'.repeat(width);
		return { html: escapeText(value), domLength: value.length, width };
	}
	if (code === 32) {
		const show = shouldRenderWhitespace(input, offset, trailingStart);
		const value = show ? String.fromCharCode(input.renderSpaceCharCode) : '\u00a0';
		return { html: escapeText(value), domLength: 1, width: 1 };
	}
	if (input.renderControlCharacters && (code < 32 || code === 127)) {
		const value = code === 127 ? '␡' : String.fromCharCode(0x2400 + code);
		return { html: escapeText(value), domLength: value.length, width: 1 };
	}
	const value = text[offset]!;
	return { html: escapeText(value), domLength: 1, width: 1 };
}

function shouldRenderWhitespace(input: RenderLineInput, offset: number, trailingStart: number): boolean {
	switch (input.renderWhitespace) {
		case RenderWhitespace.All: return true;
		case RenderWhitespace.Trailing: return offset >= trailingStart;
		case RenderWhitespace.Selection: return input.selectionsOnLine?.some(range => range.start <= offset && offset < range.endExclusive) ?? false;
		case RenderWhitespace.Boundary: {
			const text = input.lineContent;
			return offset >= trailingStart || offset === 0 || offset === text.length - 1 || !/\s/.test(text[offset - 1]!) || !/\s/.test(text[offset + 1]!);
		}
		default: return false;
	}
}

function whitespaceMode(value: IRenderLineInputOptions['renderWhitespace']): RenderWhitespace {
	if (value === 'all') return RenderWhitespace.All;
	if (value === 'boundary') return RenderWhitespace.Boundary;
	if (value === 'selection') return RenderWhitespace.Selection;
	if (value === 'trailing') return RenderWhitespace.Trailing;
	return RenderWhitespace.None;
}

function sameRanges(left: readonly OffsetRange[] | null, right: readonly OffsetRange[] | null): boolean {
	if (left === null || right === null) return left === right;
	return left.length === right.length && left.every((range, index) => range.equals(right[index]!));
}

function isForeign(type: InlineDecorationType): boolean {
	return type === InlineDecorationType.Before || type === InlineDecorationType.After || type === InlineDecorationType.WidthOnly;
}

function escapeText(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\u00a0', '&nbsp;');
}

function escapeAttribute(value: string): string {
	return escapeText(value).replaceAll('"', '&quot;');
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}
