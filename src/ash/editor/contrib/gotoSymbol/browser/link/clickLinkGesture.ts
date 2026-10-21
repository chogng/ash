import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { type IKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { type ICodeEditor, type IEditorMouseEvent, type IMouseTarget } from '../../../../browser/editorBrowser.js';
import { EditorOption } from '../../../../common/config/editorOptions.js';

export type TriggerModifier = 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey';

export class ClickLinkMouseEvent {
	public readonly target: IMouseTarget;
	public readonly hasTriggerModifier: boolean;
	public readonly hasSideBySideModifier: boolean;
	public readonly isNoneOrSingleMouseDown: boolean;
	public readonly isLeftClick: boolean;
	public readonly isMiddleClick: boolean;
	public readonly isRightClick: boolean;

	constructor(source: IEditorMouseEvent, triggerModifier: TriggerModifier, sideModifier: TriggerModifier) {
		this.target = source.target;
		this.hasTriggerModifier = source.event[triggerModifier] && !source.event.browserEvent.getModifierState('AltGraph');
		this.hasSideBySideModifier = source.event[sideModifier];
		this.isNoneOrSingleMouseDown = source.event.detail <= 1;
		this.isLeftClick = source.event.leftButton;
		this.isMiddleClick = source.event.middleButton;
		this.isRightClick = source.event.rightButton;
	}
}

export class ClickLinkKeyboardEvent {
	public readonly keyCodeIsTriggerKey: boolean;
	public readonly hasTriggerModifier: boolean;
	constructor(source: IKeyboardEvent, triggerModifier: TriggerModifier) {
		this.keyCodeIsTriggerKey = source.keyCode === (triggerModifier === 'altKey' ? KeyCode.Alt : isMacintosh ? KeyCode.Meta : KeyCode.Ctrl);
		this.hasTriggerModifier = source[triggerModifier];
	}
}

/** Recognizes a modifier click without owning cursor movement or navigation results. */
export class ClickLinkGesture extends Disposable {
	private readonly move = this._register(new Emitter<[ClickLinkMouseEvent, ClickLinkKeyboardEvent | null]>());
	public readonly onMouseMoveOrRelevantKeyDown = this.move.event;
	private readonly execute = this._register(new Emitter<ClickLinkMouseEvent>());
	public readonly onExecute = this.execute.event;
	private readonly cancel = this._register(new Emitter<void>());
	public readonly onCancel = this.cancel.event;
	private lastMouse: IEditorMouseEvent | undefined;
	private down: ClickLinkMouseEvent | undefined;

	constructor(private readonly editor: ICodeEditor) {
		super();
		this._register(editor.onMouseMove(event => {
			this.lastMouse = event;
			this.move.fire([this.wrap(event), null]);
		}));
		this._register(editor.onMouseDown(event => { this.down = this.wrap(event); }));
		this._register(editor.onMouseUp(event => {
			const down = this.down;
			this.down = undefined;
			const up = this.wrap(event);
			if (down?.hasTriggerModifier && up.hasTriggerModifier && up.isLeftClick && up.isNoneOrSingleMouseDown
				&& down.target.position && up.target.position && down.target.position.equals(up.target.position)) {
				this.execute.fire(up);
			}
		}));
		this._register(editor.onMouseDrag(() => { this.down = undefined; this.cancel.fire(); }));
		this._register(editor.onMouseLeave(() => { this.lastMouse = undefined; this.cancel.fire(); }));
		this._register(editor.onKeyDown(event => {
			const keyboard = new ClickLinkKeyboardEvent(event, this.triggerModifier);
			if (keyboard.keyCodeIsTriggerKey && this.lastMouse && !event.browserEvent.getModifierState('AltGraph')) { this.move.fire([this.wrap(this.lastMouse), keyboard]); }
		}));
		this._register(editor.onKeyUp(event => {
			if (new ClickLinkKeyboardEvent(event, this.triggerModifier).keyCodeIsTriggerKey) { this.cancel.fire(); }
		}));
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.multiCursorModifier)) { this.down = undefined; this.cancel.fire(); }
		}));
	}
	private get triggerModifier(): TriggerModifier {
		return this.editor.getOption(EditorOption.multiCursorModifier) === 'altKey' ? isMacintosh ? 'metaKey' : 'ctrlKey' : 'altKey';
	}
	private wrap(event: IEditorMouseEvent): ClickLinkMouseEvent {
		return new ClickLinkMouseEvent(event, this.triggerModifier, this.triggerModifier === 'altKey' ? isMacintosh ? 'metaKey' : 'ctrlKey' : 'altKey');
	}
}
