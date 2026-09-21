import { h } from '../../../base/browser/dom.js';
import { isFiniteNumber } from '../../../base/common/numbers.js';
import { isWrappingIndent, WrappingIndent } from '../../common/config/editorOptions.js';
import { type FontInfo } from '../../common/config/fontInfo.js';
import { CursorColumns } from '../../common/core/cursorColumns.js';
import { getTextGraphemeBoundaries } from '../../common/core/textSegmentation.js';
import { type ILineBreaksComputer, type ILineBreaksComputerContext, type ILineBreaksComputerFactory, ModelLineProjectionData } from '../../common/modelLineProjectionData.js';
import { LineInjectedText } from '../../common/textModelEvents.js';
import { type TextMeasurer } from '../../common/viewModel.js';

/** Browser measurement implementation for the common line-break batch contract. */
export class DOMLineBreaksComputerFactory implements ILineBreaksComputerFactory {
	public static create(targetWindow: Window): DOMLineBreaksComputerFactory {
		return new DOMLineBreaksComputerFactory(new WeakRef(targetWindow));
	}

	constructor(
		private readonly targetWindow: WeakRef<Window>,
		private readonly textMeasurer?: TextMeasurer,
	) {}

	public createLineBreaksComputer(
		context: ILineBreaksComputerContext,
		fontInfo: FontInfo,
		tabSize: number,
		wrappingColumn: number,
		wrappingIndent: WrappingIndent,
		wordBreak: 'normal' | 'keepAll',
		_wrapOnEscapedLineFeeds: boolean,
	): ILineBreaksComputer {
		if (!Number.isSafeInteger(tabSize) || tabSize < 1) throw new RangeError('DOM line-break tab size must be a positive safe integer');
		if (!Number.isSafeInteger(wrappingColumn) || wrappingColumn < -1) throw new RangeError('DOM line-break wrapping column must be -1 or a non-negative safe integer');
		if (!isWrappingIndent(wrappingIndent)) throw new TypeError('Unknown editor wrapping indent mode');
		const requests: number[] = [];
		return {
			addRequest(lineNumber): void {
				if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) throw new RangeError('DOM line-break line number must be a positive safe integer');
				requests.push(lineNumber);
			},
			finalize: (): (ModelLineProjectionData | null)[] => requests.map(lineNumber => computeLineBreaks(
				context,
				lineNumber,
				fontInfo,
				tabSize,
				wrappingColumn,
				wrappingIndent,
				wordBreak,
				this.targetWindow,
				this.textMeasurer,
			)),
		};
	}
}

function computeLineBreaks(
	context: ILineBreaksComputerContext,
	lineNumber: number,
	fontInfo: FontInfo,
	tabSize: number,
	wrappingColumn: number,
	wrappingIndent: WrappingIndent,
	wordBreak: 'normal' | 'keepAll',
	targetWindow: WeakRef<Window>,
	textMeasurer: TextMeasurer | undefined,
): ModelLineProjectionData | null {
	const injectedTexts = context.getLineInjectedText(lineNumber);
	const text = LineInjectedText.applyInjectedText(context.getLineContent(lineNumber), injectedTexts);
	if (wrappingColumn === -1) return injectedTexts ? createProjectionData(text, injectedTexts, [text.length], tabSize, 0) : null;
	const measure = (value: string): number => measureText(targetWindow, textMeasurer, value, fontInfo, tabSize);
	const wrapWidth = wrappingColumn * fontInfo.typicalHalfwidthCharacterWidth;
	const wrappedTextIndentLength = computeWrappedTextIndentLength(text, wrappingColumn, wrappingIndent, tabSize);
	const wrappedTextIndentWidth = wrappedTextIndentLength * fontInfo.spaceWidth;
	const breakOffsets: number[] = [];
	const boundaries = getTextGraphemeBoundaries(text);
	const preferredBreaks = getPreferredBreaks(text, boundaries, wordBreak);
	let startOffset = 0;
	let previousOffset = 0;
	let preferredOffset = 0;
	for (let index = 1; index < boundaries.length; index += 1) {
		const offset = boundaries[index]!;
		if (preferredBreaks.has(previousOffset)) preferredOffset = previousOffset;
		let availableWidth = startOffset === 0 ? wrapWidth : Math.max(0, wrapWidth - wrappedTextIndentWidth);
		while (measure(text.slice(startOffset, offset)) > availableWidth && previousOffset > startOffset) {
			const breakOffset = preferredOffset > startOffset ? preferredOffset : previousOffset;
			startOffset = breakOffset;
			breakOffsets.push(startOffset);
			if (preferredOffset <= startOffset) preferredOffset = 0;
			if (breakOffset === previousOffset) break;
			availableWidth = Math.max(0, wrapWidth - wrappedTextIndentWidth);
		}
		previousOffset = offset;
	}
	breakOffsets.push(text.length);
	return createProjectionData(text, injectedTexts, breakOffsets, tabSize, wrappedTextIndentLength);
}

