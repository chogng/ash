import * as dom from '../../../../base/browser/dom.js';
import { FastDomNode, createFastDomNode } from '../../../../base/browser/fastDomNode.js';
import * as strings from '../../../../base/common/strings.js';
import { applyFontInfo } from '../../config/domFontInfo.js';
import { EditorOption, TextEditorCursorStyle } from '../../../common/config/editorOptions.js';
import { Selection } from '../../../common/core/selection.js';
import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { TextDirection } from '../../../common/model.js';
import { type TextModel } from '../../../common/model/textModel.js';
import { type SemanticTokenSource } from '../../../common/tokens/languageTokens.js';
import { createStanzaVisualSelectionGeometry } from '../../../common/viewModel/visualSelectionGeometry.js';
import { type HorizontalRange, type RenderingContext } from '../../view/renderingContext.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import { type EditorVisualLineProjection } from '../../../common/viewModel/modelLineProjection.js';
import { type ViewConfigurationChangedEvent } from '../../../common/viewEvents.js';
import { type TextMeasurer } from '../../../common/viewModel.js';

export interface ViewCursorOptions {
	readonly readVisualProjection: () => EditorVisualLineProjection;
	readonly readTextLeft: () => number;
	readonly textMeasurer: TextMeasurer;
}

export interface IViewCursorRenderData {
	domNode: HTMLElement;
	position: Position;
	contentLeft: number;
	width: number;
	height: number;
}

export enum CursorPlurality {
	Single,
	MultiPrimary,
	MultiSecondary,
}

interface ViewCursorCharacterPresentation {
	readonly classNames: readonly string[];
	readonly fontStyle?: string;
	readonly fontWeight?: string;
	readonly textDecoration?: string;
}

class ViewCursorRenderData {
	constructor(
		public readonly top: number,
		public readonly left: number,
		public readonly paddingLeft: number,
		public readonly width: number,
		public readonly height: number,
		public readonly textContent: string,
		public readonly presentation: ViewCursorCharacterPresentation | undefined,
	) {}
}

interface CursorGrapheme {
	readonly position: Position;
	readonly endColumn: number;
	readonly character: string;
}

interface DomCaretGeometry {
	readonly visualLineIndex: number;
	readonly left: number;
	readonly isRightToLeft: boolean;
	readonly characterRange?: HorizontalRange;
}

/** Owns one retained caret, its position, rendering data, and DOM writes. */
export class ViewCursor {
	private readonly fastDomNode: FastDomNode<HTMLDivElement>;
	private isVisible = true;
	private position = new Position((0) + 1, (0) + 1);
	private plurality = CursorPlurality.Single;
	private style: TextEditorCursorStyle;
	private lineWidth: number;
	private lineHeight: number;
	private renderData: ViewCursorRenderData | undefined;
	private lastRenderedContent = '';
	private readonly readVisualProjection: () => EditorVisualLineProjection;
	private readonly readTextLeft: () => number;
	private readonly textMeasurer: TextMeasurer;
	private readonly isRightToLeftAtPosition: (position: Position) => boolean;

