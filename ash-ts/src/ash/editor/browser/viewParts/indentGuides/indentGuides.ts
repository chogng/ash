import "./indentGuides.css";
import { h } from "../../../../base/browser/dom.js";
import { EditorOption, type InternalGuidesOptions } from '../../../common/config/editorOptions.js';
import { Position } from '../../../common/core/position.js';
import { type IViewModel, type TextMeasurer } from '../../../common/viewModel.js';
import { type EditorVisualLine, type EditorVisualLineProjection } from '../../../common/viewModel/modelLineProjection.js';
import { DynamicViewOverlay } from '../../view/dynamicViewOverlay.js';
import { type RenderingContext } from "../../view/renderingContext.js";
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import { type BracketColorizationSource, type BracketGuide } from '../viewLines/viewLine.js';
import { renderViewPartRows } from '../../view/viewLayer.js';
import * as viewEvents from '../../../common/viewEvents.js';

interface IndentGuidesOptions {
	readonly bracketColorizationSource: BracketColorizationSource | undefined;
	readonly viewModel: IViewModel;
	readonly host: HTMLElement;
	readonly readVisualProjection: () => EditorVisualLineProjection;
	readonly readTextLeft: () => number;
	readonly textMeasurer: TextMeasurer;
}

/** Owns and projects the visible indentation-guide rows. */
export class IndentGuidesOverlay extends DynamicViewOverlay {
	private _renderResult: string[] = [];
	private guides: InternalGuidesOptions;
	private tabSize: number;
	private primaryPosition: Position | undefined;
	private readonly bracketColorizationSource: BracketColorizationSource | undefined;
	private readonly viewModel: IViewModel;
	private readonly host: HTMLElement;
	private readonly readVisualProjection: () => EditorVisualLineProjection;
	private readonly readTextLeft: () => number;
	private readonly textMeasurer: TextMeasurer;
	constructor(private readonly context: ViewContext, options: IndentGuidesOptions) {
		super();
		this.context.addEventHandler(this);
		this.guides = this.context.configuration.options.get(EditorOption.guides);
		this.tabSize = options.viewModel.model.getOptions().tabSize;
		this.primaryPosition = options.viewModel.getPrimaryCursorState().modelState.position;
		this.bracketColorizationSource = options.bracketColorizationSource;
		this.viewModel = options.viewModel;
		this.host = options.host;
		this.readVisualProjection = options.readVisualProjection;
		this.readTextLeft = options.readTextLeft;
		this.textMeasurer = options.textMeasurer;
	}

	public override dispose(): void {
		this.context.removeEventHandler(this);
		this._renderResult = [];
		super.dispose();
	}

	public override onConfigurationChanged(_event: viewEvents.ViewConfigurationChangedEvent): boolean {
		this.guides = this.context.configuration.options.get(EditorOption.guides);
		return true;
	}

	public override onCursorStateChanged(event: viewEvents.ViewCursorStateChangedEvent): boolean {
		const position = event.modelSelections[0]?.getPosition();
		if (!position || this.primaryPosition?.equals(position)) return false;
		this.primaryPosition = position;
		return true;
	}

	public override onDecorationsChanged(_event: viewEvents.ViewDecorationsChangedEvent): boolean { return true; }
	public override onFlushed(_event: viewEvents.ViewFlushedEvent): boolean {
		this.tabSize = this.viewModel.model.getOptions().tabSize;
		return true;
	}
	public override onLinesChanged(_event: viewEvents.ViewLinesChangedEvent): boolean { return true; }
	public override onLinesDeleted(_event: viewEvents.ViewLinesDeletedEvent): boolean { return true; }
	public override onLinesInserted(_event: viewEvents.ViewLinesInsertedEvent): boolean { return true; }
	public override onScrollChanged(event: viewEvents.ViewScrollChangedEvent): boolean { return event.scrollTopChanged; }
	public override onZonesChanged(_event: viewEvents.ViewZonesChangedEvent): boolean { return true; }
	public override onLanguageConfigurationChanged(_event: viewEvents.ViewLanguageConfigurationEvent): boolean { return true; }

