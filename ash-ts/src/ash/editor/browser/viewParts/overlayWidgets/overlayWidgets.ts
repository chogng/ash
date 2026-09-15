import './overlayWidgets.css';
import { createFastDomNode, type FastDomNode } from '../../../../base/browser/fastDomNode.js';
import { h, getDomNodePagePosition, type IDomNodePagePosition } from '../../../../base/browser/dom.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../base/common/lifecycle.js';
import { type IOverlayWidget, type IOverlayWidgetPosition, type IOverlayWidgetPositionCoordinates, OverlayWidgetPositionPreference } from '../../editorBrowser.js';
import { type RestrictedRenderingContext } from '../../view/renderingContext.js';
import { PartFingerprint, PartFingerprints, ViewPart } from '../../view/viewPart.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import * as viewEvents from '../../../common/viewEvents.js';

interface ViewOverlayWidgetsOptions {
	readonly viewDomNode: HTMLElement;
	readonly requestRender: () => void;
}

interface OverlayWidgetHost {
	readonly viewDomNode: HTMLElement;
	readonly canOverflow: (widget: IOverlayWidget) => boolean;
	readonly usesFixedPosition: () => boolean;
	readonly requestRender: () => void;
}

interface OverlayWidgetLayout {
	readonly editorWidth: number;
	readonly editorHeight: number;
	readonly minimapWidth: number;
	readonly verticalScrollbarWidth: number;
	readonly horizontalScrollbarHeight: number;
}

/** Owns widgets positioned against the editor viewport rather than document content. */
export class ViewOverlayWidgets extends ViewPart {
	private readonly _viewDomNode: HTMLElement;
	private readonly _domNode: FastDomNode<HTMLDivElement>;
	public readonly overflowingOverlayWidgetsDomNode: FastDomNode<HTMLDivElement>;
	private readonly _widgets = this._register(new DisposableMap<string, OverlayWidget>());
	private _viewDomNodeRect: IDomNodePagePosition | null = null;
	private _verticalScrollbarWidth: number;
	private _minimapWidth = 0;
	private _horizontalScrollbarHeight: number;
	private _editorHeight = 0;
	private _editorWidth = 0;

	constructor(context: ViewContext, private readonly options: ViewOverlayWidgetsOptions) {
		super(context);
		this._viewDomNode = options.viewDomNode;
		const layout = readOverlayLayout(context);
		this._verticalScrollbarWidth = layout.verticalScrollbarWidth;
		this._minimapWidth = layout.minimapWidth;
		this._horizontalScrollbarHeight = layout.horizontalScrollbarHeight;
		this._editorHeight = layout.editorHeight;
		this._editorWidth = layout.editorWidth;
		this._domNode = createFastDomNode(h(options.viewDomNode.ownerDocument, 'div'));
		PartFingerprints.write(this._domNode, PartFingerprint.OverlayWidgets);
		this._domNode.setClassName('stanza-editor-overlay-widgets');
		this._domNode.setPosition('absolute');
		this._domNode.setTop(0);
		this._domNode.setAttribute('role', 'presentation');
		this.overflowingOverlayWidgetsDomNode = createFastDomNode(h(options.viewDomNode.ownerDocument, 'div'));
		PartFingerprints.write(this.overflowingOverlayWidgetsDomNode, PartFingerprint.OverflowingOverlayWidgets);
		this.overflowingOverlayWidgetsDomNode.setClassName('stanza-editor-overflowing-overlay-widgets');
		this.overflowingOverlayWidgetsDomNode.setAttribute('role', 'presentation');
		this._register(toDisposable(() => {
			this._domNode.domNode.remove();
			this.overflowingOverlayWidgetsDomNode.domNode.remove();
		}));
	}

	public override dispose(): void {
		super.dispose();
	}

	public getDomNode(): FastDomNode<HTMLElement> {
		return this._domNode;
	}

	public override onConfigurationChanged(_event: viewEvents.ViewConfigurationChangedEvent): boolean {
		const layout = readOverlayLayout(this._context);
		this._verticalScrollbarWidth = layout.verticalScrollbarWidth;
		this._minimapWidth = layout.minimapWidth;
		this._horizontalScrollbarHeight = layout.horizontalScrollbarHeight;
		this._editorHeight = layout.editorHeight;
		this._editorWidth = layout.editorWidth;
		for (const [, widget] of this._widgets) {
			const container = this._widgetCanOverflow(widget.actual) ? this.overflowingOverlayWidgetsDomNode : this._domNode;
			if (widget.domNode.domNode.parentElement !== container.domNode) container.domNode.append(widget.domNode.domNode);
			widget.updatePositionMode();
		}
		return true;
	}

