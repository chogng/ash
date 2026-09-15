import { createFastDomNode, type FastDomNode } from '../../../../base/browser/fastDomNode.js';
import { h, getClientArea, getDomNodePagePosition } from '../../../../base/browser/dom.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../base/common/lifecycle.js';
import { ContentWidgetPositionPreference, type IContentWidget, type IContentWidgetPosition, type IContentWidgetRenderedCoordinate } from '../../editorBrowser.js';
import { type IPosition, Position } from '../../../common/core/position.js';
import { type IDimension } from '../../../common/core/2d/dimension.js';
import { PositionAffinity } from '../../../common/model.js';
import { type RenderingContext, type RestrictedRenderingContext } from '../../view/renderingContext.js';
import { PartFingerprint, PartFingerprints, ViewPart } from '../../view/viewPart.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import * as viewEvents from '../../../common/viewEvents.js';
import { type ViewportData } from '../../../common/viewLayout/viewLinesViewportData.js';

interface BoxLayoutResult {
	readonly fitsAbove: boolean;
	readonly aboveTop: number;
	readonly fitsBelow: boolean;
	readonly belowTop: number;
	readonly left: number;
}

interface OffViewportRenderData {
	readonly kind: 'offViewport';
	readonly preserveFocus: boolean;
}

interface InViewportRenderData {
	readonly kind: 'inViewport';
	readonly coordinate: RenderedCoordinate;
	readonly position: ContentWidgetPositionPreference;
}

type RenderData = InViewportRenderData | OffViewportRenderData;

export class ViewContentWidgets extends ViewPart {
	public readonly domNode: FastDomNode<HTMLDivElement>;
	public readonly overflowingContentWidgetsDomNode: FastDomNode<HTMLDivElement>;
	private readonly widgets = this._register(new DisposableMap<string, ContentWidget>());

	constructor(context: ViewContext, private readonly viewDomNode: FastDomNode<HTMLElement>) {
		super(context);
		this.domNode = createFastDomNode(h(viewDomNode.domNode.ownerDocument, 'div'));
		PartFingerprints.write(this.domNode, PartFingerprint.ContentWidgets);
		this.domNode.setClassName('stanza-editor-content-widgets');
		this.domNode.setPosition('absolute');
		this.domNode.setTop(0);
		this.domNode.setAttribute('role', 'presentation');
		this.overflowingContentWidgetsDomNode = createFastDomNode(h(viewDomNode.domNode.ownerDocument, 'div'));
		PartFingerprints.write(this.overflowingContentWidgetsDomNode, PartFingerprint.OverflowingContentWidgets);
		this.overflowingContentWidgetsDomNode.setClassName('stanza-editor-overflowing-content-widgets');
		this.overflowingContentWidgetsDomNode.setAttribute('role', 'presentation');
		this._register(toDisposable(() => {
			this.domNode.domNode.remove();
			this.overflowingContentWidgetsDomNode.domNode.remove();
		}));
	}

	public override dispose(): void {
		super.dispose();
	}

	public override onConfigurationChanged(event: viewEvents.ViewConfigurationChangedEvent): boolean {
		for (const [, widget] of this.widgets) widget.onConfigurationChanged(event);
		return true;
	}

	public override onDecorationsChanged(_event: viewEvents.ViewDecorationsChangedEvent): boolean {
		return true;
	}

	public override onFlushed(_event: viewEvents.ViewFlushedEvent): boolean {
		return true;
	}

