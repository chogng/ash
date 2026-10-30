import './selections.css';
import { h, reset, svg } from '../../../../base/browser/dom.js';
import { createStanzaVisualSelectionGeometry, type VisualSelectionRectangle } from '../../../common/viewModel/visualSelectionGeometry.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { ColorScheme } from '../../../../platform/theme/common/theme.js';
import { type Selection } from '../../../common/core/selection.js';
import { type IViewModel, type TextMeasurer } from '../../../common/viewModel.js';
import { type RenderingContext } from '../../view/renderingContext.js';
import { DynamicViewOverlay } from '../../view/dynamicViewOverlay.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import { type EditorVisualLineProjection } from '../../../common/viewModel/modelLineProjection.js';
import { type TextModel } from '../../../common/model/textModel.js';
import { renderViewPartRows } from '../../view/viewLayer.js';
import * as viewEvents from '../../../common/viewEvents.js';

/** Projects selection ranges and current-line state without owning selection state. */
export class SelectionsOverlay extends DynamicViewOverlay {
	private _renderResult: string[] = [];
	constructor(
		private readonly context: ViewContext,
		private readonly viewModel: IViewModel,
		private readonly model: TextModel,
		private readonly host: HTMLElement,
		private readonly readVisualProjection: () => EditorVisualLineProjection,
		private readonly readTextLeft: () => number,
		private readonly textMeasurer: TextMeasurer,
	) {
		super();
		this.context.addEventHandler(this);
	}

	public override dispose(): void {
		this.context.removeEventHandler(this);
		this._renderResult = [];
		super.dispose();
	}

	public override onConfigurationChanged(_event: viewEvents.ViewConfigurationChangedEvent): boolean { return true; }
	public override onCursorStateChanged(_event: viewEvents.ViewCursorStateChangedEvent): boolean { return true; }
	public override onDecorationsChanged(_event: viewEvents.ViewDecorationsChangedEvent): boolean { return true; }
	public override onFlushed(_event: viewEvents.ViewFlushedEvent): boolean { return true; }
	public override onLinesChanged(_event: viewEvents.ViewLinesChangedEvent): boolean { return true; }
	public override onLinesDeleted(_event: viewEvents.ViewLinesDeletedEvent): boolean { return true; }
	public override onLinesInserted(_event: viewEvents.ViewLinesInsertedEvent): boolean { return true; }
	public override onScrollChanged(event: viewEvents.ViewScrollChangedEvent): boolean { return event.scrollTopChanged; }
	public override onZonesChanged(_event: viewEvents.ViewZonesChangedEvent): boolean { return true; }
	public override onThemeChanged(_event: viewEvents.ViewThemeChangedEvent): boolean { return true; }

	public prepareRender(context: RenderingContext): void {
		const cursorStates = this.viewModel.getCursorStates();
		if (cursorStates.every(state => state.modelState.selection.isEmpty())) {
			this._renderResult = [];
			return;
		}
		this._renderResult = renderViewPartRows(context, this.host.ownerDocument, rows => {
			projectStanzaSelectionOverlays(
				context,
				this.model,
				this.readVisualProjection(),
				this.readTextLeft(),
				this.textMeasurer,
				cursorStates.map(state => state.viewState.selection),
				cursorStates.map(state => state.modelState.selection),
				rows,
				this.context.configuration.options.get(EditorOption.roundedSelection)
				&& this.context.theme.type !== ColorScheme.HighContrastDark
				&& this.context.theme.type !== ColorScheme.HighContrastLight,
				this.context.configuration.options.get(EditorOption.fontInfo).typicalHalfwidthCharacterWidth / 4,
			);
		});
	}

	public render(startLineNumber: number, lineNumber: number): string {
		return this._renderResult[lineNumber - startLineNumber] ?? '';
	}
}

