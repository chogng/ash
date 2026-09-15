import { addDisposableListener } from '../../../base/browser/dom.js';
import { StandardWheelEvent } from '../../../base/browser/mouseEvent.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { EditorOption } from '../../common/config/editorOptions.js';
import { Position } from '../../common/core/position.js';
import { TextDirection } from '../../common/model.js';
import { ViewEventHandler } from '../../common/viewEventHandler.js';
import { type ViewContext } from '../../common/viewModel/viewContext.js';
import { type ViewConfigurationChangedEvent, type ViewCursorStateChangedEvent, type ViewFocusChangedEvent } from '../../common/viewEvents.js';
import { NavigationCommandRevealType } from '../coreCommands.js';
import { type IEditorMouseEvent, type IMouseTarget, type IMouseTargetOutsideEditor, MouseTargetType } from '../editorBrowser.js';
import { ClientCoordinates, EditorMouseEvent, EditorMouseEventFactory, createCoordinatesRelativeToEditor, createEditorPagePosition } from '../editorDom.js';
import { type HorizontalPosition } from '../view/renderingContext.js';
import { type IMouseDispatchData, type ViewController } from '../view/viewController.js';
import { type ViewLinesGpu } from '../viewParts/viewLinesGpu/viewLinesGpu.js';
import { LeftRightDragScrolling, TopBottomDragScrolling } from './dragScrolling.js';
import { MouseTarget, MouseTargetFactory, PointerHandlerLastRenderData } from './mouseTarget.js';
import { PointerHandler } from './pointerHandler.js';

export interface IPointerHandlerHelper {
	viewDomNode: HTMLElement;
	linesContentDomNode: HTMLElement;
	viewLinesDomNode: HTMLElement;
	viewLinesGpu: ViewLinesGpu | undefined;
	focusTextArea(): void;
	dispatchTextAreaEvent(event: CustomEvent): void;
	getLastRenderData(): PointerHandlerLastRenderData;
	renderNow(): void;
	shouldSuppressMouseDownOnViewZone(viewZoneId: string): boolean;
	shouldSuppressMouseDownOnWidget(widgetId: string): boolean;
	getPositionFromDOMInfo(spanNode: HTMLElement, offset: number): Position | null;
	visibleRangeForPosition(lineNumber: number, column: number): HorizontalPosition | null;
	getLineWidth(lineNumber: number): number;
}

interface PointerGesture {
	readonly pointerId: number;
	readonly startedOnLineNumbers: boolean;
	readonly mouseDownCount: number;
	readonly altKey: boolean;
	readonly ctrlKey: boolean;
	readonly metaKey: boolean;
	readonly shiftKey: boolean;
	readonly leftButton: boolean;
	readonly middleButton: boolean;
}

/** Owns editor pointer gestures and publishes one canonical IMouseTarget contract. */
export class MouseHandler extends ViewEventHandler {
	protected readonly _context: ViewContext;
	protected readonly viewController: ViewController;
	protected readonly viewHelper: IPointerHandlerHelper;
	protected readonly mouseTargetFactory: MouseTargetFactory;
	protected readonly _mouseDownOperation = this._register(new DisposableStore());
	private readonly pointerHandler: PointerHandler;
	private readonly topBottomDragScrolling: TopBottomDragScrolling;
	private readonly leftRightDragScrolling: LeftRightDragScrolling;
	private gesture: PointerGesture | undefined;
	private suppressNextMouseUp = false;

	constructor(context: ViewContext, viewController: ViewController, viewHelper: IPointerHandlerHelper) {
		super();
		this._context = context;
		this.viewController = viewController;
		this.viewHelper = viewHelper;
		this.mouseTargetFactory = new MouseTargetFactory(context, viewHelper);
		this.pointerHandler = this._register(new PointerHandler(viewHelper.viewDomNode));
		this.topBottomDragScrolling = this._register(new TopBottomDragScrolling(
			this._context,
			this.viewHelper,
			this.mouseTargetFactory,
			(target, inSelectionMode, revealType) => this.dispatchTarget(target, inSelectionMode, revealType),
		));
		this.leftRightDragScrolling = this._register(new LeftRightDragScrolling(
			this._context,
			this.viewHelper,
			this.mouseTargetFactory,
			(target, inSelectionMode, revealType) => this.dispatchTarget(target, inSelectionMode, revealType),
		));
		context.addEventHandler(this);
		this._register(toDisposable(() => context.removeEventHandler(this)));
		this._register(this.pointerHandler.onDidPointerDown(({ event, pointerId }) => this._onMouseDown(event, pointerId)));
		this._register(this.pointerHandler.onDidContextMenu(event => this._onContextMenu(event)));
		const mouseEvents = new EditorMouseEventFactory(viewHelper.viewDomNode);
		this._register(mouseEvents.onMouseMove(viewHelper.viewDomNode, event => this._onMouseMove(event)));
		this._register(mouseEvents.onMouseLeave(viewHelper.viewDomNode, event => this._onMouseLeave(event)));
		this._register(mouseEvents.onMouseUp(viewHelper.viewDomNode, event => this._onMouseUp(event)));
		this._register(addDisposableListener<WheelEvent>(viewHelper.viewDomNode, 'wheel', event => this._onMouseWheel(event)));
		this._register(addDisposableListener<DragEvent>(viewHelper.viewDomNode, 'drop', event => this._onDrop(event)));
		this._register(toDisposable(() => this.stopPointerSelection()));
	}

