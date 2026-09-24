import { addDisposableListener } from "../../../../../base/browser/dom.js";
import { isFirefox } from '../../../../../base/browser/browser.js';
import { StandardKeyboardEvent, type IKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { Emitter, type Event } from "../../../../../base/common/event.js";
import { Disposable, MutableDisposable } from "../../../../../base/common/lifecycle.js";
import { Position } from "../../../../common/core/position.js";
import { Selection } from "../../../../common/core/selection.js";
import { normalizeTextLineEndings } from "../../../../common/core/textChange.js";
import { type ViewContext } from "../../../../common/viewModel/viewContext.js";
import { CopyOptions, createClipboardCopyEvent, createClipboardPasteEvent, type ClipboardStoredMetadata, type IClipboardCopyEvent, type IClipboardPasteEvent } from '../clipboardUtils.js';
import { type ITextAreaWrapper, type ITypeData, TextAreaState } from "./textAreaEditContextState.js";

export interface ICompositionData {
	readonly data: string;
}

export interface ICompositionStartEvent {
	readonly data: string;
}

export interface ITextAreaInputHost {
	readonly context: ViewContext;
	getScreenReaderContent(): TextAreaState;
	deduceModelPosition(viewAnchorPosition: Position, deltaOffset: number, lineFeedCount: number): Position;
}

export interface IPasteData {
	readonly text: string;
	readonly metadata: ClipboardStoredMetadata | null;
}

/**
 * DOM event bridge for the textarea edit-context backend.
 *
 * This class owns the textarea event lifecycle and translates system-caret
 * movement against the last screen-reader state supplied by its host.
 */
export class TextAreaInput extends Disposable implements ITextAreaWrapper {
	private readonly focusEmitter = this._register(new Emitter<void>());
	private readonly blurEmitter = this._register(new Emitter<void>());
	private readonly beforeInputEmitter = this._register(new Emitter<InputEvent>());
	private readonly inputEmitter = this._register(new Emitter<InputEvent>());
	private readonly selectionChangeRequestEmitter = this._register(new Emitter<Selection>());
	private readonly keydownEmitter = this._register(new Emitter<IKeyboardEvent>());
	private readonly keyupEmitter = this._register(new Emitter<IKeyboardEvent>());
	private readonly typeEmitter = this._register(new Emitter<ITypeData>());
	private readonly compositionStartEmitter = this._register(new Emitter<ICompositionStartEvent>());
	private readonly compositionUpdateEmitter = this._register(new Emitter<ICompositionData>());
	private readonly compositionEndEmitter = this._register(new Emitter<void>());
	private readonly cutEmitter = this._register(new Emitter<void>());
	private readonly pasteEmitter = this._register(new Emitter<IPasteData>());
	private readonly willCopyEmitter = this._register(new Emitter<IClipboardCopyEvent>());
	private readonly willCutEmitter = this._register(new Emitter<IClipboardCopyEvent>());
	private readonly willPasteEmitter = this._register(new Emitter<IClipboardPasteEvent>());
	private readonly selectionChangeListener = this._register(new MutableDisposable());
	private focused = false;
	private composing = false;
	private compositionText = '';
	private compositionActiveOffset = 0;
	private selectionChangeIgnoredUntil = 0;
	private previousSelectionChangeTime = 0;
	private _textAreaState = TextAreaState.EMPTY;

	readonly onFocus: Event<void> = this.focusEmitter.event;
	readonly onBlur: Event<void> = this.blurEmitter.event;
	readonly onDidBeforeInput: Event<InputEvent> = this.beforeInputEmitter.event;
	readonly onDidInput: Event<InputEvent> = this.inputEmitter.event;
	readonly onSelectionChangeRequest: Event<Selection> = this.selectionChangeRequestEmitter.event;
	readonly onKeyDown: Event<IKeyboardEvent> = this.keydownEmitter.event;
	readonly onKeyUp: Event<IKeyboardEvent> = this.keyupEmitter.event;
	readonly onType: Event<ITypeData> = this.typeEmitter.event;
	readonly onCompositionStart: Event<ICompositionStartEvent> = this.compositionStartEmitter.event;
	readonly onCompositionUpdate: Event<ICompositionData> = this.compositionUpdateEmitter.event;
	readonly onCompositionEnd: Event<void> = this.compositionEndEmitter.event;
	readonly onCut: Event<void> = this.cutEmitter.event;
	readonly onPaste: Event<IPasteData> = this.pasteEmitter.event;
	readonly onWillCopy: Event<IClipboardCopyEvent> = this.willCopyEmitter.event;
	readonly onWillCut: Event<IClipboardCopyEvent> = this.willCutEmitter.event;
	readonly onWillPaste: Event<IClipboardPasteEvent> = this.willPasteEmitter.event;

	constructor(
		private readonly host: ITextAreaInputHost,
		private readonly element: HTMLTextAreaElement,
	) {
		super();
		this._textAreaState = TextAreaState.readFromTextArea(this, null);
		this.connect();
	}

	get textAreaState(): TextAreaState {
		return this._textAreaState;
	}

	private connect(): void {
		this._register(addDisposableListener(this.element, "focus", () => this.setFocused(true)));
		this._register(addDisposableListener(this.element, "blur", () => this.setFocused(false)));
		this._register(addDisposableListener<CompositionEvent>(
			this.element,
			"compositionstart",
			event => this.handleCompositionStart(event),
		));
		this._register(addDisposableListener<CompositionEvent>(
			this.element,
			"compositionupdate",
			event => this.handleCompositionUpdate(event),
		));
		this._register(addDisposableListener<CompositionEvent>(
			this.element,
			"compositionend",
			event => this.handleCompositionEnd(event),
		));
		this._register(addDisposableListener<InputEvent>(
			this.element,
			"beforeinput",
			event => this.handleBeforeInput(event),
		));
		this._register(addDisposableListener<InputEvent>(
			this.element,
			"input",
			event => {
				this.setIgnoreSelectionChangeTime('received input event');
				this._textAreaState = TextAreaState.readFromTextArea(this, this._textAreaState);
				this.inputEmitter.fire(event);
			},
		));
		this._register(addDisposableListener<ClipboardEvent>(this.element, 'copy', event => this.handleCopy(event)));
		this._register(addDisposableListener<ClipboardEvent>(this.element, 'cut', event => this.handleCut(event)));
		this._register(addDisposableListener<ClipboardEvent>(this.element, 'paste', event => this.handlePaste(event)));
		this._register(addDisposableListener<KeyboardEvent>(
			this.element,
			"keydown",
			event => this.keydownEmitter.fire(new StandardKeyboardEvent(event)),
		));
		this._register(addDisposableListener<KeyboardEvent>(
			this.element,
			'keyup',
			event => this.keyupEmitter.fire(new StandardKeyboardEvent(event)),
		));
	}

	public focusTextArea(): void {
		this.element.focus({ preventScroll: true });
		this.refreshFocusState();
	}

	isFocused(): boolean {
		return this.focused;
	}

	refreshFocusState(): void {
		this.setFocused(this.hasFocus());
	}

	clear(): void {
		this.setValue("clear", "");
	}

	getValue(): string {
		return this.element.value;
	}

	setValue(reason: string, value: string): void {
		if (this.element.value !== value) {
			this.setIgnoreSelectionChangeTime(reason);
			this.element.value = value;
		}
		this._textAreaState = TextAreaState.readFromTextArea(this, this._textAreaState);
	}

	getSelectionStart(): number {
		return this.element.selectionDirection === "backward"
			? this.element.selectionEnd
			: this.element.selectionStart;
	}

	getSelectionEnd(): number {
		return this.element.selectionDirection === "backward"
			? this.element.selectionStart
			: this.element.selectionEnd;
	}

	setSelectionRange(reason: string, selectionStart: number, selectionEnd: number): void {
		const direction = selectionStart > selectionEnd ? "backward" : "forward";
		if (
			this.getSelectionStart() === selectionStart
			&& this.getSelectionEnd() === selectionEnd
		) return;
		this.setIgnoreSelectionChangeTime(reason);
		this.element.setSelectionRange(
			Math.min(selectionStart, selectionEnd),
			Math.max(selectionStart, selectionEnd),
			direction,
		);
		this._textAreaState = TextAreaState.readFromTextArea(this, this._textAreaState);
	}

	private setFocused(focused: boolean): void {
		if (this.focused === focused) return;
		this.focused = focused;
		if (!focused) this.resetComposition();
		this.previousSelectionChangeTime = 0;
		this.selectionChangeListener.value = focused
			? addDisposableListener(this.element.ownerDocument, 'selectionchange', () => this.handleSelectionChange())
			: undefined;
		(focused ? this.focusEmitter : this.blurEmitter).fire(undefined);
	}

	hasFocus(): boolean {
		if (!this.element.isConnected) return false;
		const root = this.element.getRootNode() as Document | ShadowRoot;
		const activeElement = 'activeElement' in root ? root.activeElement : this.element.ownerDocument.activeElement;
		return activeElement === this.element;
	}

	setIgnoreSelectionChangeTime(_reason: string): void {
		this.selectionChangeIgnoredUntil = Date.now() + 100;
	}

	getIgnoreSelectionChangeTime(): number {
		return this.selectionChangeIgnoredUntil;
	}

	resetSelectionChangeTime(): void {
		this.selectionChangeIgnoredUntil = 0;
	}

	writeNativeTextAreaContent(reason: string): void {
		if (!this.focused || this.composing) return;
		const state = this.host.getScreenReaderContent();
		state.writeToTextArea(reason, this, true);
		this._textAreaState = state;
	}

	private handleSelectionChange(): void {
		if (!this.focused || this.composing) return;
		const now = Date.now();
		if (now - this.previousSelectionChangeTime < 5) return;
		this.previousSelectionChangeTime = now;
		if (now < this.selectionChangeIgnoredUntil) return;
		const state = this._textAreaState;
		if (!state.selection || state.value !== this.getValue()) return;
		const selectionStart = this.getSelectionStart();
		const selectionEnd = this.getSelectionEnd();
		if (state.selectionStart === selectionStart && state.selectionEnd === selectionEnd) return;
		const start = state.deduceEditorPosition(selectionStart);
		const end = state.deduceEditorPosition(selectionEnd);
		if (!start[0] || !end[0]) return;
		const modelStart = this.host.deduceModelPosition(start[0], start[1], start[2]);
		const modelEnd = this.host.deduceModelPosition(end[0], end[1], end[2]);
		this.selectionChangeRequestEmitter.fire(Selection.fromPositions(modelStart, modelEnd));
	}

	private handleBeforeInput(event: InputEvent): void {
		if (!this.focused) {
			event.preventDefault();
			return;
		}
		this.beforeInputEmitter.fire(event);
		if (event.defaultPrevented || event.isComposing) return;
		if (
			(event.inputType !== 'insertText' && event.inputType !== 'insertReplacementText') ||
			!event.data
		) return;
		event.preventDefault();
		this.typeEmitter.fire({
			text: normalizeTextLineEndings(event.data),
			replacePrevCharCnt: 0,
			replaceNextCharCnt: 0,
			positionDelta: 0,
		});
	}

	private handleCompositionStart(event: CompositionEvent): void {
		if (event.defaultPrevented) return;
		if (!this.focused) {
			event.preventDefault();
			return;
		}
		if (
			this.element.readOnly ||
			this.host.context.viewModel.getSelections().length !== 1
		) {
			event.preventDefault();
			return;
		}
		if (this.composing) {
			this.compositionText = '';
			this.compositionActiveOffset = 0;
			return;
		}
		this.composing = true;
		this.compositionText = '';
		this.compositionActiveOffset = 0;
		this.compositionStartEmitter.fire({
			data: normalizeTextLineEndings(event.data ?? ''),
		});
	}

	private handleCompositionUpdate(event: CompositionEvent): void {
		if (!this.composing || event.defaultPrevented) return;
		this.emitCompositionType();
		this.compositionUpdateEmitter.fire({
			data: normalizeTextLineEndings(event.data ?? ''),
		});
	}

	private handleCompositionEnd(_event: CompositionEvent): void {
		if (!this.composing) return;
		this.emitCompositionType();
		this.resetComposition();
		this.compositionEndEmitter.fire(undefined);
	}

	private emitCompositionType(): void {
		const rawText = this.element.value;
		const text = normalizeTextLineEndings(rawText);
		const selection = readCompositionSelection(this.element, rawText, text);
		if (
			text === this.compositionText &&
			selection.activeOffset === this.compositionActiveOffset
		) return;
		this.typeEmitter.fire({
			text,
			replacePrevCharCnt: this.compositionText.length,
			replaceNextCharCnt: 0,
			positionDelta: selection.activeOffset - text.length,
		});
		this.compositionText = text;
		this.compositionActiveOffset = selection.activeOffset;
	}

	private resetComposition(): void {
		this.composing = false;
		this.compositionText = '';
		this.compositionActiveOffset = 0;
	}

	private handleCopy(browserEvent: ClipboardEvent): void {
		if (!this.focused) {
			browserEvent.preventDefault();
			return;
		}
		CopyOptions.electronBugWorkaroundCopyEventHasFired = true;
		const event = createClipboardCopyEvent(browserEvent, false, this.host.context, undefined, isFirefox);
		this.willCopyEmitter.fire(event);
		if (!event.isHandled) event.ensureClipboardGetsEditorData();
	}

	private handleCut(browserEvent: ClipboardEvent): void {
		if (!this.focused) {
			browserEvent.preventDefault();
			return;
		}
		CopyOptions.cutEventHasFired = true;
		const event = createClipboardCopyEvent(browserEvent, true, this.host.context, undefined, isFirefox);
		this.willCutEmitter.fire(event);
		if (event.isHandled) return;
		if (this.composing) {
			event.setHandled();
			return;
		}
		this.setIgnoreSelectionChangeTime('received cut event');
		event.ensureClipboardGetsEditorData();
		this.cutEmitter.fire(undefined);
	}

	private handlePaste(browserEvent: ClipboardEvent): void {
		if (!this.focused) {
			browserEvent.preventDefault();
			return;
		}
		const event = createClipboardPasteEvent(browserEvent);
		this.willPasteEmitter.fire(event);
		if (event.isHandled) return;
		if (this.composing) {
			event.setHandled();
			return;
		}
		this.setIgnoreSelectionChangeTime('received paste event');
		browserEvent.preventDefault();
		if (!event.text) return;
		this.pasteEmitter.fire({ text: event.text, metadata: event.metadata });
	}
}

function readCompositionSelection(element: HTMLTextAreaElement, rawText: string, normalizedText: string): { readonly anchorOffset: number; readonly activeOffset: number } {
	if (element.value !== rawText) {
		return {
			anchorOffset: normalizedText.length,
			activeOffset: normalizedText.length,
		};
	}
	const start = normalizedOffset(rawText, element.selectionStart);
	const end = normalizedOffset(rawText, element.selectionEnd);
	return element.selectionDirection === "backward"
		? { anchorOffset: end, activeOffset: start }
		: { anchorOffset: start, activeOffset: end };
}

function normalizedOffset(text: string, offset: number): number {
	return normalizeTextLineEndings(text.slice(0, offset)).length;
}