function projectStanzaSelectionOverlays(
	context: RenderingContext,
	model: TextModel,
	projection: EditorVisualLineProjection,
	textLeft: number,
	textMeasurer: TextMeasurer,
	viewSelections: readonly Selection[],
	modelSelections: readonly Selection[],
	rows: ReadonlyMap<number, HTMLElement>,
	rounded: boolean,
	edgeTolerance: number,
): void {
	for (const row of rows.values()) reset(row);
	// Include neighboring rows so scrolling does not turn a continuing selection into a rounded cap.
	const renderLines = { startLineIndex: Math.max(0, context.viewportData.startLineNumber - 2), endLineIndexExclusive: context.viewportData.endLineNumber + 1 };
	const geometry = createStanzaVisualSelectionGeometry(model, modelSelections, projection, renderLines, textLeft, textMeasurer);
	const segments = new Map<number, Map<number, VisualSelectionRectangle[]>>();
	for (const rectangle of geometry.selections) {
		let lines = segments.get(rectangle.selectionIndex);
		if (!lines) segments.set(rectangle.selectionIndex, lines = new Map());
		lines.set(rectangle.visualLineIndex, [rectangle]);
	}
	for (let selectionIndex = 0; selectionIndex < viewSelections.length; selectionIndex += 1) {
		const selection = viewSelections[selectionIndex]!;
		if (selection.isEmpty()) continue;
		const ranges = context.linesVisibleRangesForRange(selection, true);
		if (!ranges) continue;
		let lines = segments.get(selectionIndex);
		if (!lines) segments.set(selectionIndex, lines = new Map());
		for (const line of ranges) {
			// Rendered ranges start at the text row; overlays are mounted beside the gutter.
			lines.set(line.lineNumber - 1, line.ranges.map(range => ({
				selectionIndex,
				visualLineIndex: line.lineNumber - 1,
				left: textLeft + range.left,
				width: range.width,
			})));
		}
	}
	for (const lines of segments.values()) {
		// A bidi selection can have separated bands on one row; those bands retain square edges.
		const roundLines = rounded && [...lines.values()].every(line => line.length === 1);
		for (const [lineIndex, rectangles] of lines) {
			for (const rectangle of rectangles) {
				const element = appendSelection(rows, rectangle.selectionIndex, lineIndex, rectangle.left, rectangle.width);
				if (!element || !roundLines) continue;
				const above = lines.get(lineIndex - 1)?.[0];
				const below = lines.get(lineIndex + 1)?.[0];
				roundSelectionSegment(element, rectangle, above, below, edgeTolerance);
			}
		}
	}
}

function appendSelection(rows: ReadonlyMap<number, HTMLElement>, selectionIndex: number, visualLineIndex: number, left: number, width: number): HTMLElement | undefined {
	const row = rows.get(visualLineIndex);
	if (!row) return;
	const element = h(row.ownerDocument, 'div');
	element.className = 'cslr selected-text stanza-editor-selection';
	element.dataset.selectionIndex = String(selectionIndex);
	element.style.left = `${left}px`;
	element.style.width = `${width}px`;
	row.append(element);
	return element;
}

function roundSelectionSegment(
	element: HTMLElement,
	segment: VisualSelectionRectangle,
	above: VisualSelectionRectangle | undefined,
	below: VisualSelectionRectangle | undefined,
	tolerance: number,
): void {
	// This radius describes the text-selection contour, rather than a control or floating surface.
	const radius = 3;
	const left = segment.left;
	const right = left + segment.width;
	for (const [vertical, neighbor] of [['top', above], ['bottom', below]] as const) {
		const connected = neighbor && neighbor.left < right - tolerance && neighbor.left + neighbor.width > left + tolerance;
		for (const horizontal of ['left', 'right'] as const) {
			const edge = horizontal === 'left' ? left : right;
			const neighborEdge = neighbor ? neighbor.left + (horizontal === 'right' ? neighbor.width : 0) : edge;
			const extension = (neighborEdge - edge) * (horizontal === 'left' ? -1 : 1);
			const property = `border-${vertical}-${horizontal}-radius`;
			if (!connected || extension < -tolerance) {
				element.style.setProperty(property, `${radius}px`);
			} else if (extension > tolerance) {
				// Fill only the concave wedge outside this rectangle. No background-colored cutout is
				// needed, so translucent selections and transparent embedded editors retain their color.
				const corner = svg(element.ownerDocument, 'svg');
				corner.classList.add('stanza-editor-selection-corner');
				corner.setAttribute('width', String(radius));
				corner.setAttribute('height', String(radius));
				corner.setAttribute('viewBox', '0 0 1 1');
				corner.setAttribute('aria-hidden', 'true');
				corner.style.setProperty(vertical, '0');
				corner.style.setProperty(horizontal, `${-radius}px`);
				corner.style.transform = `scale(${horizontal === 'left' ? -1 : 1}, ${vertical === 'top' ? -1 : 1})`;
				const path = svg(element.ownerDocument, 'path');
				path.setAttribute('d', 'M0 0V1H1A1 1 0 0 1 0 0Z');
				corner.append(path);
				element.append(corner);
			}
		}
	}
}
