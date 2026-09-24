import './whitespace.css';
import { h } from '../../../../base/browser/dom.js';
import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { type TextModel } from '../../../common/model/textModel.js';
import { type IViewModel, type TextMeasurer } from '../../../common/viewModel.js';
import { DynamicViewOverlay } from '../../view/dynamicViewOverlay.js';
import { type RenderingContext } from '../../view/renderingContext.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import { type EditorVisualLineProjection } from '../../../common/viewModel/modelLineProjection.js';
import { renderViewPartRows } from '../../view/viewLayer.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import * as viewEvents from '../../../common/viewEvents.js';

export type WhitespaceRenderingMode = 'none' | 'boundary' | 'selection' | 'trailing' | 'all';

/** Projects whitespace glyphs without changing the text rows used for selection geometry. */
export class WhitespaceOverlay extends DynamicViewOverlay {
	private _renderResult: string[] = [];
	private mode: WhitespaceRenderingMode;
	constructor(
		private readonly context: ViewContext,
		private readonly model: TextModel,
		private readonly viewModel: IViewModel,
		private readonly host: HTMLElement,
		private readonly readVisualProjection: () => EditorVisualLineProjection,
		private readonly readTextLeft: () => number,
		private readonly textMeasurer: TextMeasurer,
	) {
		super();
		this.mode = this.context.configuration.options.get(EditorOption.renderWhitespace);
		this.context.addEventHandler(this);
	}

	public override dispose(): void {
		this.context.removeEventHandler(this);
		this._renderResult = [];
		super.dispose();
	}

	public override onConfigurationChanged(event: viewEvents.ViewConfigurationChangedEvent): boolean {
		const mode = this.context.configuration.options.get(EditorOption.renderWhitespace);
		const changed = this.mode !== mode;
		this.mode = mode;
		return changed || event.hasChanged(EditorOption.layoutInfo) || event.hasChanged(EditorOption.fontInfo);
	}

	public override onCursorStateChanged(_event: viewEvents.ViewCursorStateChangedEvent): boolean { return this.mode === 'selection'; }
	public override onDecorationsChanged(_event: viewEvents.ViewDecorationsChangedEvent): boolean { return true; }
	public override onFlushed(_event: viewEvents.ViewFlushedEvent): boolean { return true; }
	public override onLinesChanged(_event: viewEvents.ViewLinesChangedEvent): boolean { return true; }
	public override onLinesDeleted(_event: viewEvents.ViewLinesDeletedEvent): boolean { return true; }
	public override onLinesInserted(_event: viewEvents.ViewLinesInsertedEvent): boolean { return true; }
	public override onScrollChanged(event: viewEvents.ViewScrollChangedEvent): boolean { return event.scrollTopChanged; }
	public override onZonesChanged(_event: viewEvents.ViewZonesChangedEvent): boolean { return true; }

	public prepareRender(context: RenderingContext): void {
		const projection = this.readVisualProjection();
		const textLeft = this.readTextLeft();
		this._renderResult = renderViewPartRows(context, this.host.ownerDocument, rows => {
		for (const [visualLineIndex, row] of rows) {
			if (this.mode === 'none') {
				continue;
			}
			const visualLine = projection.lineAt(visualLineIndex);
			if (!visualLine) {
				continue;
			}
			const text = this.model.getLineContent((visualLine.logicalLineIndex) + 1).slice(visualLine.startColumn, visualLine.endColumn);
			const trailingStart = text.search(/\s*$/u);
			for (let index = 0; index < text.length; index += 1) {
				const character = text[index];
				if (character !== ' ' && character !== '\t') {
					continue;
				}
				if (this.mode === 'trailing' && index < trailingStart) {
					continue;
				}
				if (this.mode === 'boundary' && index > 0 && index < trailingStart) {
					continue;
				}
				if (this.mode === 'selection' && !this.isSelected(visualLine.logicalLineIndex, visualLine.startColumn + index)) {
					continue;
				}
				const marker = h(row.ownerDocument, 'span');
				marker.className = 'mwh stanza-editor-whitespace';
				marker.textContent = character === '\t' ? '→' : '·';
				marker.style.left = `${textLeft + this.textMeasurer.measureLineWidth(text.slice(0, index))}px`;
				row.append(marker);
			}
		}
		});
	}

	public render(startLineNumber: number, lineNumber: number): string {
		return this._renderResult[lineNumber - startLineNumber] ?? '';
	}

	private isSelected(lineIndex: number, columnIndex: number): boolean {
		const characterRange = Range.fromPositions(new Position((lineIndex) + 1, (columnIndex) + 1), new Position((lineIndex) + 1, (columnIndex + 1) + 1));
		return this.viewModel.getCursorStates().some(state => Range.areIntersecting(state.modelState.selection, characterRange));
	}
}