	public getTargetAtClientPoint(clientX: number, clientY: number): IMouseTarget {
		const editorPos = createEditorPagePosition(this.viewHelper.viewDomNode);
		const pos = new ClientCoordinates(clientX, clientY).toPageCoordinates(this.viewHelper.viewDomNode.ownerDocument.defaultView!);
		const relativePos = createCoordinatesRelativeToEditor(this.viewHelper.viewDomNode, editorPos, pos);
		return this.mouseTargetFactory.createMouseTarget(this.viewHelper.getLastRenderData(), editorPos, pos, relativePos, null);
	}

	public override onConfigurationChanged(event: ViewConfigurationChangedEvent): boolean {
		if (event.hasChanged(EditorOption.layoutInfo)) this.stopPointerSelection();
		return false;
	}
	public override onCursorStateChanged(_event: ViewCursorStateChangedEvent): boolean { return false; }
	public override onFocusChanged(_event: ViewFocusChangedEvent): boolean { return false; }

	protected _createMouseTarget(event: EditorMouseEvent, testEventTarget: boolean): IMouseTarget {
		const target = testEventTarget ? eventTargetElement(event.target, this.viewHelper.viewDomNode.ownerDocument) : null;
		return this.mouseTargetFactory.createMouseTarget(this.viewHelper.getLastRenderData(), event.editorPos, event.pos, event.relativePos, target);
	}

	private _getMouseColumn(event: EditorMouseEvent): number {
		return this.mouseTargetFactory.getMouseColumn(event.relativePos);
	}

	protected _onContextMenu(event: EditorMouseEvent): void {
		this.viewController.emitContextMenu(this.toEditorMouseEvent(event, this._createMouseTarget(event, true)));
	}

	protected _onMouseDown(event: EditorMouseEvent, pointerId: number): void {
		this.suppressNextMouseUp = false;
		const target = this._createMouseTarget(event, true);
		const editorEvent = this.toEditorMouseEvent(event, target);
		const suppressedViewZone = isViewZone(target) && this.viewHelper.shouldSuppressMouseDownOnViewZone(target.detail.viewZoneId);
		const suppressedWidget = isWidget(target) && this.viewHelper.shouldSuppressMouseDownOnWidget(target.detail);
		if (suppressedWidget && (event.leftButton || event.middleButton)) {
			event.preventDefault();
			this.viewHelper.focusTextArea();
		}
		if (event.defaultPrevented || (!event.leftButton && !event.middleButton) || target.type === MouseTargetType.UNKNOWN || target.type === MouseTargetType.SCROLLBAR || isWidget(target) || isViewZone(target) && !suppressedViewZone || !target.position) {
			this.viewController.emitMouseDown(editorEvent);
			return;
		}
		event.preventDefault();
		this.viewHelper.focusTextArea();
		this.stopPointerSelection();
		try {
			this.gesture = {
				pointerId,
				startedOnLineNumbers: target.type === MouseTargetType.GUTTER_LINE_NUMBERS,
				mouseDownCount: Math.min(Math.max(1, event.detail), 4),
				altKey: event.altKey,
				ctrlKey: event.ctrlKey,
				metaKey: event.metaKey,
				shiftKey: event.shiftKey,
				leftButton: event.leftButton,
				middleButton: event.middleButton,
			};
			this.dispatchTarget(target, false);
			this.pointerHandler.capturePointer(pointerId);
			this._mouseDownOperation.add(this.pointerHandler.startTracking(pointerId, event.buttons || buttonMask(event), {
				onMove: event => this.updatePointerSelection(event),
				onUp: event => this.finishPointerSelection(event),
				onCancel: () => this.stopPointerSelection(),
				onBlur: () => this.stopPointerSelection(),
			}));
		} catch (error) {
			this.stopPointerSelection();
			throw error;
		}
		this.viewController.emitMouseDown(editorEvent);
	}