	public prepareRender(context: RenderingContext): void {
		const bracketGuides = this.resolveBracketGuides(context);
		const activeBracketGuide = this.resolveActiveBracketGuide(bracketGuides);
		const activeIndentation = this.resolveActiveIndentation(activeBracketGuide);
		const projection = this.readVisualProjection();
		const textLeft = this.readTextLeft();
		this._renderResult = renderViewPartRows(context, this.host.ownerDocument, rows => {
		for (const [visualLineIndex, row] of rows) {
			const visualLine = projection.lineAt(visualLineIndex);
			if (!visualLine) continue;
			const text = this.viewModel.model.getLineContent((visualLine.logicalLineIndex) + 1);
			if (this.guides.indentation && visualLine.firstForLogicalLine) {
				for (const guide of createStanzaIndentationGuides(text, this.tabSize)) {
					const element = h(row.ownerDocument, "span");
					element.className = "core-guide stanza-editor-indent-guide";
					element.dataset.indentLevel = String(guide.level);
					element.style.left = `${textLeft + this.textMeasurer.measureLineWidth(text.slice(0, guide.columnIndex)) - 1}px`;
					if (activeIndentation?.level === guide.level && activeIndentation.startLineIndex <= visualLine.logicalLineIndex && visualLine.logicalLineIndex <= activeIndentation.endLineIndex) element.classList.add('active');
					row.append(element);
				}
			}
			for (const guide of bracketGuides) this.appendBracketGuide(row, visualLine, context.viewportData.lineHeight, guide, activeBracketGuide, textLeft, this.textMeasurer.measureLineWidth.bind(this.textMeasurer));
		}
		});
	}

	public render(startLineNumber: number, lineNumber: number): string {
		return this._renderResult[lineNumber - startLineNumber] ?? '';
	}

	private resolveBracketGuides(context: RenderingContext): readonly BracketGuide[] {
		if (this.guides.bracketPairs === false || !this.bracketColorizationSource?.getBracketGuides) return Object.freeze([]);
		const projection = this.readVisualProjection();
		const first = projection.lineAt(context.viewportData.startLineNumber - 1);
		const last = projection.lineAt(context.viewportData.endLineNumber - 1);
		if (!first || !last) return Object.freeze([]);
		return this.bracketColorizationSource.getBracketGuides(first.logicalLineIndex, last.logicalLineIndex);
	}

	private resolveActiveBracketGuide(guides: readonly BracketGuide[]): BracketGuide | undefined {
		const position = this.viewModel.getPrimaryCursorState().modelState.position;
		if (!position) return undefined;
		return guides.filter(guide => containsPosition(guide, position)).sort(compareInnermostFirst)[0];
	}

	private resolveActiveIndentation(activeBracketGuide: BracketGuide | undefined): ActiveIndentationGuide | undefined {
		const highlight = this.guides.highlightActiveIndentation;
		if (highlight === false || (highlight !== 'always' && activeBracketGuide)) return undefined;
		const lineIndex = this.viewModel.getPrimaryCursorState().modelState.position.lineNumber - 1;
		const model = this.bracketColorizationSource?.textModel ?? this.viewModel.model;
		const level = createStanzaIndentationGuides(model.getLineContent((lineIndex) + 1), this.tabSize).at(-1)?.level;
		if (!level) return undefined;
		let startLineIndex = lineIndex;
		let endLineIndex = lineIndex;
		while (startLineIndex > 0 && indentationLevel(model.getLineContent((startLineIndex - 1) + 1), this.tabSize) >= level) startLineIndex -= 1;
		while (endLineIndex + 1 < model.getLineCount() && indentationLevel(model.getLineContent((endLineIndex + 1) + 1), this.tabSize) >= level) endLineIndex += 1;
		return { level, startLineIndex, endLineIndex };
	}

