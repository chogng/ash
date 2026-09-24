import { getWindow } from '../../../base/browser/dom.js';
import { scheduleAtNextAnimationFrame } from '../../../base/browser/scheduler.js';
import { Disposable, MutableDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { clamp } from '../../../base/common/numbers.js';
import { EditorOption } from '../../common/config/editorOptions.js';
import { Position } from '../../common/core/position.js';
import { TextDirection } from '../../common/model.js';
import { type ViewContext } from '../../common/viewModel/viewContext.js';
import { NavigationCommandRevealType } from '../coreCommands.js';
import { type IMouseTarget, type IMouseTargetOutsideEditor } from '../editorBrowser.js';
import { createCoordinatesRelativeToEditor, createEditorPagePosition, type EditorMouseEvent, PageCoordinates } from '../editorDom.js';
import { type IPointerHandlerHelper } from './mouseHandler.js';
import { MouseTarget, type MouseTargetFactory } from './mouseTarget.js';

const MINIMUM_FRAME_DURATION = 4;
const MAXIMUM_FRAME_DURATION = 50;

export abstract class DragScrolling extends Disposable {
	private readonly _operation = this._register(new MutableDisposable<DragScrollingOperation>());

	constructor(
		protected readonly _context: ViewContext,
		protected readonly _viewHelper: IPointerHandlerHelper,
		protected readonly _mouseTargetFactory: MouseTargetFactory,
		protected readonly _dispatchMouse: (position: IMouseTarget, inSelectionMode: boolean, revealType: NavigationCommandRevealType) => void,
	) {
		super();
	}

	public start(position: IMouseTargetOutsideEditor, mouseEvent: EditorMouseEvent): void {
		this.assertNotDisposed();
		if (this._operation.value) {
			this._operation.value.setPosition(position, mouseEvent);
			return;
		}
		this._operation.value = this._createDragScrollingOperation(position, mouseEvent);
	}

	public stop(): void {
		this._operation.clear();
	}

	protected abstract _createDragScrollingOperation(position: IMouseTargetOutsideEditor, mouseEvent: EditorMouseEvent): DragScrollingOperation;
}

export abstract class DragScrollingOperation extends Disposable {
	protected _position: IMouseTargetOutsideEditor;
	protected _mouseEvent: EditorMouseEvent;
	protected _animationFrameDisposable: IDisposable = Disposable.None;
	private readonly scheduledFrame = this._register(new MutableDisposable<IDisposable>());
	private lastTime: number;

	constructor(
		protected readonly _context: ViewContext,
		protected readonly _viewHelper: IPointerHandlerHelper,
		protected readonly _mouseTargetFactory: MouseTargetFactory,
		protected readonly _dispatchMouse: (position: IMouseTarget, inSelectionMode: boolean, revealType: NavigationCommandRevealType) => void,
		position: IMouseTargetOutsideEditor,
		mouseEvent: EditorMouseEvent,
	) {
		super();
		this._position = position;
		this._mouseEvent = mouseEvent;
		this.lastTime = getWindow(mouseEvent.browserEvent).performance.now();
		this.scheduleFrame();
	}

	public setPosition(position: IMouseTargetOutsideEditor, mouseEvent: EditorMouseEvent): void {
		this._position = position;
		this._mouseEvent = mouseEvent;
	}

	protected _tick(): number {
		const now = getWindow(this._mouseEvent.browserEvent).performance.now();
		const elapsed = clamp(now - this.lastTime, MINIMUM_FRAME_DURATION, MAXIMUM_FRAME_DURATION);
		this.lastTime = now;
		return elapsed;
	}

	protected abstract _execute(): void;

	private scheduleFrame(): void {
		const targetWindow = getWindow(this._mouseEvent.browserEvent);
		let registration: IDisposable = Disposable.None;
		registration = scheduleAtNextAnimationFrame(targetWindow, () => {
			if (this._animationFrameDisposable === registration) {
				this._animationFrameDisposable = Disposable.None;
				this.scheduledFrame.clear();
			}
			if (this.isDisposed) return;
			this._execute();
			if (!this.isDisposed) this.scheduleFrame();
		});
		this._animationFrameDisposable = registration;
		this.scheduledFrame.value = registration;
	}
}

export class TopBottomDragScrolling extends DragScrolling {
	protected _createDragScrollingOperation(position: IMouseTargetOutsideEditor, mouseEvent: EditorMouseEvent): DragScrollingOperation {
		return new TopBottomDragScrollingOperation(this._context, this._viewHelper, this._mouseTargetFactory, this._dispatchMouse, position, mouseEvent);
	}
}

export class TopBottomDragScrollingOperation extends DragScrollingOperation {
	protected _execute(): void {
		const options = this._context.configuration.options;
		const lineHeight = options.get(EditorOption.lineHeight);
		const layoutInfo = options.get(EditorOption.layoutInfo);
		const viewportLines = layoutInfo.height / lineHeight;
		const distanceLines = this._position.outsideDistance / lineHeight;
		const pixels = dragSpeed(viewportLines, distanceLines) * lineHeight * this._tick() / 1_000;
		const viewLayout = this._context.viewLayout;
		const before = viewLayout.getCurrentScrollTop();
		viewLayout.deltaScrollNow(0, this._position.outsidePosition === 'above' ? -pixels : pixels);
		this._viewHelper.renderNow();

		const viewport = viewLayout.getLinesViewportData();
		const isAbove = this._position.outsidePosition === 'above';
		const edgeLineNumber = isAbove ? viewport.startLineNumber : viewport.endLineNumber;
		const reachedBoundary = before === viewLayout.getCurrentScrollTop();
		let target = this.createTargetAtViewportEdge(isAbove, edgeLineNumber);
		if (!target.position || target.position.lineNumber !== edgeLineNumber || reachedBoundary) {
			const column = isAbove ? 1 : this._context.viewModel.getLineMaxColumn(edgeLineNumber);
			target = MouseTarget.createOutsideEditor(this._position.mouseColumn, new Position(edgeLineNumber, column), isAbove ? 'above' : 'below', this._position.outsideDistance);
		}
		this._dispatchMouse(target, true, NavigationCommandRevealType.None);
	}

	private createTargetAtViewportEdge(isAbove: boolean, edgeLineNumber: number): IMouseTarget {
		const editorPos = createEditorPagePosition(this._viewHelper.viewDomNode);
		const layoutInfo = this._context.configuration.options.get(EditorOption.layoutInfo);
		const edgeY = isAbove
			? editorPos.y + 0.1
			: editorPos.y + Math.max(0.1, editorPos.height - layoutInfo.horizontalScrollbarHeight - 0.1);
		const pos = new PageCoordinates(this._mouseEvent.pos.x, edgeY);
		const relativePos = createCoordinatesRelativeToEditor(this._viewHelper.viewDomNode, editorPos, pos);
		const target = this._mouseTargetFactory.createMouseTarget(this._viewHelper.getLastRenderData(), editorPos, pos, relativePos, null);
		if (target.position?.lineNumber === edgeLineNumber) return target;
		return MouseTarget.createOutsideEditor(this._position.mouseColumn, new Position(edgeLineNumber, isAbove ? 1 : this._context.viewModel.getLineMaxColumn(edgeLineNumber)), isAbove ? 'above' : 'below', this._position.outsideDistance);
	}
}

export class LeftRightDragScrolling extends DragScrolling {
	protected _createDragScrollingOperation(position: IMouseTargetOutsideEditor, mouseEvent: EditorMouseEvent): DragScrollingOperation {
		return new LeftRightDragScrollingOperation(this._context, this._viewHelper, this._mouseTargetFactory, this._dispatchMouse, position, mouseEvent);
	}
}

export class LeftRightDragScrollingOperation extends DragScrollingOperation {
	protected _execute(): void {
		const options = this._context.configuration.options;
		const charWidth = Math.max(1, options.get(EditorOption.fontInfo).typicalFullwidthCharacterWidth);
		const layoutInfo = options.get(EditorOption.layoutInfo);
		const viewportColumns = layoutInfo.contentWidth / charWidth;
		const distanceColumns = this._position.outsideDistance / charWidth;
		const pixels = dragSpeed(viewportColumns, distanceColumns) * charWidth * 0.5 * this._tick() / 1_000;
		this._context.viewLayout.deltaScrollNow(this._position.outsidePosition === 'left' ? -pixels : pixels, 0);
		this._viewHelper.renderNow();

		const lineNumber = this._position.position?.lineNumber;
		if (!lineNumber) return;
		const isRtl = this._context.viewModel.getTextDirection(lineNumber) === TextDirection.RTL;
		const isPastLineEnd = this._position.outsidePosition === (isRtl ? 'left' : 'right');
		const column = isPastLineEnd ? this._context.viewModel.getLineMaxColumn(lineNumber) : 1;
		const target = MouseTarget.createOutsideEditor(column, new Position(lineNumber, column), this._position.outsidePosition, this._position.outsideDistance);
		this._dispatchMouse(target, true, NavigationCommandRevealType.None);
	}
}

function dragSpeed(viewportUnits: number, outsideUnits: number): number {
	if (outsideUnits <= 1.5) return Math.max(30, viewportUnits * (1 + outsideUnits));
	if (outsideUnits <= 3) return Math.max(60, viewportUnits * (2 + outsideUnits));
	return Math.max(200, viewportUnits * (7 + outsideUnits));
}