	protected _onMouseMove(event: EditorMouseEvent): void {
		if (this.gesture) return;
		this.viewController.emitMouseMove(this.toEditorMouseEvent(event, this._createMouseTarget(event, true)));
	}

	protected _onMouseLeave(event: EditorMouseEvent): void {
		this.viewController.emitMouseLeave({ event, target: null });
	}

	protected _onMouseUp(event: EditorMouseEvent): void {
		if (this.suppressNextMouseUp) {
			this.suppressNextMouseUp = false;
			return;
		}
		if (this.gesture) {
			this.finishSelectionAt(event);
			return;
		}
		this.viewController.emitMouseUp(this.toEditorMouseEvent(event, this._createMouseTarget(event, true)));
	}

	protected _onMouseWheel(event: WheelEvent): void {
		this.viewController.emitMouseWheel(new StandardWheelEvent(event, { lineHeight: this._context.configuration.options.get(EditorOption.lineHeight) }));
	}

	private _onDrop(event: DragEvent): void {
		const editorEvent = new EditorMouseEvent(event, false, this.viewHelper.viewDomNode);
		const target = Number.isFinite(event.clientX) && Number.isFinite(event.clientY) ? this._createMouseTarget(editorEvent, true) : null;
		this.viewController.emitMouseDrop({ event: editorEvent, target });
	}

	private updatePointerSelection(event: EditorMouseEvent): void {
		if (!this.accepts(event)) return;
		const target = this.findMousePosition(event, false);
		if (!target) return;
		if (target.type === MouseTargetType.OUTSIDE_EDITOR) {
			this.startDragScrolling(target, event);
		} else {
			this.stopDragScrolling();
			this.dispatchTarget(target, true, NavigationCommandRevealType.Minimal);
		}
		this.viewController.emitMouseDrag(this.toEditorMouseEvent(event, target));
	}

	private finishPointerSelection(event: EditorMouseEvent): void {
		if (!this.accepts(event)) return;
		this.suppressNextMouseUp = true;
		this.finishSelectionAt(event);
	}

	private finishSelectionAt(event: EditorMouseEvent): void {
		try {
			const target = this.findMousePosition(event, false);
			if (target) {
				this.dispatchTarget(target, true, NavigationCommandRevealType.None);
				this.viewController.emitMouseUp(this.toEditorMouseEvent(event, target));
			}
		} finally {
			this.stopPointerSelection();
		}
	}

	private findMousePosition(event: EditorMouseEvent, testEventTarget: boolean): IMouseTarget | null {
		return this.getPositionOutsideEditor(event) ?? this._createMouseTarget(event, testEventTarget);
	}

	private getPositionOutsideEditor(event: EditorMouseEvent): IMouseTargetOutsideEditor | null {
		const editorPosition = event.editorPos;
		const model = this._context.viewModel;
		const viewLayout = this._context.viewLayout;
		const mouseColumn = this._getMouseColumn(event);
		if (event.pos.y < editorPosition.y) {
			const outsideDistance = editorPosition.y - event.pos.y;
			const verticalOffset = Math.max(viewLayout.getCurrentScrollTop() - outsideDistance, 0);
			const lineNumber = viewLayout.getLineNumberAtVerticalOffset(verticalOffset);
			return MouseTarget.createOutsideEditor(mouseColumn, new Position(lineNumber, 1), 'above', outsideDistance);
		}
		if (event.pos.y > editorPosition.y + editorPosition.height) {
			const outsideDistance = event.pos.y - editorPosition.y - editorPosition.height;
			const verticalOffset = viewLayout.getCurrentScrollTop() + event.relativePos.y;
			const lineNumber = viewLayout.getLineNumberAtVerticalOffset(verticalOffset);
			return MouseTarget.createOutsideEditor(mouseColumn, new Position(lineNumber, model.getLineMaxColumn(lineNumber)), 'below', outsideDistance);
		}

		const lineNumber = viewLayout.getLineNumberAtVerticalOffset(viewLayout.getCurrentScrollTop() + event.relativePos.y);
		const layoutInfo = this._context.configuration.options.get(EditorOption.layoutInfo);
		if (event.relativePos.x <= layoutInfo.contentLeft) {
			const isRtl = model.getTextDirection(lineNumber) === TextDirection.RTL;
			return MouseTarget.createOutsideEditor(
				mouseColumn,
				new Position(lineNumber, isRtl ? model.getLineMaxColumn(lineNumber) : 1),
				'left',
				layoutInfo.contentLeft - event.relativePos.x,
			);
		}

		const contentRight = layoutInfo.minimap.minimapLeft === 0
			? layoutInfo.width - layoutInfo.verticalScrollbarWidth
			: layoutInfo.minimap.minimapLeft;
		if (event.relativePos.x >= contentRight) {
			const isRtl = model.getTextDirection(lineNumber) === TextDirection.RTL;
			return MouseTarget.createOutsideEditor(
				mouseColumn,
				new Position(lineNumber, isRtl ? 1 : model.getLineMaxColumn(lineNumber)),
				'right',
				event.relativePos.x - contentRight,
			);
		}
		return null;
	}