	private appendBracketGuide(
		row: HTMLElement,
		visualLine: EditorVisualLine,
		lineHeight: number,
		guide: BracketGuide,
		activeGuide: BracketGuide | undefined,
		textLeft: number,
		measureLineWidth: (text: string) => number,
	): void {
		const lineIndex = visualLine.logicalLineIndex;
		const openingLineIndex = guide.opening.startLineNumber - 1;
		const closingLineIndex = guide.closing.startLineNumber - 1;
		const openingColumnIndex = guide.opening.startColumn - 1;
		const closingColumnIndex = guide.closing.startColumn - 1;
		if (lineIndex < openingLineIndex || lineIndex > closingLineIndex) return;
		if (lineIndex === openingLineIndex && visualLine.endColumn <= openingColumnIndex) return;
		if (lineIndex === closingLineIndex && visualLine.startColumn > closingColumnIndex) return;
		const active = activeGuide === guide;
		if (this.guides.bracketPairs === 'active' && !active) return;
		const openingLine = this.bracketColorizationSource!.textModel.getLineContent(guide.opening.getStartPosition().lineNumber);
		const left = textLeft + measureLineWidth(openingLine.slice(0, openingColumnIndex));
		const vertical = h(row.ownerDocument, 'span');
		vertical.className = 'core-guide stanza-editor-bracket-guide';
		vertical.dataset.bracketLevel = String(guide.level);
		vertical.style.left = `${left}px`;
		const openingVisualLine = lineIndex === openingLineIndex && visualLine.startColumn <= openingColumnIndex && openingColumnIndex < visualLine.endColumn;
		const closingVisualLine = lineIndex === closingLineIndex && visualLine.startColumn <= closingColumnIndex && closingColumnIndex <= visualLine.endColumn;
		if (openingVisualLine) vertical.style.top = `${lineHeight / 2}px`;
		if (closingVisualLine) vertical.style.bottom = `${lineHeight / 2}px`;
		if (active && this.guides.highlightActiveBracketPair) vertical.classList.add('active');
		row.append(vertical);
		const horizontalMode = this.guides.bracketPairsHorizontal;
		if (!closingVisualLine || horizontalMode === false || (horizontalMode === 'active' && !active)) return;
		const closingLine = this.bracketColorizationSource!.textModel.getLineContent(guide.closing.getStartPosition().lineNumber);
		const closingLeft = textLeft + measureLineWidth(closingLine.slice(0, closingColumnIndex));
		const horizontal = h(row.ownerDocument, 'span');
		horizontal.className = 'stanza-editor-bracket-guide-horizontal';
		horizontal.style.left = `${Math.min(left, closingLeft)}px`;
		horizontal.style.width = `${Math.abs(closingLeft - left)}px`;
		horizontal.style.top = `${lineHeight / 2}px`;
		if (active && this.guides.highlightActiveBracketPair) horizontal.classList.add('active');
		row.append(horizontal);
	}
}

interface ActiveIndentationGuide {
	readonly level: number;
	readonly startLineIndex: number;
	readonly endLineIndex: number;
}

function containsPosition(guide: BracketGuide, position: Position): boolean {
	return Position.compare(guide.opening.getStartPosition(), position) <= 0 && Position.compare(guide.closing.getEndPosition(), position) >= 0;
}

function compareInnermostFirst(left: BracketGuide, right: BracketGuide): number {
	const opening = Position.compare(right.opening.getStartPosition(), left.opening.getStartPosition());
	return opening !== 0 ? opening : Position.compare(left.closing.getEndPosition(), right.closing.getEndPosition());
}

function indentationLevel(text: string, tabSize: number): number {
	return createStanzaIndentationGuides(text, tabSize).at(-1)?.level ?? 0;
}

export interface IndentationGuide {
	readonly columnIndex: number;
	readonly level: number;
}

/** Returns one guide at every complete visual indentation unit in leading whitespace. */
export function createStanzaIndentationGuides(text: string, tabSize: number): readonly IndentationGuide[] {
	if (typeof text !== "string") throw new TypeError("Stanza indentation guides require text");
	if (!Number.isSafeInteger(tabSize) || tabSize < 1) throw new RangeError("Stanza indentation guide tab size must be a positive safe integer");
	const guides: IndentationGuide[] = [];
	let visualColumn = 0;
	for (let columnIndex = 0; columnIndex < text.length; columnIndex += 1) {
		const character = text[columnIndex]!;
		if (character !== " " && character !== "\t") break;
		visualColumn = character === "\t"
			? visualColumn + tabSize - (visualColumn % tabSize)
			: visualColumn + 1;
		if (visualColumn % tabSize === 0) {
			guides.push(Object.freeze({
				columnIndex: columnIndex + 1,
				level: visualColumn / tabSize,
			}));
		}
	}
	return Object.freeze(guides);
}
