import "./lineNumbers.css";
import { h, reset } from "../../../../base/browser/dom.js";
import { EditorOption, type InternalEditorRenderLineNumbersOptions, RenderLineNumbersType } from '../../../common/config/editorOptions.js';
import { type EditorVisualLineProjection } from "../../../common/viewModel/modelLineProjection.js";
import { type IViewModel } from '../../../common/viewModel.js';
import { type RenderingContext } from "../../view/renderingContext.js";
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import { DynamicViewOverlay } from '../../view/dynamicViewOverlay.js';
import { renderViewPartRows } from '../../view/viewLayer.js';
import * as viewEvents from '../../../common/viewEvents.js';

interface LineNumbersOverlayOptions {
	readonly viewModel: IViewModel;
	readonly readVisualProjection: () => EditorVisualLineProjection;
	readonly host: HTMLElement;
}

/** Projects line numbers into virtual rows. */
export class LineNumbersOverlay extends DynamicViewOverlay {
	public static readonly CLASS_NAME = 'line-numbers';
	private _renderResult: string[] = [];
	private lineNumbers: InternalEditorRenderLineNumbersOptions;
	private activeLineNumber: number;
	private readonly viewModel: IViewModel;
	private readonly readVisualProjection: () => EditorVisualLineProjection;
	private readonly host: HTMLElement;

	constructor(private readonly context: ViewContext, options: LineNumbersOverlayOptions) {
		super();
		this.context.addEventHandler(this);
		this.lineNumbers = this.context.configuration.options.get(EditorOption.lineNumbers);
		this.viewModel = options.viewModel;
		this.activeLineNumber = this.viewModel.getPrimaryCursorState().modelState.position.lineNumber;
		this.readVisualProjection = options.readVisualProjection;
		this.host = options.host;
	}

	public override dispose(): void {
		this.context.removeEventHandler(this);
		this._renderResult = [];
		super.dispose();
	}

	public override onConfigurationChanged(_event: viewEvents.ViewConfigurationChangedEvent): boolean {
		this.lineNumbers = this.context.configuration.options.get(EditorOption.lineNumbers);
		return true;
	}

	public override onCursorStateChanged(event: viewEvents.ViewCursorStateChangedEvent): boolean {
		const activeLineNumber = event.modelSelections[0]?.positionLineNumber ?? this.activeLineNumber;
		const activeLineChanged = activeLineNumber !== this.activeLineNumber;
		this.activeLineNumber = activeLineNumber;
		return activeLineChanged || this.lineNumbers.renderType === RenderLineNumbersType.Relative || this.lineNumbers.renderType === RenderLineNumbersType.Interval;
	}

	public override onDecorationsChanged(event: viewEvents.ViewDecorationsChangedEvent): boolean { return event.affectsLineNumber; }
	public override onFlushed(_event: viewEvents.ViewFlushedEvent): boolean { return true; }
	public override onLinesChanged(_event: viewEvents.ViewLinesChangedEvent): boolean { return true; }
	public override onLinesDeleted(_event: viewEvents.ViewLinesDeletedEvent): boolean { return true; }
	public override onLinesInserted(_event: viewEvents.ViewLinesInsertedEvent): boolean { return true; }
	public override onScrollChanged(event: viewEvents.ViewScrollChangedEvent): boolean { return event.scrollTopChanged; }
	public override onZonesChanged(_event: viewEvents.ViewZonesChangedEvent): boolean { return true; }

	public prepareRender(context: RenderingContext): void {
		const visualProjection = this.readVisualProjection();
		const activeLineIndex = this.viewModel.getPrimaryCursorState().modelState.position.lineNumber - 1;
		this._renderResult = renderViewPartRows(context, this.host.ownerDocument, rows => {
		for (const [visualLineIndex, row] of rows) {
			const visualLine = visualProjection.lineAt(visualLineIndex);
			if (!visualLine) continue;
			const number = h(row.ownerDocument, "span");
			number.className = LineNumbersOverlay.CLASS_NAME;
			number.classList.toggle("active", visualLine.logicalLineIndex === activeLineIndex);
			number.classList.toggle("active-line-number", visualLine.logicalLineIndex === activeLineIndex);
			number.textContent = visualLine.firstForLogicalLine
				? renderLineNumber(this.lineNumbers, visualLine.logicalLineIndex, activeLineIndex)
				: '';
			reset(row, number);
		}
		});
	}

	public render(startLineNumber: number, lineNumber: number): string {
		return this._renderResult[lineNumber - startLineNumber] ?? '';
	}
}

function renderLineNumber(options: InternalEditorRenderLineNumbersOptions, lineIndex: number, activeLineIndex: number | undefined): string {
	const lineNumber = lineIndex + 1;
	switch (options.renderType) {
		case RenderLineNumbersType.Off: return '';
		case RenderLineNumbersType.On: return String(lineNumber);
		case RenderLineNumbersType.Relative:
			return activeLineIndex === undefined || activeLineIndex === lineIndex ? String(lineNumber) : String(Math.abs(lineIndex - activeLineIndex));
		case RenderLineNumbersType.Interval: return lineNumber % 10 === 0 ? String(lineNumber) : '';
		case RenderLineNumbersType.Custom: return options.renderFn?.(lineNumber) ?? '';
	}
}