	constructor(
		private readonly context: ViewContext,
		host: HTMLElement,
		selectionIndex: number,
		options: ViewCursorOptions,
		private readonly model: TextModel,
		private readonly semanticTokenSource: SemanticTokenSource | undefined,
		plurality: CursorPlurality,
	) {
		const configuration = context.configuration.options;
		const fontInfo = configuration.get(EditorOption.fontInfo);
		this.readVisualProjection = options.readVisualProjection;
		this.readTextLeft = options.readTextLeft;
		this.textMeasurer = options.textMeasurer;
		this.isRightToLeftAtPosition = position => context.viewModel.getTextDirection(position.lineNumber) === TextDirection.RTL;
		this.style = configuration.get(EditorOption.effectiveCursorStyle);
		this.lineWidth = Math.min(configuration.get(EditorOption.cursorWidth), fontInfo.typicalHalfwidthCharacterWidth);
		this.lineHeight = configuration.get(EditorOption.cursorHeight);
		this.fastDomNode = createFastDomNode(dom.h(host.ownerDocument, 'div'));
		this.fastDomNode.setClassName('cursor stanza-editor-caret');
		this.fastDomNode.setAttribute('data-selection-index', String(selectionIndex));
		this.fastDomNode.setAttribute('aria-hidden', 'true');
		this.fastDomNode.setHeight(this.context.configuration.options.get(EditorOption.lineHeight));
		this.fastDomNode.setTop(0);
		this.fastDomNode.setLeft(0);
		applyFontInfo(this.fastDomNode, fontInfo);
		this.fastDomNode.setDisplay('none');
		this.setPlurality(plurality);
		host.append(this.fastDomNode.domNode);
	}

	public getDomNode(): FastDomNode<HTMLElement> {
		return this.fastDomNode;
	}

	public getPosition(): Position {
		return this.position;
	}

	public setPlurality(plurality: CursorPlurality): void {
		this.plurality = plurality;
	}

	public show(): void {
		if (this.isVisible) return;
		this.fastDomNode.setVisibility('inherit');
		this.isVisible = true;
	}

	public hide(): void {
		if (!this.isVisible) return;
		this.fastDomNode.setVisibility('hidden');
		this.isVisible = false;
	}

	public onConfigurationChanged(_event: ViewConfigurationChangedEvent): boolean {
		const options = this.context.configuration.options;
		const fontInfo = options.get(EditorOption.fontInfo);
		this.style = options.get(EditorOption.effectiveCursorStyle);
		this.lineWidth = Math.min(options.get(EditorOption.cursorWidth), fontInfo.typicalHalfwidthCharacterWidth);
		this.lineHeight = options.get(EditorOption.cursorHeight);
		applyFontInfo(this.fastDomNode, fontInfo);
		return true;
	}

	public onCursorPositionChanged(position: Position, pauseAnimation: boolean): boolean {
		this.fastDomNode.domNode.style.transitionProperty = pauseAnimation ? 'none' : '';
		this.position = position;
		return true;
	}

	public prepareRender(context: RenderingContext): void {
		const grapheme = this.getGraphemeAwarePosition();
		const caret = this.getCaretGeometry(context, grapheme);
		if (!caret) {
			this.renderData = undefined;
			return;
		}
		const characterWidth = caret.characterRange?.width ?? this.getCharacterWidth(grapheme);
		const characterLeft = caret.characterRange?.left ?? (caret.isRightToLeft ? caret.left - characterWidth : caret.left);
		const width = cursorWidth(dom.getWindow(this.fastDomNode.domNode), this.style, this.lineWidth, characterWidth);
		let left = cursorLeft(this.style, caret.left, characterLeft);
		let paddingLeft = 0;
		if (this.style === TextEditorCursorStyle.Line && width >= 2 && left >= 1) {
			paddingLeft = 1;
			left -= paddingLeft;
		}
		const rowHeight = context.viewportData.lineHeight;
		const height = cursorHeight(this.style, this.lineHeight, rowHeight);
		const rendersCharacter = this.style === TextEditorCursorStyle.Block || (this.style === TextEditorCursorStyle.Line && width > 2);
		this.renderData = new ViewCursorRenderData(
			context.getVerticalOffsetForLineNumber(caret.visualLineIndex + 1) + cursorTop(this.style, rowHeight, height),
			left,
			paddingLeft,
			width,
			height,
			rendersCharacter ? grapheme.character : '',
			rendersCharacter ? this.getCharacterPresentation(grapheme.position) : undefined,
		);
	}

