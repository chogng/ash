import './currentLineHighlight.css';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { Position } from '../../../common/core/position.js';
import { Selection } from '../../../common/core/selection.js';
import * as viewEvents from '../../../common/viewEvents.js';
import { DynamicViewOverlay } from '../../view/dynamicViewOverlay.js';
import { type RenderingContext } from '../../view/renderingContext.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';

/** Owns current-line state and produces either content or margin fragments. */
export abstract class AbstractLineHighlightOverlay extends DynamicViewOverlay {
	private readonly _context: ViewContext;
	protected _renderLineHighlight: 'none' | 'gutter' | 'line' | 'all';
	protected _wordWrap: boolean;
	protected _contentLeft: number;
	protected _contentWidth: number;
	protected _selectionIsEmpty: boolean;
	protected _renderLineHighlightOnlyWhenFocus: boolean;
	protected _focused: boolean;
	private _cursorLineNumbers: number[];
	private _selections: Selection[];
	private _renderData: string[] | null;

	constructor(context: ViewContext) {
		super();
		this._context = context;
		const configuration = this.readConfiguration();
		this._renderLineHighlight = configuration.renderLineHighlight;
		this._wordWrap = configuration.wordWrap;
		this._renderLineHighlightOnlyWhenFocus = configuration.renderLineHighlightOnlyWhenFocus;
		this._contentLeft = configuration.contentLeft;
		this._contentWidth = configuration.contentWidth;
		this._selectionIsEmpty = true;
		this._focused = false;
		this._selections = this._context.viewModel.getCursorStates().map(state => state.viewState.selection);
		this._cursorLineNumbers = [];
		this._readFromSelections();
		this._renderData = null;
		this._context.addEventHandler(this);
	}

	public override dispose(): void {
		this._context.removeEventHandler(this);
		super.dispose();
	}

	public override onThemeChanged(_event: viewEvents.ViewThemeChangedEvent): boolean {
		return this._readFromSelections();
	}

	public override onConfigurationChanged(_event: viewEvents.ViewConfigurationChangedEvent): boolean {
		const configuration = this.readConfiguration();
		this._renderLineHighlight = configuration.renderLineHighlight;
		this._wordWrap = configuration.wordWrap;
		this._renderLineHighlightOnlyWhenFocus = configuration.renderLineHighlightOnlyWhenFocus;
		this._contentLeft = configuration.contentLeft;
		this._contentWidth = configuration.contentWidth;
		return true;
	}

	public override onCursorStateChanged(event: viewEvents.ViewCursorStateChangedEvent): boolean {
		this._selections = event.selections;
		return this._readFromSelections();
	}

	public override onFlushed(_event: viewEvents.ViewFlushedEvent): boolean { return true; }
	public override onLinesDeleted(_event: viewEvents.ViewLinesDeletedEvent): boolean { return true; }
	public override onLinesInserted(_event: viewEvents.ViewLinesInsertedEvent): boolean { return true; }
	public override onScrollChanged(event: viewEvents.ViewScrollChangedEvent): boolean {
		return event.scrollWidthChanged || event.scrollTopChanged;
	}
	public override onZonesChanged(_event: viewEvents.ViewZonesChangedEvent): boolean { return true; }

	public override onFocusChanged(event: viewEvents.ViewFocusChangedEvent): boolean {
		if (!this._renderLineHighlightOnlyWhenFocus) return false;
		this._focused = event.isFocused;
		return true;
	}

	public prepareRender(context: RenderingContext): void {
		if (!this._shouldRenderThis()) {
			this._renderData = null;
			return;
		}
		const exactLines = new Set(this._cursorLineNumbers);
		const activeModelLines = this._wordWrap
			? new Set(this._cursorLineNumbers.map(lineNumber => this.modelLineAt(lineNumber)))
			: undefined;
		this._renderData = [];
		for (let lineNumber = context.visibleRange.startLineNumber; lineNumber <= context.visibleRange.endLineNumber; lineNumber += 1) {
			const exact = exactLines.has(lineNumber);
			const wrapped = activeModelLines?.has(this.modelLineAt(lineNumber)) ?? false;
			this._renderData[lineNumber - context.visibleRange.startLineNumber] = exact || wrapped
				? this._renderOne(context, exact)
				: '';
		}
	}

