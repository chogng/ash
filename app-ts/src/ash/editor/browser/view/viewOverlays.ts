import { type FastDomNode } from '../../../base/browser/fastDomNode.js';
import { applyFontInfo } from '../config/domFontInfo.js';
import { EditorOption } from '../../common/config/editorOptions.js';
import * as viewEvents from '../../common/viewEvents.js';
import { type ViewContext } from '../../common/viewModel/viewContext.js';
import { DynamicViewOverlay } from './dynamicViewOverlay.js';
import { type RenderingContext, type RestrictedRenderingContext } from './renderingContext.js';
import { ViewPart } from './viewPart.js';
import { ViewPartRows } from './viewLayer.js';

export class ViewOverlays extends ViewPart {
	protected readonly domNode: FastDomNode<HTMLElement>;
	private readonly _visibleLines: ViewPartRows;
	private readonly _dynamicOverlays: DynamicViewOverlay[] = [];
	private _isFocused = false;

	constructor(context: ViewContext, host: HTMLElement) {
		super(context);
		this._visibleLines = this._register(new ViewPartRows(host, 'view-overlays', 'view-overlay-line'));
		this.domNode = this._visibleLines.domNode;
		applyFontInfo(this.domNode, this._context.configuration.options.get(EditorOption.fontInfo));
	}

	public override shouldRender(): boolean {
		return super.shouldRender() || this._dynamicOverlays.some(overlay => overlay.shouldRender());
	}

	public getDomNode(): FastDomNode<HTMLElement> {
		return this.domNode;
	}

	public override dispose(): void {
		super.dispose();
		this._dynamicOverlays.length = 0;
	}

	public addDynamicOverlay(overlay: DynamicViewOverlay): void {
		this._dynamicOverlays.push(this._register(overlay));
	}

	public override onConfigurationChanged(_event: viewEvents.ViewConfigurationChangedEvent): boolean {
		applyFontInfo(this.domNode, this._context.configuration.options.get(EditorOption.fontInfo));
		return true;
	}

	public override onFlushed(_event: viewEvents.ViewFlushedEvent): boolean {
		return true;
	}

	public override onFocusChanged(event: viewEvents.ViewFocusChangedEvent): boolean {
		this._isFocused = event.isFocused;
		return true;
	}

	public override onLinesChanged(_event: viewEvents.ViewLinesChangedEvent): boolean {
		return true;
	}

	public override onLinesDeleted(_event: viewEvents.ViewLinesDeletedEvent): boolean {
		return true;
	}

	public override onLinesInserted(_event: viewEvents.ViewLinesInsertedEvent): boolean {
		return true;
	}

	public override onScrollChanged(_event: viewEvents.ViewScrollChangedEvent): boolean {
		return true;
	}

	public override onTokensChanged(_event: viewEvents.ViewTokensChangedEvent): boolean {
		return true;
	}

	public override onZonesChanged(_event: viewEvents.ViewZonesChangedEvent): boolean {
		return true;
	}

	public prepareRender(context: RenderingContext): void {
		const viewportChanged = !this._visibleLines.hasViewport(context.viewportData.startLineNumber, context.viewportData.endLineNumber);
		for (const overlay of this._dynamicOverlays) {
			if (!viewportChanged && !overlay.shouldRender()) continue;
			overlay.prepareRender(context);
			overlay.onDidRender();
		}
	}

	public render(context: RestrictedRenderingContext): void {
		this._viewOverlaysRender(context);
		this.domNode.toggleClassName('focused', this._isFocused);
	}

	protected _viewOverlaysRender(context: RestrictedRenderingContext): void {
		const startLineNumber = context.viewportData.startLineNumber;
		for (const [lineIndex, row] of this._visibleLines.render(context)) {
			const lineNumber = lineIndex + 1;
			row.innerHTML = this._dynamicOverlays
				.map(overlay => overlay.render(startLineNumber, lineNumber))
				.join('');
		}
	}
}

export class ContentViewOverlays extends ViewOverlays {
	private _contentWidth: number;

	constructor(context: ViewContext, host: HTMLElement) {
		super(context, host);
		this._contentWidth = this._context.configuration.options.get(EditorOption.layoutInfo).contentWidth;
		this.domNode.setHeight(0);
	}

	public override onConfigurationChanged(event: viewEvents.ViewConfigurationChangedEvent): boolean {
		this._contentWidth = this._context.configuration.options.get(EditorOption.layoutInfo).contentWidth;
		return super.onConfigurationChanged(event);
	}

	protected override _viewOverlaysRender(context: RestrictedRenderingContext): void {
		super._viewOverlaysRender(context);
		this.domNode.setWidth(Math.max(context.scrollWidth, this._contentWidth));
	}
}

export class MarginViewOverlays extends ViewOverlays {
	private _contentLeft: number;

	constructor(context: ViewContext, host: HTMLElement) {
		super(context, host);
		this._contentLeft = this._context.configuration.options.get(EditorOption.layoutInfo).contentLeft;
		this.domNode.setClassName('stanza-editor-row-layer margin-view-overlays');
		this.domNode.setWidth(1);
	}

	public override onConfigurationChanged(event: viewEvents.ViewConfigurationChangedEvent): boolean {
		this._contentLeft = this._context.configuration.options.get(EditorOption.layoutInfo).contentLeft;
		return super.onConfigurationChanged(event);
	}

	protected override _viewOverlaysRender(context: RestrictedRenderingContext): void {
		super._viewOverlaysRender(context);
		this.domNode.setHeight(Math.min(context.scrollHeight, 1_000_000));
		this.domNode.setWidth(this._contentLeft);
	}
}
