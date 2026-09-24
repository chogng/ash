import { h } from '../../../../base/browser/dom.js';
import * as viewEvents from '../../../common/viewEvents.js';
import { ViewContext } from '../../../common/viewModel/viewContext.js';
import { ViewGpuContext } from '../../gpu/viewGpuContext.js';
import { DynamicViewOverlay } from '../../view/dynamicViewOverlay.js';
import { RenderingContext } from '../../view/renderingContext.js';
import { ViewLineOptions } from '../viewLines/viewLineOptions.js';
import './gpuMark.css';

export class GpuMarkOverlay extends DynamicViewOverlay {
	public static readonly CLASS_NAME = 'gpu-mark';
	private renderResult: string[] | undefined;

	constructor(private readonly context: ViewContext, private readonly gpuContext: ViewGpuContext) {
		super();
		context.addEventHandler(this);
	}

	public override dispose(): void {
		this.context.removeEventHandler(this);
		this.renderResult = undefined;
		super.dispose();
	}

	public override onConfigurationChanged(): boolean { return true; }
	public override onCursorStateChanged(): boolean { return true; }
	public override onFlushed(): boolean { return true; }
	public override onLinesChanged(): boolean { return true; }
	public override onLinesDeleted(): boolean { return true; }
	public override onLinesInserted(): boolean { return true; }
	public override onScrollChanged(e: viewEvents.ViewScrollChangedEvent): boolean { return e.scrollTopChanged; }
	public override onZonesChanged(): boolean { return true; }
	public override onDecorationsChanged(): boolean { return true; }

	public prepareRender(ctx: RenderingContext): void {
		const start = ctx.visibleRange.startLineNumber;
		const end = ctx.visibleRange.endLineNumber;
		const options = new ViewLineOptions(this.context.configuration, this.context.theme.type);
		const output: string[] = [];
		for (let lineNumber = start; lineNumber <= end; lineNumber++) {
			const reasons = this.gpuContext.canRenderDetailed(options, ctx.viewportData, lineNumber);
			if (reasons.length === 0) {
				output[lineNumber - start] = '';
				continue;
			}
			const marker = h(this.gpuContext.canvas.domNode.ownerDocument, 'div');
			marker.className = GpuMarkOverlay.CLASS_NAME;
			marker.setAttribute('aria-hidden', 'true');
			marker.title = `Cannot render on GPU: ${reasons.join(', ')}`;
			output[lineNumber - start] = marker.outerHTML;
		}
		this.renderResult = output;
	}

	public render(startLineNumber: number, lineNumber: number): string {
		if (!this.renderResult) return '';
		const lineIndex = lineNumber - startLineNumber;
		return lineIndex >= 0 && lineIndex < this.renderResult.length ? this.renderResult[lineIndex] : '';
	}
}