	private startDragScrolling(target: IMouseTargetOutsideEditor, event: EditorMouseEvent): void {
		if (target.outsidePosition === 'above' || target.outsidePosition === 'below') {
			this.topBottomDragScrolling.start(target, event);
			this.leftRightDragScrolling.stop();
		} else {
			this.leftRightDragScrolling.start(target, event);
			this.topBottomDragScrolling.stop();
		}
	}

	private stopDragScrolling(): void {
		this.topBottomDragScrolling.stop();
		this.leftRightDragScrolling.stop();
	}

	private dispatchTarget(target: IMouseTarget, inSelectionMode: boolean, revealType = NavigationCommandRevealType.Minimal): void {
		if (!target.position) return;
		this.dispatchPosition(target.position, target.type === MouseTargetType.CONTENT_TEXT && !!target.detail.injectedText, inSelectionMode, target.mouseColumn, revealType);
	}

	private dispatchPosition(position: Position, onInjectedText: boolean, inSelectionMode: boolean, mouseColumn = position.column, revealType = NavigationCommandRevealType.Minimal): void {
		const gesture = this.gesture;
		if (!gesture) return;
		const data: IMouseDispatchData = {
			position,
			mouseColumn,
			revealType,
			startedOnLineNumbers: gesture.startedOnLineNumbers,
			inSelectionMode,
			mouseDownCount: gesture.mouseDownCount,
			altKey: gesture.altKey,
			ctrlKey: gesture.ctrlKey,
			metaKey: gesture.metaKey,
			shiftKey: gesture.shiftKey,
			leftButton: gesture.leftButton,
			middleButton: gesture.middleButton,
			onInjectedText,
		};
		this.viewController.dispatchMouse(data);
	}

	private accepts(event: EditorMouseEvent): boolean {
		return this.gesture?.pointerId === (event.browserEvent as PointerEvent).pointerId;
	}

	private stopPointerSelection(): void {
		const pointerId = this.gesture?.pointerId;
		this.gesture = undefined;
		this.stopDragScrolling();
		this._mouseDownOperation.clear();
		if (pointerId !== undefined) this.pointerHandler.releasePointer(pointerId);
	}

	private toEditorMouseEvent(event: EditorMouseEvent, target: IMouseTarget): IEditorMouseEvent {
		return { event, target };
	}
}

function eventTargetElement(target: EventTarget | null, ownerDocument: Document): HTMLElement | null {
	const HTMLElementConstructor = ownerDocument.defaultView?.HTMLElement;
	return HTMLElementConstructor && target instanceof HTMLElementConstructor ? target : null;
}

function isViewZone(target: IMouseTarget): target is Extract<IMouseTarget, { type: MouseTargetType.GUTTER_VIEW_ZONE | MouseTargetType.CONTENT_VIEW_ZONE }> {
	return target.type === MouseTargetType.GUTTER_VIEW_ZONE || target.type === MouseTargetType.CONTENT_VIEW_ZONE;
}

function isWidget(target: IMouseTarget): target is Extract<IMouseTarget, { type: MouseTargetType.CONTENT_WIDGET | MouseTargetType.OVERLAY_WIDGET }> {
	return target.type === MouseTargetType.CONTENT_WIDGET || target.type === MouseTargetType.OVERLAY_WIDGET;
}

function buttonMask(event: EditorMouseEvent): number {
	if (event.leftButton) return 1;
	if (event.middleButton) return 4;
	if (event.rightButton) return 2;
	return 0;
}