	private _widgetCanOverflow(widget: IOverlayWidget): boolean {
		return Boolean(widget.allowEditorOverflow) && this._context.configuration.options.get(EditorOption.allowOverflow);
	}

	public addWidget(widget: IOverlayWidget): void {
		const id = widget.getId();
		if (!id || this._widgets.has(id)) throw new RangeError(`Overlay widget '${id}' is already registered`);
		const overlayWidget = this._widgets.set(id, new OverlayWidget({
			viewDomNode: this._viewDomNode,
			canOverflow: candidate => this._widgetCanOverflow(candidate),
			usesFixedPosition: () => this._context.configuration.options.get(EditorOption.fixedOverflowWidgets),
			requestRender: this.options.requestRender,
		}, widget));
		const container = this._widgetCanOverflow(widget) ? this.overflowingOverlayWidgetsDomNode : this._domNode;
		container.domNode.append(overlayWidget.domNode.domNode);
		this._updateMaxMinWidth();
	}

	public setWidgetPosition(widget: IOverlayWidget, position: IOverlayWidgetPosition | null): boolean {
		const candidate = findOverlayWidget(this._widgets, widget);
		if (candidate?.actual !== widget) return false;
		const changed = candidate.setPosition(position);
		this._updateMaxMinWidth();
		return changed;
	}

	public removeWidget(widget: IOverlayWidget): void {
		const id = widget.getId();
		const candidate = findOverlayWidget(this._widgets, widget);
		if (candidate?.actual !== widget) return;
		this._widgets.deleteAndDispose(id);
		this._updateMaxMinWidth();
	}

	public override prepareRender(): void {
		this._viewDomNodeRect = getDomNodePagePosition(this._viewDomNode);
	}

	public render(context: RestrictedRenderingContext): void {
		this._editorWidth = context.viewportWidth;
		this._editorHeight = context.viewportHeight;
		this._domNode.setWidth(this._editorWidth);
		const stacks = new Map<OverlayWidgetPositionPreference, number>();
		for (const preference of [OverlayWidgetPositionPreference.TOP_RIGHT_CORNER, OverlayWidgetPositionPreference.BOTTOM_RIGHT_CORNER, OverlayWidgetPositionPreference.TOP_CENTER]) {
			stacks.set(preference, 0);
		}
		const widgets = [...this._widgets].map(([, widget]) => widget);
		widgets.sort((left, right) => (left.position?.stackOrdinal ?? 0) - (right.position?.stackOrdinal ?? 0));
		for (const widget of widgets) {
			const preference = widget.position?.preference;
			const stackOffset = typeof preference === 'number' ? stacks.get(preference) ?? 0 : 0;
			this._renderWidget(widget, context, stackOffset);
			if (typeof preference === 'number') stacks.set(preference, stackOffset + widget.height);
		}
	}

	private _renderWidget(widget: OverlayWidget, context: RestrictedRenderingContext, stackOffset: number): void {
		widget.render(context, this._viewDomNodeRect, stackOffset, {
			editorWidth: this._editorWidth,
			editorHeight: this._editorHeight,
			minimapWidth: this._minimapWidth,
			verticalScrollbarWidth: this._verticalScrollbarWidth,
			horizontalScrollbarHeight: this._horizontalScrollbarHeight,
		});
	}

	private _updateMaxMinWidth(): void {
		let minimumContentWidth = 0;
		for (const [, widget] of this._widgets) minimumContentWidth = Math.max(minimumContentWidth, widget.minimumContentWidth);
		this._context.viewLayout.setOverlayWidgetsMinWidth(minimumContentWidth);
	}
}

function findOverlayWidget(widgets: DisposableMap<string, OverlayWidget>, actual: IOverlayWidget): OverlayWidget | undefined {
	for (const [id, candidate] of widgets) {
		if (id === actual.getId() && candidate.actual === actual) return candidate;
	}
	return undefined;
}

class OverlayWidget extends Disposable {
	public readonly domNode: FastDomNode<HTMLElement>;
	public readonly allowEditorOverflow: boolean;
	public readonly actual: IOverlayWidget;
	public position: IOverlayWidgetPosition | null;
	public height = 0;

	constructor(private readonly host: OverlayWidgetHost, actual: IOverlayWidget) {
		super();
		this.actual = actual;
		this.position = actual.getPosition();
		this.allowEditorOverflow = Boolean(actual.allowEditorOverflow);
		this.domNode = createFastDomNode(actual.getDomNode());
		this.updatePositionMode();
		this.domNode.setAttribute('widgetId', actual.getId());
		if (actual.onDidLayout) this._register(actual.onDidLayout(() => host.requestRender()));
		this._register(toDisposable(() => {
			this.domNode.domNode.remove();
			this.domNode.removeAttribute('widgetId');
		}));
	}