	public override onLineMappingChanged(_event: viewEvents.ViewLineMappingChangedEvent): boolean {
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

	public override onZonesChanged(_event: viewEvents.ViewZonesChangedEvent): boolean {
		return true;
	}

	public addWidget(widget: IContentWidget): void {
		const id = widget.getId();
		if (!id || this.widgets.has(id)) throw new RangeError(`Content widget '${id}' is already registered`);
		const contentWidget = this.widgets.set(id, new ContentWidget(this._context, this.viewDomNode, widget));
		if (contentWidget.allowEditorOverflow) {
			this.overflowingContentWidgetsDomNode.domNode.append(contentWidget.domNode.domNode);
		} else {
			this.domNode.domNode.append(contentWidget.domNode.domNode);
		}
		this.setShouldRender();
	}

	public setWidgetPosition(widget: IContentWidget, position: IContentWidgetPosition | null): void {
		const contentWidget = this.widget(widget);
		if (!contentWidget) return;
		contentWidget.setPosition(position);
		if (!contentWidget.useDisplayNone) this.setShouldRender();
	}

	public removeWidget(widget: IContentWidget): void {
		const id = widget.getId();
		if (!this.widget(widget)) return;
		this.widgets.deleteAndDispose(id);
		this.setShouldRender();
	}

	public shouldSuppressMouseDownOnWidget(widgetId: string): boolean {
		for (const [id, widget] of this.widgets) {
			if (id === widgetId) return widget.suppressMouseDown;
		}
		return false;
	}

	public override onBeforeRender(viewportData: ViewportData): void {
		for (const [, widget] of this.widgets) widget.onBeforeRender(viewportData);
	}

	public override prepareRender(context: RenderingContext): void {
		for (const [, widget] of this.widgets) widget.prepareRender(context);
	}

	public render(context: RestrictedRenderingContext): void {
		for (const [, widget] of this.widgets) widget.render(context);
	}

	private widget(widget: IContentWidget): ContentWidget | undefined {
		for (const [id, candidate] of this.widgets) {
			if (id === widget.getId() && candidate.actual === widget) return candidate;
		}
		return undefined;
	}
}

class ContentWidget extends Disposable {
	public readonly domNode: FastDomNode<HTMLElement>;
	public readonly id: string;
	public readonly allowEditorOverflow: boolean;
	public readonly useDisplayNone: boolean;
	public readonly suppressMouseDown: boolean;
	public readonly actual: IContentWidget;
	private readonly fixedOverflowWidgets: boolean;
	private position: IContentWidgetPosition | null = null;
	private cachedWidth = -1;
	private cachedHeight = -1;
	private maxWidth = -1;
	private visible = false;
	private renderData: RenderData | null = null;

	constructor(private readonly context: ViewContext, private readonly viewDomNode: FastDomNode<HTMLElement>, actual: IContentWidget) {
		super();
		this.actual = actual;
		this.id = actual.getId();
		this.allowEditorOverflow = Boolean(actual.allowEditorOverflow) && context.configuration.options.get(EditorOption.allowOverflow);
		this.useDisplayNone = Boolean(actual.useDisplayNone);
		this.suppressMouseDown = Boolean(actual.suppressMouseDown);
		this.fixedOverflowWidgets = context.configuration.options.get(EditorOption.fixedOverflowWidgets);
		this.domNode = createFastDomNode(actual.getDomNode());
		this.domNode.setPosition(this.fixedOverflowWidgets && this.allowEditorOverflow ? 'fixed' : 'absolute');
		this.domNode.setDisplay('none');
		this.domNode.setVisibility('hidden');
		this.domNode.setAttribute('widgetId', this.id);
		this._register(toDisposable(() => {
			this.domNode.domNode.remove();
			this.domNode.removeAttribute('widgetId');
			this.domNode.removeAttribute('data-stanza-visible-content-widget');
		}));
	}

	public onConfigurationChanged(event: viewEvents.ViewConfigurationChangedEvent): void {
		if (event.hasChanged(EditorOption.layoutInfo) || event.hasChanged(EditorOption.fontInfo)) {
			this.maxWidth = -1;
			this.cachedWidth = -1;
			this.cachedHeight = -1;
		}
	}

	public onBeforeRender(viewportData: ViewportData): void {
		const position = this.position?.position;
		if (!position) return;
		const viewPosition = this.context.viewModel.coordinatesConverter.convertModelPositionToViewPosition(this.context.viewModel.model.validatePosition(position), this.position?.positionAffinity);
		if (viewPosition.lineNumber < viewportData.startLineNumber || viewPosition.lineNumber > viewportData.endLineNumber) return;
		this.updateMaxWidth();
	}

	public setPosition(position: IContentWidgetPosition | null): void {
		this.position = position;
		const wantsDisplay = !this.useDisplayNone && position?.position !== null && position?.position !== undefined && position.preference.length > 0;
		this.domNode.setDisplay(wantsDisplay ? 'block' : 'none');
		this.cachedWidth = -1;
		this.cachedHeight = -1;
	}

	public prepareRender(context: RenderingContext): void {
		this.renderData = this.prepareRenderData(context);
	}

	public render(_context: RestrictedRenderingContext): void {
		const renderData = this.renderData;
		if (!renderData || renderData.kind === 'offViewport') {
			if (renderData?.preserveFocus) {
				this.domNode.setTop(-1000);
				this.domNode.setVisibility('inherit');
			} else {
				this.domNode.setVisibility('hidden');
			}
			if (this.visible) {
				this.domNode.removeAttribute('data-stanza-visible-content-widget');
				this.visible = false;
			}
			safeInvoke(this.actual.afterRender, this.actual, null, null);
			return;
		}

		this.domNode.setTop(renderData.coordinate.top);
		this.domNode.setLeft(renderData.coordinate.left);
		if (!this.visible) {
			this.domNode.setVisibility('inherit');
			this.domNode.setAttribute('data-stanza-visible-content-widget', 'true');
			this.visible = true;
		}
		safeInvoke(this.actual.afterRender, this.actual, renderData.position, renderData.coordinate);
	}