	public render(_context: RenderingContext): IViewCursorRenderData | null {
		const renderData = this.renderData;
		if (!renderData) {
			this.fastDomNode.setDisplay('none');
			return null;
		}
		this.fastDomNode.setClassName([
			'cursor',
			'stanza-editor-caret',
			cursorStyleClass(this.style),
			this.plurality === CursorPlurality.MultiSecondary ? '' : 'primary',
			cursorPluralityClass(this.plurality),
			...(renderData.presentation?.classNames ?? []),
		].filter(Boolean).join(' '));
		if (this.lastRenderedContent !== renderData.textContent) {
			this.lastRenderedContent = renderData.textContent;
			this.fastDomNode.domNode.textContent = renderData.textContent;
		}
		this.fastDomNode.setFontStyle(renderData.presentation?.fontStyle ?? '');
		this.fastDomNode.setFontWeight(renderData.presentation?.fontWeight ?? '');
		this.fastDomNode.domNode.style.textDecorationLine = renderData.presentation?.textDecoration ?? '';
		this.fastDomNode.setDisplay('block');
		this.fastDomNode.setTop(renderData.top);
		this.fastDomNode.setLeft(renderData.left);
		this.fastDomNode.setPaddingLeft(renderData.paddingLeft);
		this.fastDomNode.setWidth(renderData.width);
		this.fastDomNode.setHeight(renderData.height);
		this.fastDomNode.setLineHeight(renderData.height);
		return Object.freeze({
			domNode: this.fastDomNode.domNode,
			position: this.position,
			contentLeft: renderData.left,
			width: 2,
			height: renderData.height,
		});
	}

	private getGraphemeAwarePosition(): CursorGrapheme {
		const line = this.context.viewModel.getLineContent(this.position.lineNumber);
		if (this.position.column > line.length) {
			return Object.freeze({ position: this.position, endColumn: this.position.column, character: '\u00a0' });
		}
		const [startColumnIndex, endColumnIndexExclusive] = strings.getCharContainingOffset(line, this.position.column - 1);
		return Object.freeze({
			position: new Position(this.position.lineNumber, startColumnIndex + 1),
			endColumn: endColumnIndexExclusive + 1,
			character: endColumnIndexExclusive === startColumnIndex ? '\u00a0' : line.slice(startColumnIndex, endColumnIndexExclusive),
		});
	}

	private getCaretGeometry(context: RenderingContext, grapheme: CursorGrapheme): DomCaretGeometry | undefined {
		const caret = context.visibleRangeForPosition(grapheme.position);
		if (caret) {
			const visualLineIndex = grapheme.position.lineNumber - 1;
			const geometry: DomCaretGeometry = Object.freeze({
				visualLineIndex,
				left: caret.originalLeft,
				isRightToLeft: this.isRightToLeftAtPosition(grapheme.position),
			});
			if (grapheme.endColumn === grapheme.position.column) return geometry;
			const range = Range.fromPositions(grapheme.position, new Position(grapheme.position.lineNumber, grapheme.endColumn));
			const characterRange = context.linesVisibleRangesForRange(range, false)
				?.find(candidate => candidate.lineNumber === visualLineIndex + 1)
				?.ranges[0];
			return characterRange ? Object.freeze({ ...geometry, characterRange }) : geometry;
		}
		const modelPosition = this.context.viewModel.coordinatesConverter.convertViewPositionToModelPosition(grapheme.position);
		const geometry = createStanzaVisualSelectionGeometry(
			this.model,
			[Selection.fromPositions(modelPosition)],
			this.readVisualProjection(),
			{ startLineIndex: context.viewportData.startLineNumber - 1, endLineIndexExclusive: context.viewportData.endLineNumber },
			this.readTextLeft(),
			this.textMeasurer,
		).carets[0];
		return geometry ? Object.freeze({ visualLineIndex: geometry.visualLineIndex, left: geometry.left, isRightToLeft: false }) : undefined;
	}

