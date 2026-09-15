import { h } from '../../../../base/browser/dom.js';
import { createFastDomNode, type FastDomNode } from '../../../../base/browser/fastDomNode.js';
import { type IOverviewRuler } from '../../editorBrowser.js';
import { EditorOption, type OverviewRulerPosition } from '../../../common/config/editorOptions.js';
import { type ColorZone, type OverviewRulerZone, OverviewZoneManager } from '../../../common/viewModel/overviewZoneManager.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import * as viewEvents from '../../../common/viewEvents.js';
import { ViewEventHandler } from '../../../common/viewEventHandler.js';

export class OverviewRuler extends ViewEventHandler implements IOverviewRuler {
	private readonly _context: ViewContext;
	private readonly _domNode: FastDomNode<HTMLCanvasElement>;
	private readonly _zoneManager: OverviewZoneManager;

	constructor(context: ViewContext, cssClassName: string) {
		super();
		this._context = context;
		const options = context.configuration.options;
		this._domNode = createFastDomNode(h(document, 'canvas'));
		this._domNode.setClassName(cssClassName);
		this._domNode.setPosition('absolute');
		this._domNode.setLayerHinting(true);
		this._domNode.setContain('strict');
		this._domNode.setAttribute('aria-hidden', 'true');
		this._zoneManager = new OverviewZoneManager(lineNumber => context.viewLayout.getVerticalOffsetForLineNumber(lineNumber));
		this._zoneManager.setDOMWidth(0);
		this._zoneManager.setDOMHeight(0);
		this._zoneManager.setOuterHeight(context.viewLayout.getScrollHeight());
		this._zoneManager.setLineHeight(options.get(EditorOption.lineHeight));
		this._zoneManager.setPixelRatio(options.get(EditorOption.pixelRatio));
		context.addEventHandler(this);
	}

	public override dispose(): void {
		this._context.removeEventHandler(this);
		super.dispose();
	}

	public override onConfigurationChanged(event: viewEvents.ViewConfigurationChangedEvent): boolean {
		const options = this._context.configuration.options;
		if (event.hasChanged(EditorOption.lineHeight)) {
			this._zoneManager.setLineHeight(options.get(EditorOption.lineHeight));
			this._render();
		}
		if (event.hasChanged(EditorOption.pixelRatio)) {
			this._zoneManager.setPixelRatio(options.get(EditorOption.pixelRatio));
			this._domNode.setWidth(this._zoneManager.getDOMWidth());
			this._domNode.setHeight(this._zoneManager.getDOMHeight());
			this._domNode.domNode.width = this._zoneManager.getCanvasWidth();
			this._domNode.domNode.height = this._zoneManager.getCanvasHeight();
			this._render();
		}
		return true;
	}

	public override onFlushed(_event: viewEvents.ViewFlushedEvent): boolean {
		this._render();
		return true;
	}

	public override onScrollChanged(event: viewEvents.ViewScrollChangedEvent): boolean {
		if (event.scrollHeightChanged) {
			this._zoneManager.setOuterHeight(event.scrollHeight);
			this._render();
		}
		return true;
	}

	public override onZonesChanged(_event: viewEvents.ViewZonesChangedEvent): boolean {
		this._render();
		return true;
	}

	public getDomNode(): HTMLElement {
		return this._domNode.domNode;
	}

	public setLayout(position: OverviewRulerPosition): void {
		this._domNode.setTop(position.top);
		this._domNode.setRight(position.right);
		let changed = this._zoneManager.setDOMWidth(position.width);
		changed = this._zoneManager.setDOMHeight(position.height) || changed;
		if (!changed) return;
		this._domNode.setWidth(this._zoneManager.getDOMWidth());
		this._domNode.setHeight(this._zoneManager.getDOMHeight());
		this._domNode.domNode.width = this._zoneManager.getCanvasWidth();
		this._domNode.domNode.height = this._zoneManager.getCanvasHeight();
		this._render();
	}

	public setZones(zones: OverviewRulerZone[]): void {
		this._zoneManager.setZones(zones);
		this._render();
	}

	private _render(): boolean {
		if (this._zoneManager.getOuterHeight() === 0) return false;
		const width = this._zoneManager.getCanvasWidth();
		const height = this._zoneManager.getCanvasHeight();
		const colorZones = this._zoneManager.resolveColorZones();
		const id2Color = this._zoneManager.getId2Color();
		const context = this._domNode.domNode.getContext('2d');
		if (!context) return false;
		context.clearRect(0, 0, width, height);
		if (colorZones.length > 0) this._renderOneLane(context, colorZones, id2Color, width);
		return true;
	}

	private _renderOneLane(context: CanvasRenderingContext2D, zones: ColorZone[], id2Color: string[], width: number): void {
		let colorId = 0;
		let from = 0;
		let to = 0;
		for (const zone of zones) {
			if (zone.colorId !== colorId) {
				if (colorId !== 0) context.fillRect(0, from, width, to - from);
				colorId = zone.colorId;
				context.fillStyle = id2Color[colorId]!;
				from = zone.from;
				to = zone.to;
			} else if (to >= zone.from) {
				to = Math.max(to, zone.to);
			} else {
				context.fillRect(0, from, width, to - from);
				from = zone.from;
				to = zone.to;
			}
		}
		context.fillRect(0, from, width, to - from);
	}
}
