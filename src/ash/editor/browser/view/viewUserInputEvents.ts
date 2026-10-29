import { type IKeyboardEvent } from '../../../base/browser/keyboardEvent.js';
import { type IMouseWheelEvent } from '../../../base/browser/mouseEvent.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { type ICoordinatesConverter } from '../../common/coordinatesConverter.js';
import { Position } from '../../common/core/position.js';
import { type IEditorMouseEvent, type IMouseTarget, type IMouseTargetViewZoneData, type IPartialEditorMouseEvent, MouseTargetType } from '../editorBrowser.js';

export class ViewUserInputEvents extends Disposable {
	private readonly keyDownEmitter = this._register(new Emitter<IKeyboardEvent>());
	private readonly keyUpEmitter = this._register(new Emitter<IKeyboardEvent>());
	private readonly contextMenuEmitter = this._register(new Emitter<IEditorMouseEvent>());
	private readonly mouseMoveEmitter = this._register(new Emitter<IEditorMouseEvent>());
	private readonly mouseLeaveEmitter = this._register(new Emitter<IPartialEditorMouseEvent>());
	private readonly mouseDownEmitter = this._register(new Emitter<IEditorMouseEvent>());
	private readonly mouseUpEmitter = this._register(new Emitter<IEditorMouseEvent>());
	private readonly mouseDragEmitter = this._register(new Emitter<IEditorMouseEvent>());
	private readonly mouseDropEmitter = this._register(new Emitter<IPartialEditorMouseEvent>());
	private readonly mouseDropCanceledEmitter = this._register(new Emitter<void>());
	private readonly mouseWheelEmitter = this._register(new Emitter<IMouseWheelEvent>());
	public readonly onKeyDown = this.keyDownEmitter.event;
	public readonly onKeyUp = this.keyUpEmitter.event;
	public readonly onContextMenu = this.contextMenuEmitter.event;
	public readonly onMouseMove = this.mouseMoveEmitter.event;
	public readonly onMouseLeave = this.mouseLeaveEmitter.event;
	public readonly onMouseDown = this.mouseDownEmitter.event;
	public readonly onMouseUp = this.mouseUpEmitter.event;
	public readonly onMouseDrag = this.mouseDragEmitter.event;
	public readonly onMouseDrop = this.mouseDropEmitter.event;
	public readonly onMouseDropCanceled = this.mouseDropCanceledEmitter.event;
	public readonly onMouseWheel = this.mouseWheelEmitter.event;

	constructor(private readonly coordinatesConverter: ICoordinatesConverter) { super(); }

	public emitKeyDown(event: IKeyboardEvent): void {
		this.keyDownEmitter.fire(event);
	}

	public emitKeyUp(event: IKeyboardEvent): void {
		this.keyUpEmitter.fire(event);
	}

	public emitContextMenu(event: IEditorMouseEvent): void {
		this.contextMenuEmitter.fire(this.convertViewToModelMouseEvent(event));
	}

	public emitMouseMove(event: IEditorMouseEvent): void {
		this.mouseMoveEmitter.fire(this.convertViewToModelMouseEvent(event));
	}

	public emitMouseLeave(event: IPartialEditorMouseEvent): void {
		this.mouseLeaveEmitter.fire(this.convertViewToModelMouseEvent(event));
	}

	public emitMouseDown(event: IEditorMouseEvent): void {
		this.mouseDownEmitter.fire(this.convertViewToModelMouseEvent(event));
	}

	public emitMouseUp(event: IEditorMouseEvent): void {
		this.mouseUpEmitter.fire(this.convertViewToModelMouseEvent(event));
	}

	public emitMouseDrag(event: IEditorMouseEvent): void {
		this.mouseDragEmitter.fire(this.convertViewToModelMouseEvent(event));
	}

	public emitMouseDrop(event: IPartialEditorMouseEvent): void {
		this.mouseDropEmitter.fire(this.convertViewToModelMouseEvent(event));
	}

	public emitMouseDropCanceled(): void {
		this.mouseDropCanceledEmitter.fire();
	}

	public emitMouseWheel(event: IMouseWheelEvent): void {
		this.mouseWheelEmitter.fire(event);
	}

	private convertViewToModelMouseEvent(event: IEditorMouseEvent): IEditorMouseEvent;
	private convertViewToModelMouseEvent(event: IPartialEditorMouseEvent): IPartialEditorMouseEvent;
	private convertViewToModelMouseEvent(event: IEditorMouseEvent | IPartialEditorMouseEvent): IEditorMouseEvent | IPartialEditorMouseEvent {
		return event.target === null
			? event
			: { event: event.event, target: this.convertViewToModelMouseTarget(event.target) };
	}

	private convertViewToModelMouseTarget(target: IMouseTarget): IMouseTarget {
		return ViewUserInputEvents.convertViewToModelMouseTarget(target, this.coordinatesConverter);
	}

	public static convertViewToModelMouseTarget(target: IMouseTarget, coordinatesConverter: ICoordinatesConverter): IMouseTarget {
		const position = target.position ? coordinatesConverter.convertViewPositionToModelPosition(target.position) : null;
		const range = target.range ? coordinatesConverter.convertViewRangeToModelRange(target.range) : null;
		if (target.type === MouseTargetType.GUTTER_VIEW_ZONE || target.type === MouseTargetType.CONTENT_VIEW_ZONE) {
			return {
				...target,
				position: position!,
				range: range!,
				detail: this.convertViewToModelViewZoneData(target.detail, coordinatesConverter),
			};
		}
		return { ...target, position, range } as IMouseTarget;
	}

	private static convertViewToModelViewZoneData(data: IMouseTargetViewZoneData, coordinatesConverter: ICoordinatesConverter): IMouseTargetViewZoneData {
		return {
			viewZoneId: data.viewZoneId,
			positionBefore: data.positionBefore ? coordinatesConverter.convertViewPositionToModelPosition(data.positionBefore) : null,
			positionAfter: data.positionAfter ? coordinatesConverter.convertViewPositionToModelPosition(data.positionAfter) : null,
			position: coordinatesConverter.convertViewPositionToModelPosition(data.position),
			afterLineNumber: coordinatesConverter.convertViewPositionToModelPosition(new Position(data.afterLineNumber, 1)).lineNumber,
		};
	}
}