	private getCharacterWidth(grapheme: CursorGrapheme): number {
		const line = this.context.viewModel.getLineContent(grapheme.position.lineNumber);
		const prefix = line.slice(0, grapheme.position.column - 1);
		const throughCursor = grapheme.character === '\u00a0' ? `${prefix} ` : `${prefix}${grapheme.character}`;
		return Math.max(1, this.textMeasurer.measureLineWidth(throughCursor) - this.textMeasurer.measureLineWidth(prefix));
	}

	private getCharacterPresentation(position: Position): ViewCursorCharacterPresentation | undefined {
		const modelPosition = this.context.viewModel.coordinatesConverter.convertViewPositionToModelPosition(position);
		const columnIndex = modelPosition.column - 1;
		const token = this.semanticTokenSource?.getLineTokens(modelPosition.lineNumber - 1)
			.find(candidate => candidate.startColumn <= columnIndex && columnIndex < candidate.endColumn);
		if (!token) return undefined;
		const syntaxFontStyle = token.syntaxPresentation?.fontStyle ?? [];
		const decorations = syntaxFontStyle
			.filter(style => style === 'underline' || style === 'strikethrough')
			.map(style => style === 'strikethrough' ? 'line-through' : style);
		return Object.freeze({
			classNames: Object.freeze(['stanza-editor-token', ...(token.presentation ? [token.presentation] : []), ...(token.modifiers ?? [])]),
			...(syntaxFontStyle.includes('italic') ? { fontStyle: 'italic' } : {}),
			...(syntaxFontStyle.includes('bold') ? { fontWeight: 'bold' } : {}),
			...(decorations.length > 0 ? { textDecoration: decorations.join(' ') } : {}),
		});
	}
}

function cursorLeft(style: TextEditorCursorStyle, caretLeft: number, characterLeft: number): number {
	return style === TextEditorCursorStyle.Line || style === TextEditorCursorStyle.LineThin ? caretLeft : characterLeft;
}

function cursorStyleClass(style: TextEditorCursorStyle): string {
	switch (style) {
		case TextEditorCursorStyle.Block: return 'cursor-style-block';
		case TextEditorCursorStyle.Underline: return 'cursor-style-underline';
		case TextEditorCursorStyle.LineThin: return 'cursor-style-line-thin';
		case TextEditorCursorStyle.BlockOutline: return 'cursor-style-block-outline';
		case TextEditorCursorStyle.UnderlineThin: return 'cursor-style-underline-thin';
		default: return 'cursor-style-line';
	}
}

function cursorPluralityClass(plurality: CursorPlurality): string {
	switch (plurality) {
		case CursorPlurality.MultiPrimary: return 'cursor-primary';
		case CursorPlurality.MultiSecondary: return 'cursor-secondary';
		default: return '';
	}
}

function cursorWidth(ownerWindow: Window, style: TextEditorCursorStyle, lineWidth: number, characterWidth: number): number {
	if (style === TextEditorCursorStyle.Line) return dom.computeScreenAwareSize(ownerWindow, lineWidth > 0 ? lineWidth : 2);
	if (style === TextEditorCursorStyle.LineThin) return dom.computeScreenAwareSize(ownerWindow, 1);
	return Math.max(1, characterWidth);
}

function cursorHeight(style: TextEditorCursorStyle, lineHeight: number, rowHeight: number): number {
	if (style === TextEditorCursorStyle.Underline) return 2;
	if (style === TextEditorCursorStyle.UnderlineThin) return 1;
	if (style === TextEditorCursorStyle.Line || style === TextEditorCursorStyle.LineThin) {
		return lineHeight > 0 ? Math.min(lineHeight, rowHeight) : rowHeight;
	}
	return rowHeight;
}

function cursorTop(style: TextEditorCursorStyle, rowHeight: number, height: number): number {
	if (style === TextEditorCursorStyle.Underline || style === TextEditorCursorStyle.UnderlineThin) return rowHeight - height;
	return (rowHeight - height) / 2;
}
