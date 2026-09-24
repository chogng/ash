import "./indentGuides.css";
import { h } from "../../../../base/browser/dom.js";
import { EditorOption, type InternalGuidesOptions } from '../../../common/config/editorOptions.js';
import { Position } from '../../../common/core/position.js';
import { type IViewModel, type TextMeasurer } from '../../../common/viewModel.js';
import { type EditorVisualLine, type EditorVisualLineProjection } from '../../../common/viewModel/modelLineProjection.js';
import { DynamicViewOverlay } from '../../view/dynamicViewOverlay.js';
import { type RenderingContext } from "../../view/renderingContext.js";
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import type { TextModel } from '../../../common/model/textModel.js';
import type { Range } from '../../../common/core/range.js';
import { renderViewPartRows } from '../../view/viewLayer.js';
import * as viewEvents from '../../../common/viewEvents.js';

export interface BracketGuide {
	readonly opening: Range;
	readonly closing: Range;
	/** One-based visual column shared by the vertical segments of this pair. */
	readonly visibleColumn: number;
	readonly level: number;
}

export interface BracketGuideSource {
	readonly textModel: TextModel;
	getBracketGuides(startLineIndex: number, endLineIndexInclusive: number): readonly BracketGuide[];
}

interface IndentGuidesOptions {
	readonly bracketGuideSource: BracketGuideSource | undefined;
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
	private primaryPosition: Position | undefined;
	private readonly bracketGuideSource: BracketGuideSource | undefined;
	private readonly viewModel: IViewModel;
	private readonly host: HTMLElement;
	private readonly readVisualProjection: () => EditorVisualLineProjection;
	private readonly readTextLeft: () => number;
	private readonly textMeasurer: TextMeasurer;
	constructor(private readonly context: ViewContext, options: IndentGuidesOptions) {
		super();
		this.context.addEventHandler(this);
		this.guides = this.context.configuration.options.get(EditorOption.guides);
		this.primaryPosition = options.viewModel.getPrimaryCursorState().modelState.position;
		this.bracketGuideSource = options.bracketGuideSource;
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
	public override onFlushed(_event: viewEvents.ViewFlushedEvent): boolean { return true; }
	public override onLineMappingChanged(_event: viewEvents.ViewLineMappingChangedEvent): boolean { return true; }
	public override onLinesChanged(_event: viewEvents.ViewLinesChangedEvent): boolean { return true; }
	public override onLinesDeleted(_event: viewEvents.ViewLinesDeletedEvent): boolean { return true; }
	public override onLinesInserted(_event: viewEvents.ViewLinesInsertedEvent): boolean { return true; }
	public override onScrollChanged(event: viewEvents.ViewScrollChangedEvent): boolean { return event.scrollTopChanged; }
	public override onZonesChanged(_event: viewEvents.ViewZonesChangedEvent): boolean { return true; }
	public override onLanguageConfigurationChanged(_event: viewEvents.ViewLanguageConfigurationEvent): boolean { return true; }

	public prepareRender(context: RenderingContext): void {
		const bracketGuides = this.resolveBracketGuides(context);
		const activeBracketGuide = this.resolveActiveBracketGuide(bracketGuides);
		const { startLineNumber, endLineNumber } = context.viewportData;
		const indentation = this.guides.indentation ? this.viewModel.getLinesIndentGuides(startLineNumber, endLineNumber) : [];
		const activeIndentation = this.guides.indentation && this.guides.highlightActiveIndentation !== false
			? this.viewModel.getActiveIndentGuide(this.viewModel.getPrimaryCursorState().viewState.position.lineNumber, startLineNumber, endLineNumber)
			: undefined;
		const { indentSize } = this.viewModel.model.getOptions();
		const projection = this.readVisualProjection();
		const textLeft = this.readTextLeft();
		const measureLineWidth = this.textMeasurer.measureLineWidth.bind(this.textMeasurer);
		this._renderResult = renderViewPartRows(context, this.host.ownerDocument, rows => {
			for (const [visualLineIndex, row] of rows) {
				const visualLine = projection.lineAt(visualLineIndex);
				if (!visualLine) continue;
				const bracketColumns = new Set<number>();
				for (const guide of bracketGuides) {
					if (this.appendBracketGuide(row, visualLine, context.viewportData.lineHeight, guide, activeBracketGuide, textLeft, measureLineWidth)) {
						bracketColumns.add(guide.visibleColumn);
					}
				}
				const lineNumber = visualLineIndex + 1;
				const depth = indentation[lineNumber - startLineNumber] ?? 0;
				const highlight = this.guides.highlightActiveIndentation === 'always' || row.childElementCount === 0;
				if (this.guides.indentation) {
					for (let level = 1; level <= depth; level++) {
						const offset = this.textMeasurer.measureLineWidth(' '.repeat((level - 1) * indentSize));
						if (!visualLine.firstForLogicalLine && offset >= (visualLine.wrappedTextIndentWidth ?? 0)) {
							break;
						}
						if (bracketColumns.has((level - 1) * indentSize + 1)) {
							continue;
						}
						const element = h(row.ownerDocument, 'span');
						element.className = 'core-guide stanza-editor-indent-guide';
						element.dataset.indentLevel = String(level);
						element.style.left = `${textLeft + offset}px`;
						if (highlight && activeIndentation?.indent === level && activeIndentation.startLineNumber <= lineNumber && lineNumber <= activeIndentation.endLineNumber) {
							element.classList.add('active');
						}
						row.append(element);
					}
				}
			}
		});
	}

	public render(startLineNumber: number, lineNumber: number): string {
		return this._renderResult[lineNumber - startLineNumber] ?? '';
	}

	private resolveBracketGuides(context: RenderingContext): readonly BracketGuide[] {
		if (this.guides.bracketPairs === false || !this.bracketGuideSource?.getBracketGuides) return Object.freeze([]);
		const projection = this.readVisualProjection();
		const first = projection.lineAt(context.viewportData.startLineNumber - 1);
		const last = projection.lineAt(context.viewportData.endLineNumber - 1);
		if (!first || !last) return Object.freeze([]);
		return this.bracketGuideSource.getBracketGuides(first.logicalLineIndex, last.logicalLineIndex);
	}

	private resolveActiveBracketGuide(guides: readonly BracketGuide[]): BracketGuide | undefined {
		const position = this.viewModel.getPrimaryCursorState().modelState.position;
		if (!position) return undefined;
		return guides.filter(guide => guide.opening.startLineNumber !== guide.closing.startLineNumber && containsPosition(guide, position)).sort(compareInnermostFirst)[0];
	}

	private appendBracketGuide(
		row: HTMLElement,
		visualLine: EditorVisualLine,
		lineHeight: number,
		guide: BracketGuide,
		activeGuide: BracketGuide | undefined,
		textLeft: number,
		measureLineWidth: (text: string) => number,
	): boolean {
		const lineIndex = visualLine.logicalLineIndex;
		const openingLineIndex = guide.opening.startLineNumber - 1;
		const closingLineIndex = guide.closing.startLineNumber - 1;
		if (openingLineIndex === closingLineIndex) {
			return false;
		}
		const openingColumnIndex = guide.opening.startColumn - 1;
		const closingColumnIndex = guide.closing.startColumn - 1;
		if (lineIndex < openingLineIndex || lineIndex > closingLineIndex) {
			return false;
		}
		if (lineIndex === openingLineIndex && visualLine.endColumn <= openingColumnIndex) {
			return false;
		}
		if (lineIndex === closingLineIndex && visualLine.startColumn > closingColumnIndex) {
			return false;
		}
		const active = activeGuide === guide;
		if (this.guides.bracketPairs === 'active' && !active) {
			return false;
		}
		const offset = measureLineWidth(' '.repeat(guide.visibleColumn - 1));
		if (!visualLine.firstForLogicalLine && offset >= (visualLine.wrappedTextIndentWidth ?? 0)) {
			return false;
		}
		const left = textLeft + offset;
		const text = this.viewModel.model.getLineContent(lineIndex + 1);
		const bracketLeft = (column: number): number => textLeft + (visualLine.wrappedTextIndentWidth ?? 0) + measureLineWidth(text.slice(visualLine.startColumn, column));
		const vertical = h(row.ownerDocument, 'span');
		vertical.className = `core-guide stanza-editor-bracket-guide stanza-editor-guide-level-${guide.level}`;
		vertical.dataset.bracketLevel = String(guide.level);
		vertical.style.left = `${left}px`;
		const openingVisualLine = lineIndex === openingLineIndex && visualLine.startColumn <= openingColumnIndex && openingColumnIndex < visualLine.endColumn;
		const closingVisualLine = lineIndex === closingLineIndex && visualLine.startColumn <= closingColumnIndex && closingColumnIndex < visualLine.endColumn;
		const openingLeft = openingVisualLine ? bracketLeft(openingColumnIndex) : left;
		const closingLeft = closingVisualLine ? bracketLeft(closingColumnIndex) : left;
		const top = openingVisualLine ? (openingLeft > left ? lineHeight - 1 : lineHeight / 2) : 0;
		const closingTop = text.slice(visualLine.startColumn, closingColumnIndex).trim() ? lineHeight - 1 : lineHeight / 2;
		const bottom = closingVisualLine ? lineHeight - closingTop : 0;
		vertical.style.top = `${top}px`;
		vertical.style.height = `${lineHeight - top - bottom}px`;
		if (active && this.guides.highlightActiveBracketPair) vertical.classList.add('active');
		row.append(vertical);
		const horizontalMode = this.guides.bracketPairsHorizontal;
		if (horizontalMode === false || (horizontalMode === 'active' && !active)) {
			return true;
		}
		const end = openingVisualLine ? openingLeft : closingLeft;
		if ((!openingVisualLine && !closingVisualLine) || end <= left) {
			return true;
		}
		const horizontal = h(row.ownerDocument, 'span');
		horizontal.className = `stanza-editor-bracket-guide-horizontal stanza-editor-guide-level-${guide.level}`;
		horizontal.style.left = `${left}px`;
		horizontal.style.width = `${end - left}px`;
		const atRowEnd = openingVisualLine || closingTop > lineHeight / 2;
		horizontal.style.top = `${atRowEnd ? lineHeight : closingTop}px`;
		if (atRowEnd) {
			horizontal.style.transform = 'translateY(-100%)';
		}
		if (active && this.guides.highlightActiveBracketPair) horizontal.classList.add('active');
		row.append(horizontal);
		return true;
	}
}

function containsPosition(guide: BracketGuide, position: Position): boolean {
	return Position.compare(guide.opening.getStartPosition(), position) <= 0 && Position.compare(guide.closing.getEndPosition(), position) >= 0;
}

function compareInnermostFirst(left: BracketGuide, right: BracketGuide): number {
	const opening = Position.compare(right.opening.getStartPosition(), left.opening.getStartPosition());
	return opening !== 0 ? opening : Position.compare(left.closing.getEndPosition(), right.closing.getEndPosition());
}