	private prepareRenderData(context: RenderingContext): RenderData | null {
		const position = this.position;
		if (this.useDisplayNone || !position || !position.position || position.preference.length === 0) return null;
		const primary = anchorCoordinate(context, this.context, position.position, position.positionAffinity);
		if (!primary) {
			return {
				kind: 'offViewport',
				preserveFocus: this.domNode.domNode.contains(this.domNode.domNode.ownerDocument.activeElement),
			};
		}
		const secondary = position.secondaryPosition ? anchorCoordinate(context, this.context, position.secondaryPosition, position.positionAffinity) : null;
		this.updateDimensions();
		const anchor = reduceAnchor(primary, secondary?.visualLineIndex === primary.visualLineIndex ? secondary : null, this.cachedWidth, this.context);
		const placement = this.allowEditorOverflow
			? this.layoutBoxInPage(anchor, context)
			: layoutBoxInViewport(anchor, this.cachedWidth, this.cachedHeight, context);
		for (let pass = 1; pass <= 2; pass += 1) {
			for (const preference of position.preference) {
				if (preference === ContentWidgetPositionPreference.ABOVE && placement && (pass === 2 || placement.fitsAbove)) {
					return { kind: 'inViewport', coordinate: new RenderedCoordinate(placement.aboveTop, placement.left), position: preference };
				}
				if (preference === ContentWidgetPositionPreference.BELOW && placement && (pass === 2 || placement.fitsBelow)) {
					return { kind: 'inViewport', coordinate: new RenderedCoordinate(placement.belowTop, placement.left), position: preference };
				}
				if (preference === ContentWidgetPositionPreference.EXACT) {
					return { kind: 'inViewport', coordinate: this.exactCoordinate(anchor, context), position: preference };
				}
			}
		}
		return null;
	}

	private updateDimensions(): void {
		this.updateMaxWidth();
		if (this.cachedWidth >= 0 && this.cachedHeight >= 0) return;
		const preferred = safeInvoke(this.actual.beforeRender, this.actual);
		if (preferred && validDimension(preferred)) {
			this.cachedWidth = preferred.width;
			this.cachedHeight = preferred.height;
			return;
		}
		const rectangle = this.domNode.domNode.getBoundingClientRect();
		this.cachedWidth = Math.round(rectangle.width);
		this.cachedHeight = Math.round(rectangle.height);
	}

	private updateMaxWidth(): void {
		const layoutInfo = this.context.configuration.options.get(EditorOption.layoutInfo);
		const nextMaxWidth = this.allowEditorOverflow
			? getClientArea(this.viewDomNode.domNode.ownerDocument.body).width
			: Math.max(0, layoutInfo.contentWidth);
		if (nextMaxWidth !== this.maxWidth) {
			this.maxWidth = nextMaxWidth;
			this.domNode.setMaxWidth(nextMaxWidth);
			this.cachedWidth = -1;
			this.cachedHeight = -1;
		}
	}

	private layoutBoxInPage(anchor: AnchorCoordinate, context: RenderingContext): BoxLayoutResult {
		const viewPosition = getDomNodePagePosition(this.viewDomNode.domNode);
		const ownerWindow = this.viewDomNode.domNode.ownerDocument.defaultView;
		const windowScrollLeft = ownerWindow?.scrollX ?? 0;
		const windowScrollTop = ownerWindow?.scrollY ?? 0;
		const viewport = getClientArea(this.viewDomNode.domNode.ownerDocument.body);
		const fixed = this.fixedOverflowWidgets;
		const contentLeft = this.context.configuration.options.get(EditorOption.layoutInfo).contentLeft;
		const anchorLeft = viewPosition.left + contentLeft + anchor.left - context.scrollLeft - (fixed ? windowScrollLeft : 0);
		const anchorTop = viewPosition.top + anchor.top - context.scrollTop - (fixed ? windowScrollTop : 0);
		const minimumLeft = (fixed ? 0 : windowScrollLeft) + 15;
		const maximumRight = (fixed ? viewport.width : windowScrollLeft + viewport.width) - 15;
		const left = Math.min(Math.max(anchorLeft, minimumLeft), Math.max(minimumLeft, maximumRight - this.cachedWidth));
		const viewportTop = (fixed ? 0 : windowScrollTop) + 22;
		const viewportBottom = (fixed ? viewport.height : windowScrollTop + viewport.height) - 22;
		return {
			fitsAbove: anchorTop - this.cachedHeight >= viewportTop,
			aboveTop: Math.max(viewportTop, anchorTop - this.cachedHeight),
			fitsBelow: anchorTop + anchor.height + this.cachedHeight <= viewportBottom,
			belowTop: anchorTop + anchor.height,
			left,
		};
	}

