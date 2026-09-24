import './linesDecorations.css';
import { DecorationToRender, DedupOverlay } from '../glyphMargin/glyphMargin.js';
import { type RenderingContext } from '../../view/renderingContext.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import * as viewEvents from '../../../common/viewEvents.js';
import { EditorOption } from '../../../common/config/editorOptions.js';

export class LinesDecorationsOverlay extends DedupOverlay {
	private _decorationsLeft: number;
	private _decorationsWidth: number;
	private _renderResult: string[] | null = null;

	constructor(private readonly _context: ViewContext) {
		super();
		const layoutInfo = this._context.configuration.options.get(EditorOption.layoutInfo);
		this._decorationsLeft = layoutInfo.decorationsLeft;
		this._decorationsWidth = layoutInfo.decorationsWidth;
		this._context.addEventHandler(this);
	}

	public override dispose(): void {
		this._context.removeEventHandler(this);
		this._renderResult = null;
		super.dispose();
	}

	public override onConfigurationChanged(_event: viewEvents.ViewConfigurationChangedEvent): boolean {
		const layoutInfo = this._context.configuration.options.get(EditorOption.layoutInfo);
		this._decorationsLeft = layoutInfo.decorationsLeft;
		this._decorationsWidth = layoutInfo.decorationsWidth;
		return true;
	}
	public override onDecorationsChanged(_event: viewEvents.ViewDecorationsChangedEvent): boolean { return true; }
	public override onFlushed(_event: viewEvents.ViewFlushedEvent): boolean { return true; }
	public override onLinesChanged(_event: viewEvents.ViewLinesChangedEvent): boolean { return true; }
	public override onLinesDeleted(_event: viewEvents.ViewLinesDeletedEvent): boolean { return true; }
	public override onLinesInserted(_event: viewEvents.ViewLinesInsertedEvent): boolean { return true; }
	public override onScrollChanged(event: viewEvents.ViewScrollChangedEvent): boolean { return event.scrollTopChanged; }
	public override onZonesChanged(_event: viewEvents.ViewZonesChangedEvent): boolean { return true; }

	protected _getDecorations(context: RenderingContext): DecorationToRender[] {
		const result: DecorationToRender[] = [];
		for (const decoration of context.getDecorationsInViewport()) {
			const tooltip = decoration.options.linesDecorationsTooltip ?? null;
			if (decoration.options.linesDecorationsClassName) {
				result.push(new DecorationToRender(decoration.range.startLineNumber, decoration.range.endLineNumber, decoration.options.linesDecorationsClassName, tooltip, decoration.options.zIndex));
			}
			if (decoration.options.firstLineDecorationClassName) {
				result.push(new DecorationToRender(decoration.range.startLineNumber, decoration.range.startLineNumber, decoration.options.firstLineDecorationClassName, tooltip, decoration.options.zIndex));
			}
		}
		return result;
	}

	public prepareRender(context: RenderingContext): void {
		const visibleStartLineNumber = context.visibleRange.startLineNumber;
		const visibleEndLineNumber = context.visibleRange.endLineNumber;
		const toRender = this._render(visibleStartLineNumber, visibleEndLineNumber, this._getDecorations(context));
		const common = `" style="left:${this._decorationsLeft}px;width:${this._decorationsWidth}px;"></div>`;
		const output: string[] = [];
		for (let lineNumber = visibleStartLineNumber; lineNumber <= visibleEndLineNumber; lineNumber += 1) {
			const decorations = toRender[lineNumber - visibleStartLineNumber]!.getDecorations();
			output[lineNumber - visibleStartLineNumber] = decorations.map(decoration => {
				const title = decoration.tooltip === null ? '' : `" title="${escapeAttribute(decoration.tooltip)}`;
				return `<div class="cldr stanza-editor-line-decoration ${escapeAttribute(decoration.className)}${title}${common}`;
			}).join('');
		}
		this._renderResult = output;
	}

	public render(startLineNumber: number, lineNumber: number): string {
		return this._renderResult?.[lineNumber - startLineNumber] ?? '';
	}
}

function escapeAttribute(value: string): string {
	return value.replace(/[&"<>]/gu, character => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[character]!);
}