function getPreferredBreaks(text: string, boundaries: readonly number[], wordBreak: 'normal' | 'keepAll'): ReadonlySet<number> {
	const preferred = new Set<number>();
	let hasContent = false;
	for (let index = 1; index < boundaries.length - 1; index += 1) {
		const offset = boundaries[index]!;
		const before = text.slice(boundaries[index - 1], offset);
		const after = text.slice(offset, boundaries[index + 1]);
		if (/\S/u.test(before)) hasContent = true;
		if (hasContent && /^\s+$/u.test(before)) preferred.add(offset);
		if (!CJK_GRAPHEME.test(before) || !CJK_GRAPHEME.test(after)) continue;
		if (wordBreak === 'normal') preferred.add(offset);
	}
	return preferred;
}

const CJK_GRAPHEME = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function createProjectionData(
	text: string,
	injectedTexts: readonly LineInjectedText[] | null,
	breakOffsets: number[],
	tabSize: number,
	wrappedTextIndentLength: number,
): ModelLineProjectionData {
	return new ModelLineProjectionData(
		injectedTexts ? injectedTexts.map(value => value.column - 1) : null,
		injectedTexts ? injectedTexts.map(value => value.options) : null,
		breakOffsets,
		breakOffsets.map(offset => CursorColumns.visibleColumnFromColumn(text, offset + 1, tabSize)),
		wrappedTextIndentLength,
	);
}

function computeWrappedTextIndentLength(text: string, wrappingColumn: number, wrappingIndent: WrappingIndent, tabSize: number): number {
	if (wrappingIndent === WrappingIndent.None || text.length === 0) return 0;
	let firstNonWhitespaceIndex = 0;
	while (firstNonWhitespaceIndex < text.length && /\s/u.test(text[firstNonWhitespaceIndex]!)) firstNonWhitespaceIndex += 1;
	if (firstNonWhitespaceIndex === text.length) return 0;
	let visibleColumn = 0;
	for (let index = 0; index < firstNonWhitespaceIndex; index += 1) {
		visibleColumn = text.charCodeAt(index) === 9 ? visibleColumn + tabSize - visibleColumn % tabSize : visibleColumn + 1;
	}
	const additionalIndentLevels = wrappingIndent === WrappingIndent.DeepIndent ? 2 : wrappingIndent === WrappingIndent.Indent ? 1 : 0;
	for (let level = 0; level < additionalIndentLevels; level += 1) {
		visibleColumn += tabSize - visibleColumn % tabSize;
	}
	return visibleColumn + 2 > wrappingColumn ? 0 : visibleColumn;
}

function measureWithCanvas(targetWindow: Window | undefined, text: string, fontInfo: FontInfo, tabSize: number): number {
	if (!targetWindow) throw new ReferenceError('DOM line-break factory target window is no longer available');
	const canvas = h(targetWindow.document, 'canvas');
	const context = canvas.getContext('2d');
	if (!context) throw new Error('DOM line-break measurement requires a 2D canvas context');
	context.font = `${fontInfo.fontWeight} ${fontInfo.fontSize}px ${fontInfo.getMassagedFontFamily()}`;
	let width = 0;
	const segments = text.split('\t');
	for (const segment of segments.entries()) {
		const [index, value] = segment;
		width += context.measureText(value).width + [...value].length * fontInfo.letterSpacing;
		if (index + 1 < segments.length) {
			const tabStopWidth = fontInfo.spaceWidth * tabSize;
			width = (Math.floor(width / tabStopWidth) + 1) * tabStopWidth;
		}
	}
	return width;
}

function measureText(targetWindow: WeakRef<Window>, textMeasurer: TextMeasurer | undefined, text: string, fontInfo: FontInfo, tabSize: number): number {
	const width = textMeasurer
		? textMeasurer.measureLineWidth(text)
		: measureWithCanvas(targetWindow.deref(), text, fontInfo, tabSize);
	if (!isFiniteNumber(width) || width < 0) throw new RangeError('DOM line-break measurement must be finite and non-negative');
	return width;
}