	public get minimumContentWidth(): number {
		const width = this.actual.getMinContentWidthInPx?.();
		return typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : 0;
	}

	public setPosition(position: IOverlayWidgetPosition | null): boolean {
		if (samePosition(this.position, position)) return false;
		this.position = position;
		return true;
	}

	public updatePositionMode(): void {
		this.domNode.setPosition(this.host.canOverflow(this.actual) && this.host.usesFixedPosition() ? 'fixed' : 'absolute');
	}

	public render(context: RestrictedRenderingContext, viewPagePosition: IDomNodePagePosition | null, stackOffset: number, layout: OverlayWidgetLayout): void {
		const preference = this.position?.preference;
		this.domNode.setDisplay(preference === null || preference === undefined ? 'none' : 'block');
		if (preference === null || preference === undefined) return;
		const rectangle = this.domNode.domNode.getBoundingClientRect();
		const width = rectangle.width || this.domNode.domNode.offsetWidth;
		this.height = rectangle.height || this.domNode.domNode.offsetHeight;
		const coordinates = isCoordinates(preference)
			? this.coordinatePosition(preference, context, viewPagePosition)
			: this.preferredPosition(preference, context, width, this.height, stackOffset, viewPagePosition, layout);
		this.domNode.setLeft(coordinates.left);
		this.domNode.setTop(coordinates.top);
	}

	private coordinatePosition(position: IOverlayWidgetPositionCoordinates, context: RestrictedRenderingContext, viewPagePosition: IDomNodePagePosition | null): IOverlayWidgetPositionCoordinates {
		if (!this.host.canOverflow(this.actual) || !viewPagePosition) return position;
		const targetWindow = this.host.viewDomNode.ownerDocument.defaultView;
		const fixed = this.host.usesFixedPosition();
		return {
			left: viewPagePosition.left + position.left - (fixed ? targetWindow?.scrollX ?? 0 : 0),
			top: viewPagePosition.top + position.top - (fixed ? targetWindow?.scrollY ?? 0 : 0),
		};
	}

	private preferredPosition(preference: OverlayWidgetPositionPreference, context: RestrictedRenderingContext, width: number, height: number, stackOffset: number, viewPagePosition: IDomNodePagePosition | null, layout: OverlayWidgetLayout): IOverlayWidgetPositionCoordinates {
		const right = Math.max(0, layout.editorWidth - layout.verticalScrollbarWidth - layout.minimapWidth);
		let left = 0;
		let top = 0;
		if (preference === OverlayWidgetPositionPreference.TOP_RIGHT_CORNER) {
			left = Math.max(0, right - width);
			top = stackOffset;
		} else if (preference === OverlayWidgetPositionPreference.BOTTOM_RIGHT_CORNER) {
			left = Math.max(0, right - width);
			top = Math.max(0, layout.editorHeight - layout.horizontalScrollbarHeight - height - stackOffset);
		} else {
			left = Math.max(0, Math.round((layout.editorWidth - width) / 2));
			top = stackOffset;
		}
		return this.coordinatePosition({ left, top }, context, viewPagePosition);
	}
}

function readOverlayLayout(context: ViewContext): {
	readonly verticalScrollbarWidth: number;
	readonly minimapWidth: number;
	readonly horizontalScrollbarHeight: number;
	readonly editorHeight: number;
	readonly editorWidth: number;
} {
	const options = context.configuration.options;
	const layout = options.get(EditorOption.layoutInfo);
	return {
		verticalScrollbarWidth: layout.verticalScrollbarWidth,
		minimapWidth: layout.minimap.minimapWidth,
		horizontalScrollbarHeight: layout.horizontalScrollbarHeight,
		editorHeight: layout.height,
		editorWidth: layout.width,
	};
}

function isCoordinates(value: OverlayWidgetPositionPreference | IOverlayWidgetPositionCoordinates): value is IOverlayWidgetPositionCoordinates {
	return typeof value === 'object';
}

function samePosition(left: IOverlayWidgetPosition | null, right: IOverlayWidgetPosition | null): boolean {
	if (left === right) return true;
	if (!left || !right || left.stackOrdinal !== right.stackOrdinal) return false;
	const leftPreference = left.preference;
	const rightPreference = right.preference;
	if (leftPreference === rightPreference) return true;
	if (leftPreference === null || rightPreference === null) return false;
	return isCoordinates(leftPreference) && isCoordinates(rightPreference)
		&& leftPreference.top === rightPreference.top
		&& leftPreference.left === rightPreference.left;
}