	public render(startLineNumber: number, lineNumber: number): string {
		return this._renderData?.[lineNumber - startLineNumber] ?? '';
	}

	protected _shouldRenderInContent(): boolean {
		return (this._renderLineHighlight === 'line' || this._renderLineHighlight === 'all') && this._selectionIsEmpty && (!this._renderLineHighlightOnlyWhenFocus || this._focused);
	}

	protected _shouldRenderInMargin(): boolean {
		return (this._renderLineHighlight === 'gutter' || this._renderLineHighlight === 'all') && (!this._renderLineHighlightOnlyWhenFocus || this._focused);
	}

	protected abstract _renderOne(context: RenderingContext, exact: boolean): string;
	protected abstract _shouldRenderThis(): boolean;
	protected abstract _shouldRenderOther(): boolean;

	private _readFromSelections(): boolean {
		const cursorLineNumbers = [...new Set(this._selections.map(selection => selection.positionLineNumber))].sort((left, right) => left - right);
		const selectionIsEmpty = this._selections.every(selection => selection.isEmpty());
		const changed = selectionIsEmpty !== this._selectionIsEmpty
			|| cursorLineNumbers.length !== this._cursorLineNumbers.length
			|| cursorLineNumbers.some((lineNumber, index) => lineNumber !== this._cursorLineNumbers[index]);
		this._selectionIsEmpty = selectionIsEmpty;
		this._cursorLineNumbers = cursorLineNumbers;
		return changed;
	}

	private modelLineAt(viewLineNumber: number): number {
		return this._context.viewModel.coordinatesConverter.convertViewPositionToModelPosition(new Position(viewLineNumber, 1)).lineNumber;
	}

	private readConfiguration(): {
		readonly renderLineHighlight: 'none' | 'gutter' | 'line' | 'all';
		readonly wordWrap: boolean;
		readonly renderLineHighlightOnlyWhenFocus: boolean;
		readonly contentLeft: number;
		readonly contentWidth: number;
	} {
		const options = this._context.configuration.options;
		const layout = options.get(EditorOption.layoutInfo);
		return {
			renderLineHighlight: options.get(EditorOption.renderLineHighlight),
			wordWrap: layout.isViewportWrapping,
			renderLineHighlightOnlyWhenFocus: options.get(EditorOption.renderLineHighlightOnlyWhenFocus),
			contentLeft: layout.contentLeft,
			contentWidth: layout.contentWidth,
		};
	}
}

/** Projects the active logical line into the content layer. */
export class CurrentLineHighlightOverlay extends AbstractLineHighlightOverlay {
	protected _renderOne(context: RenderingContext, exact: boolean): string {
		return renderHighlight([
			'current-line',
			'stanza-editor-current-line-highlight',
			...(this._shouldRenderOther() ? ['current-line-both'] : []),
			...(exact ? ['current-line-exact'] : []),
		], Math.max(context.scrollWidth, this._contentWidth));
	}

	protected _shouldRenderThis(): boolean { return this._shouldRenderInContent(); }
	protected _shouldRenderOther(): boolean { return this._shouldRenderInMargin(); }
}

/** Projects the active logical line into the margin layer. */
export class CurrentLineMarginHighlightOverlay extends AbstractLineHighlightOverlay {
	protected _renderOne(_context: RenderingContext, exact: boolean): string {
		const margin = this._shouldRenderInMargin();
		return renderHighlight([
			'current-line',
			'stanza-editor-current-line-margin-highlight',
			...(margin ? ['current-line-margin'] : []),
			...(this._shouldRenderOther() ? ['current-line-margin-both'] : []),
			...(margin && exact ? ['current-line-exact-margin'] : []),
		], this._contentLeft);
	}

	protected _shouldRenderThis(): boolean { return true; }
	protected _shouldRenderOther(): boolean { return this._shouldRenderInContent(); }
}

function renderHighlight(classes: readonly string[], width: number): string {
	return `<div class="${classes.join(' ')}" style="width:${Math.max(0, width)}px"></div>`;
}