	private exactCoordinate(anchor: AnchorCoordinate, context: RenderingContext): RenderedCoordinate {
		if (!this.allowEditorOverflow) return new RenderedCoordinate(anchor.top, anchor.left);
		const placement = this.layoutBoxInPage(anchor, context);
		const viewPosition = getDomNodePagePosition(this.viewDomNode.domNode);
		const ownerWindow = this.viewDomNode.domNode.ownerDocument.defaultView;
		return new RenderedCoordinate(
			viewPosition.top + anchor.top - context.scrollTop - (this.fixedOverflowWidgets ? ownerWindow?.scrollY ?? 0 : 0),
			placement.left,
		);
	}
}

class AnchorCoordinate {
	constructor(
		public readonly top: number,
		public readonly left: number,
		public readonly height: number,
		public readonly visualLineIndex: number,
	) {}
}

class RenderedCoordinate implements IContentWidgetRenderedCoordinate {
	constructor(
		public readonly top: number,
		public readonly left: number,
	) {}
}

function anchorCoordinate(context: RenderingContext, viewContext: ViewContext, position: IPosition, affinity: PositionAffinity | undefined): AnchorCoordinate | null {
	let validPosition: Position;
	try {
		validPosition = viewContext.viewModel.model.validatePosition(Position.lift(position));
	} catch {
		return null;
	}
	const viewPosition = viewContext.viewModel.coordinatesConverter.convertModelPositionToViewPosition(validPosition, affinity);
	const visualLineIndex = viewPosition.lineNumber - 1;
	if (viewPosition.lineNumber < context.viewportData.startLineNumber || viewPosition.lineNumber > context.viewportData.endLineNumber) return null;
	const renderedPosition = context.visibleRangeForPosition(viewPosition);
	if (!renderedPosition) return null;
	const left = viewPosition.column === 1 && affinity === PositionAffinity.LeftOfInjectedText
		? 0
		: renderedPosition.left;
	return new AnchorCoordinate(context.getVerticalOffsetForLineNumber(viewPosition.lineNumber), left, context.getLineHeightForLineNumber(viewPosition.lineNumber), visualLineIndex);
}

function reduceAnchor(primary: AnchorCoordinate, secondary: AnchorCoordinate | null, width: number, context: ViewContext): AnchorCoordinate {
	if (!secondary) return primary;
	const clearance = context.configuration.options.get(EditorOption.fontInfo).typicalFullwidthCharacterWidth;
	const left = secondary.left < primary.left
		? Math.max(secondary.left, primary.left - width + clearance)
		: Math.min(secondary.left, primary.left + width - clearance);
	return new AnchorCoordinate(primary.top, left, primary.height, primary.visualLineIndex);
}

function layoutBoxInViewport(anchor: AnchorCoordinate, width: number, height: number, context: RenderingContext): BoxLayoutResult {
	const scrollTop = context.scrollTop;
	const scrollLeft = context.scrollLeft;
	const viewportBottom = scrollTop + context.viewportHeight;
	const viewportRight = scrollLeft + context.viewportWidth;
	return {
		fitsAbove: anchor.top - scrollTop >= height,
		aboveTop: anchor.top - height,
		fitsBelow: viewportBottom - (anchor.top + anchor.height) >= height,
		belowTop: anchor.top + anchor.height,
		left: Math.max(scrollLeft, Math.min(anchor.left, viewportRight - width)),
	};
}

function validDimension(dimension: IDimension): boolean {
	return Number.isFinite(dimension.width) && dimension.width >= 0 && Number.isFinite(dimension.height) && dimension.height >= 0;
}

function safeInvoke<TArguments extends unknown[], TResult>(fn: ((...arguments_: TArguments) => TResult) | undefined, thisArgument: unknown, ...arguments_: TArguments): TResult | null {
	if (!fn) return null;
	try {
		return fn.apply(thisArgument, arguments_);
	} catch {
		return null;
	}
}
