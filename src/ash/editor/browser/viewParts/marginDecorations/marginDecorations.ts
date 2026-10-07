import './marginDecorations.css';
import { DecorationToRender, DedupOverlay } from '../glyphMargin/glyphMargin.js';
import { type RenderingContext } from '../../view/renderingContext.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import * as viewEvents from '../../../common/viewEvents.js';

export class MarginViewLineDecorationsOverlay extends DedupOverlay {
	private renderResult: string[] | null = null;

	constructor(private readonly context: ViewContext) {
		super();
		this.context.addEventHandler(this);
	}

	public override dispose(): void {
		this.context.removeEventHandler(this);
		this.renderResult = null;
		super.dispose();
	}

	public override onConfigurationChanged(_event: viewEvents.ViewConfigurationChangedEvent): boolean { return true; }
	public override onDecorationsChanged(_event: viewEvents.ViewDecorationsChangedEvent): boolean { return true; }
	public override onFlushed(_event: viewEvents.ViewFlushedEvent): boolean { return true; }
	public override onLinesChanged(_event: viewEvents.ViewLinesChangedEvent): boolean { return true; }
	public override onLinesDeleted(_event: viewEvents.ViewLinesDeletedEvent): boolean { return true; }
	public override onLinesInserted(_event: viewEvents.ViewLinesInsertedEvent): boolean { return true; }
	public override onScrollChanged(event: viewEvents.ViewScrollChangedEvent): boolean { return event.scrollTopChanged; }
	public override onZonesChanged(_event: viewEvents.ViewZonesChangedEvent): boolean { return true; }

	protected getDecorations(context: RenderingContext): DecorationToRender[] {
		const result: DecorationToRender[] = [];
		for (const decoration of context.getDecorationsInViewport()) {
			const className = decoration.options.marginClassName;
			if (className) result.push(new DecorationToRender(
				decoration.range.startLineNumber,
				decoration.range.endLineNumber,
				className,
				null,
				decoration.options.zIndex,
			));
		}
		return result;
	}

	public prepareRender(context: RenderingContext): void {
		const startLineNumber = context.visibleRange.startLineNumber;
		const endLineNumber = context.visibleRange.endLineNumber;
		const rendered = this._render(startLineNumber, endLineNumber, this.getDecorations(context));
		this.renderResult = rendered.map(line => line.getDecorations().map(decoration =>
			`<div class="cmdr ${decoration.className}" style=""></div>`,
		).join(''));
	}

	public render(startLineNumber: number, lineNumber: number): string {
		return this.renderResult?.[lineNumber - startLineNumber] ?? '';
	}
}
