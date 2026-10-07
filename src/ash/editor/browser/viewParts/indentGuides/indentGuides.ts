import "./indentGuides.css";
import { h } from "../../../../base/browser/dom.js";
import { EditorOption, type InternalGuidesOptions } from '../../../common/config/editorOptions.js';
import { Position } from '../../../common/core/position.js';
import { HorizontalGuidesState, type IndentGuide } from '../../../common/textModelGuides.js';
import { type IViewModel, type TextMeasurer } from '../../../common/viewModel.js';
import { type EditorVisualLine, type EditorVisualLineProjection } from '../../../common/viewModel/modelLineProjection.js';
import { DynamicViewOverlay } from '../../view/dynamicViewOverlay.js';
import { type RenderingContext } from "../../view/renderingContext.js";
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import { renderViewPartRows } from '../../view/viewLayer.js';
import * as viewEvents from '../../../common/viewEvents.js';

interface IndentGuidesOptions {
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
				for (const guide of bracketGuides[visualLineIndex + 1 - startLineNumber] ?? []) {
					if (this.appendBracketGuide(row, visualLine, context.viewportData.lineHeight, guide, textLeft, measureLineWidth)) {
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

	private resolveBracketGuides(context: RenderingContext): IndentGuide[][] {
		if (this.guides.bracketPairs === false || this.viewModel.model.isTooLargeForTokenization()) {
			return [];
		}
		let horizontalGuides = HorizontalGuidesState.Disabled;
		if (this.guides.bracketPairsHorizontal === true) {
			horizontalGuides = HorizontalGuidesState.Enabled;
		} else if (this.guides.bracketPairsHorizontal === 'active') {
			horizontalGuides = HorizontalGuidesState.EnabledForActive;
		}
		return this.viewModel.getBracketGuidesInRangeByLine(
			context.viewportData.startLineNumber,
			context.viewportData.endLineNumber,
			this.viewModel.getPrimaryCursorState().modelState.position ?? null,
			{
				includeInactive: this.guides.bracketPairs === true,
				horizontalGuides,
				highlightActive: this.guides.highlightActiveBracketPair,
			},
		);
	}

	private appendBracketGuide(
		row: HTMLElement,
		visualLine: EditorVisualLine,
		lineHeight: number,
		guide: IndentGuide,
		textLeft: number,
		measureLineWidth: (text: string) => number,
	): boolean {
		if (guide.visibleColumn < 1) {
			return false;
		}
		const offset = measureLineWidth(' '.repeat(guide.visibleColumn - 1));
		if (!visualLine.firstForLogicalLine && offset >= (visualLine.wrappedTextIndentWidth ?? 0)) {
			return false;
		}
		const left = textLeft + offset;
		const text = this.viewModel.model.getLineContent(visualLine.logicalLineIndex + 1);
		const bracketLeft = (column: number): number => textLeft + (visualLine.wrappedTextIndentWidth ?? 0) + measureLineWidth(text.slice(visualLine.startColumn, column));
		if (guide.horizontalLine) {
			const endColumn = guide.horizontalLine.endColumn - 1;
			if (endColumn < visualLine.startColumn || endColumn >= visualLine.endColumn) {
				return false;
			}
			const end = bracketLeft(endColumn);
			if (end <= left) {
				return false;
			}
			const horizontal = h(row.ownerDocument, 'span');
			horizontal.className = `stanza-editor-bracket-guide-horizontal ${guide.className}`;
			horizontal.style.left = `${left}px`;
			horizontal.style.width = `${end - left}px`;
			horizontal.style.top = `${guide.horizontalLine.top ? lineHeight / 2 : lineHeight}px`;
			if (!guide.horizontalLine.top) {
				horizontal.style.transform = 'translateY(-100%)';
			}
			row.append(horizontal);
			return false;
		}
		const openingColumnIndex = guide.forWrappedLinesAfterColumn - 1;
		const closingColumnIndex = guide.forWrappedLinesBeforeOrAtColumn - 1;
		if (openingColumnIndex >= 0 && visualLine.endColumn <= openingColumnIndex) {
			return false;
		}
		if (closingColumnIndex >= 0 && visualLine.startColumn > closingColumnIndex) {
			return false;
		}
		const openingVisualLine = openingColumnIndex >= visualLine.startColumn && openingColumnIndex < visualLine.endColumn;
		const closingVisualLine = closingColumnIndex >= visualLine.startColumn && closingColumnIndex < visualLine.endColumn;
		const openingLeft = openingVisualLine ? bracketLeft(openingColumnIndex) : left;
		const top = openingVisualLine ? (openingLeft > left ? lineHeight - 1 : lineHeight / 2) : 0;
		let bottom = 0;
		if (closingVisualLine) {
			bottom = text.slice(visualLine.startColumn, closingColumnIndex).trim() ? 1 : lineHeight / 2;
		}
		const vertical = h(row.ownerDocument, 'span');
		vertical.className = `core-guide stanza-editor-bracket-guide ${guide.className}`;
		vertical.style.left = `${left}px`;
		vertical.style.top = `${top}px`;
		vertical.style.height = `${lineHeight - top - bottom}px`;
		row.append(vertical);
		return true;
	}
}
