import "./nativeEditContext.css";
import { addDisposableListener, getActiveElement, h } from "../../../../../base/browser/dom.js";
import { FastDomNode } from '../../../../../base/browser/fastDomNode.js';
import { StandardKeyboardEvent, type IKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { Emitter, type Event } from "../../../../../base/common/event.js";
import { IME } from "../../../../../base/common/ime.js";
import { AbstractEditContext, type EditContextCharacterBounds, type EditContextCompositionData, type EditContextOptions, type EditContextPosition, type EditContextState, type EditContextTextFormat, type EditContextTextFormatUpdate, type EditContextTextUpdate } from "../editContext.js";
import { type Position } from "../../../../common/core/position.js";
import { normalizeTextLineEndings } from "../../../../common/core/textChange.js";
import { type IEditorAriaOptions } from '../../../editorBrowser.js';
import { isHighSurrogate, isLowSurrogate } from '../../../../../base/common/strings.js';
import { editContextAddDisposableListener, FocusTracker, MAX_CHARACTER_BOUNDS_REQUEST_LENGTH, clampOffset, createNativeTextWindow, isFiniteOffset, isNativeTextUpdateEvent, isValidOffset } from "./nativeEditContextUtils.js";
import { NativeEditContextRegistry } from "./nativeEditContextRegistry.js";
import { ScreenReaderSupport } from './screenReaderSupport.js';
import { EditContext } from './editContextFactory.js';
import { type RenderingContext, type RestrictedRenderingContext } from '../../../view/renderingContext.js';
import { type ViewContext } from '../../../../common/viewModel/viewContext.js';
import { type ViewportData } from '../../../../common/viewLayout/viewLinesViewportData.js';
import * as viewEvents from '../../../../common/viewEvents.js';
import { EditorOption } from '../../../../common/config/editorOptions.js';
import { type ILogService } from '../../../../../platform/log/common/log.js';
import { CopyOptions } from '../clipboardUtils.js';

/** Minimal local declaration because TypeScript's DOM library does not yet expose EditContext. */
export interface NativeEditContextObject extends EventTarget {
	readonly text: string;
	readonly selectionStart: number;
	readonly selectionEnd: number;
	updateText(start: number, end: number, text: string): void;
	updateSelection(start: number, end: number): void;
	updateControlBounds?(bounds: DOMRect): void;
	updateSelectionBounds?(bounds: DOMRect): void;
	updateCharacterBounds?(start: number, bounds: readonly DOMRect[]): void;
}

export interface NativeEditContextConstructor {
	new(options?: unknown): NativeEditContextObject;
}

export interface NativeEditContextWindow extends Window {
	readonly EditContext?: NativeEditContextConstructor;
}

interface NativeEditContextElement extends HTMLElement {
	editContext?: NativeEditContextObject;
}

export interface NativeTextUpdateEvent extends globalThis.Event {
	readonly text: string;
	readonly updateRangeStart: number;
	readonly updateRangeEnd: number;
	readonly selectionStart: number;
	readonly selectionEnd: number;
}

export interface NativeCharacterBoundsUpdateEvent extends globalThis.Event {
	readonly rangeStart: number;
	readonly rangeEnd: number;
}

export interface NativeTextFormat {
	readonly rangeStart: number;
	readonly rangeEnd: number;
	readonly underlineThickness?: string;
}

export interface NativeTextFormatUpdateEvent extends globalThis.Event {
	getTextFormats?(): readonly NativeTextFormat[];
}

export interface NativeEditContextOptions extends EditContextOptions {
	readonly logService: ILogService;
}

/** Native EditContext adapter used when the browser exposes the API. */
export class NativeEditContext extends AbstractEditContext {
	readonly domNode: FastDomNode<HTMLElement>;
	readonly nativeContext: NativeEditContextObject;
	private readonly imeTextArea: HTMLTextAreaElement;

	private readonly focusEmitter = this._register(new Emitter<void>());
	private readonly blurEmitter = this._register(new Emitter<void>());
	private readonly beforeInputEmitter = this._register(new Emitter<InputEvent>());
	private readonly inputEmitter = this._register(new Emitter<InputEvent>());
	private readonly textUpdateEmitter = this._register(new Emitter<EditContextTextUpdate>());
	private readonly textFormatUpdateEmitter = this._register(new Emitter<EditContextTextFormatUpdate>());
	private readonly keydownEmitter = this._register(new Emitter<IKeyboardEvent>());
	private readonly keyupEmitter = this._register(new Emitter<IKeyboardEvent>());
	private readonly compositionStartEmitter = this._register(new Emitter<EditContextCompositionData>());
	private readonly compositionUpdateEmitter = this._register(new Emitter<EditContextCompositionData>());
	private readonly compositionEndEmitter = this._register(new Emitter<void>());
	private connected = false;
	private readOnlyState: boolean;
	private shadowText = "";
	/** Absolute model offset represented by the first UTF-16 unit in shadowText. */
	private shadowOffset = 0;
	private shadowSelectionStart = 0;
	private shadowSelectionEnd = 0;
	private composing = false;
	private compositionStartOffset = 0;
	private compositionEndOffset = 0;
	private compositionText = '';
	private compositionActiveOffset = 0;
	private pendingLineBreakTextUpdate = false;
	private pendingHighSurrogate: NativeTextUpdateEvent | undefined;
	private compositionPosition: EditContextPosition | undefined;
	private lastPosition: EditContextPosition | undefined;
	private lastRenderPosition: Position | null = null;
	private renderPosition: EditContextPosition | undefined;
	private parentBounds: DOMRect | undefined;
	private parentScrollLeft = 0;
	private parentScrollTop = 0;
	private readonly characterBoundsProvider: (modelOffset: number) => EditContextCharacterBounds | undefined;
	private readonly focusTracker: FocusTracker;
	private readonly screenReaderSupport: ScreenReaderSupport;
	private readonly logService: ILogService;
	private focused = false;
	private imeFallbackFocused = false;

	readonly onDidFocus: Event<void> = this.focusEmitter.event;
	readonly onDidBlur: Event<void> = this.blurEmitter.event;
	readonly onDidBeforeInput: Event<InputEvent> = this.beforeInputEmitter.event;
	readonly onDidInput: Event<InputEvent> = this.inputEmitter.event;
	readonly onDidTextUpdate: Event<EditContextTextUpdate> = this.textUpdateEmitter.event;
	readonly onDidTextFormatUpdate: Event<EditContextTextFormatUpdate> = this.textFormatUpdateEmitter.event;
	readonly onKeyDown: Event<IKeyboardEvent> = this.keydownEmitter.event;
	readonly onKeyUp: Event<IKeyboardEvent> = this.keyupEmitter.event;
	readonly onDidCompositionStart: Event<EditContextCompositionData> = this.compositionStartEmitter.event;
	readonly onDidCompositionUpdate: Event<EditContextCompositionData> = this.compositionUpdateEmitter.event;
	readonly onDidCompositionEnd: Event<void> = this.compositionEndEmitter.event;

	constructor(
		context: ViewContext,
		private readonly container: HTMLElement,
		options: NativeEditContextOptions,
	) {
		super(context);
		const ownerDocument = container.ownerDocument;
		const ownerWindow = ownerDocument.defaultView;
		if (!ownerWindow || typeof (ownerWindow as NativeEditContextWindow).EditContext !== "function") {
			throw new Error("The native EditContext API is unavailable");
		}
		const element = h(ownerDocument, "div");
		const nativeContext = EditContext.create(ownerWindow, {
			text: "",
			selectionStart: 0,
			selectionEnd: 0,
		});
		if (
			typeof nativeContext.updateText !== "function" ||
			typeof nativeContext.updateSelection !== "function" ||
			typeof nativeContext.addEventListener !== "function" ||
			typeof nativeContext.removeEventListener !== "function"
		) {
			throw new Error("The native EditContext implementation is incomplete");
		}
		this.domNode = new FastDomNode(element);
		this.nativeContext = nativeContext;
		this.readOnlyState = options.readOnly;
		if (typeof options.characterBoundsProvider !== "function") {
			throw new TypeError("Native EditContext character bounds provider must be a function");
		}
		this.characterBoundsProvider = options.characterBoundsProvider;
		this.logService = options.logService;
		const imeTextArea = h(ownerDocument, "textarea");
		this.imeTextArea = imeTextArea;
		element.className = "stanza-editor-input stanza-native-edit-context";
		element.tabIndex = -1;
		element.dir = options.textDirection;
		element.setAttribute("role", "textbox");
		element.setAttribute("aria-label", options.ariaLabel ?? "Stanza editor input");
		element.setAttribute("aria-multiline", "true");
		element.setAttribute("aria-autocomplete", this.readOnlyState ? "none" : "both");
		element.setAttribute("aria-roledescription", "code editor");
		element.setAttribute("aria-readonly", String(this.readOnlyState));
		element.setAttribute("autocomplete", "off");
		element.setAttribute("autocapitalize", "off");
		element.setAttribute("spellcheck", "false");
		imeTextArea.className = "stanza-native-ime-text-area";
		imeTextArea.tabIndex = -1;
		imeTextArea.readOnly = true;
		imeTextArea.setAttribute("aria-hidden", "true");
		this.setEditContextOnDomNode();
		this._register(NativeEditContextRegistry.register(options.ownerId, this));
		container.append(imeTextArea);
		this.focusTracker = this._register(new FocusTracker(options.logService, element, focused => this.handleElementFocusChange(focused)));
		this.initializeController(options);
		this.screenReaderSupport = this._register(new ScreenReaderSupport({
			domNode: this.domNode,
			context,
			viewport: options.viewport,
			viewController: options.viewController,
			onDidFocus: this.onDidFocus,
			onDidBlur: this.onDidBlur,
			accessibilityService: options.accessibilityService,
			semanticTokenSource: options.semanticTokenSource,
			bracketColorizationSource: options.bracketColorizationSource,
		}));
		this.synchronizeState();
		this.connect();
	}

	get readOnly(): boolean {
		return this.readOnlyState;
	}

	public override dispose(): void {
		this.handleElementBlur();
		(this.domNode.domNode as NativeEditContextElement).editContext = undefined;
		this.domNode.domNode.blur();
		this.domNode.domNode.remove();
		this.imeTextArea.remove();
		super.dispose();
	}

	/** The model range currently represented by the browser's native buffer. */
	get textWindow(): { readonly startOffset: number; readonly endOffset: number } {
		return Object.freeze({
			startOffset: this.shadowOffset,
			endOffset: this.shadowOffset + this.shadowText.length,
		});
	}

	/** Installs DOM and native-context listeners after semantic consumers subscribe. */
	private connect(): void {
		this.assertNotDisposed();
		if (this.connected) return;
		this.connected = true;
		this._register(addDisposableListener<KeyboardEvent>(
			this.domNode.domNode,
			"keydown",
			event => this.keydownEmitter.fire(new StandardKeyboardEvent(event)),
		));
		this._register(addDisposableListener<KeyboardEvent>(
			this.domNode.domNode,
			'keyup',
			event => this.keyupEmitter.fire(new StandardKeyboardEvent(event)),
		));
		this._register(addDisposableListener<KeyboardEvent>(
			this.imeTextArea,
			"keydown",
			event => this.keydownEmitter.fire(new StandardKeyboardEvent(event)),
		));
		this._register(addDisposableListener<KeyboardEvent>(
			this.imeTextArea,
			'keyup',
			event => this.keyupEmitter.fire(new StandardKeyboardEvent(event)),
		));
		this._register(addDisposableListener(this.imeTextArea, "blur", () => {
			if (this.imeFallbackFocused && this.imeTextArea.ownerDocument.activeElement !== this.domNode.domNode) {
				this.imeFallbackFocused = false;
				this.focusTracker.resume();
				this.handleElementBlur();
			}
		}));
		this._register(IME.onDidChange(enabled => this.handleImeStateChange(enabled)));
		this._register(addDisposableListener<InputEvent>(
			this.domNode.domNode,
			"beforeinput",
			event => {
				if (this.readOnlyState && isEditingInputType(event.inputType)) {
					event.preventDefault();
					this.pendingLineBreakTextUpdate = false;
					this.restoreNativeState();
					return;
				}
				if (
					event.inputType === "historyUndo" ||
					event.inputType === "historyRedo" ||
					event.inputType === "insertLineBreak" ||
					event.inputType === "insertParagraph"
				) {
					if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
						this.pendingLineBreakTextUpdate = true;
					}
					this.beforeInputEmitter.fire(event);
					if (!event.defaultPrevented) this.pendingLineBreakTextUpdate = false;
					else if (this.pendingLineBreakTextUpdate) {
						queueMicrotask(() => {
							this.pendingLineBreakTextUpdate = false;
						});
					}
				}
			},
		));
		this._register(addDisposableListener<InputEvent>(
			this.domNode.domNode,
			"input",
			event => this.inputEmitter.fire(event),
		));
		this._register(addDisposableListener<ClipboardEvent>(
			this.domNode.domNode,
			"copy",
			event => {
				if (!this.isFocused()) {
					event.preventDefault();
					return;
				}
				CopyOptions.electronBugWorkaroundCopyEventHasFired = true;
				const copyEvent = this.fireWillCopy(event, false);
				if (!copyEvent.isHandled) copyEvent.ensureClipboardGetsEditorData();
			},
		));
		this._register(addDisposableListener<ClipboardEvent>(
			this.domNode.domNode,
			"cut",
			event => {
				if (!this.isFocused()) {
					event.preventDefault();
					return;
				}
				CopyOptions.cutEventHasFired = true;
				const cutEvent = this.fireWillCopy(event, true);
				if (cutEvent.isHandled) return;
				if (this.compositionController.composing) {
					cutEvent.setHandled();
					return;
				}
				this.screenReaderSupport.onWillCut();
				cutEvent.ensureClipboardGetsEditorData();
				this.viewController.cut();
			},
		));
		this._register(addDisposableListener<ClipboardEvent>(
			this.domNode.domNode,
			"paste",
			event => {
				if (!this.isFocused()) {
					event.preventDefault();
					return;
				}
				const pasteEvent = this.fireWillPaste(event);
				if (pasteEvent.isHandled) {
					event.preventDefault();
					return;
				}
				if (this.compositionController.composing) {
					pasteEvent.setHandled();
					return;
				}
				event.preventDefault();
				if (!pasteEvent.text) return;
				this.screenReaderSupport.onWillPaste();
				const metadata = pasteEvent.metadata;
				this.viewController.paste(
					pasteEvent.text,
					this._context.configuration.options.get(EditorOption.emptySelectionClipboard) && !!metadata?.isFromEmptySelection,
					metadata?.multicursorText ?? null,
					metadata?.mode ?? null,
				);
			},
		));
		this._register(editContextAddDisposableListener(
			this.nativeContext,
			"textupdate",
			event => this.handleTextUpdate(event as NativeTextUpdateEvent),
		));
		this._register(editContextAddDisposableListener(
			this.nativeContext,
			"textformatupdate",
			event => this.handleTextFormatUpdate(event as NativeTextFormatUpdateEvent),
		));
		this._register(editContextAddDisposableListener(
			this.nativeContext,
			"characterboundsupdate",
			event => this.handleCharacterBoundsUpdate(event as NativeCharacterBoundsUpdateEvent),
		));
		this._register(editContextAddDisposableListener(
			this.nativeContext,
			"compositionstart",
			event => this.handleCompositionStart(event as CompositionEvent),
		));
		this._register(editContextAddDisposableListener(
			this.nativeContext,
			"compositionend",
			event => this.handleCompositionEnd(event as CompositionEvent),
		));
		this._register(editContextAddDisposableListener(
			this.nativeContext,
			"compositionupdate",
			event => {
				if (!this.composing) return;
				const compositionEvent = event as CompositionEvent;
				this.compositionUpdateEmitter.fire({
					data: normalizeTextLineEndings(compositionEvent.data ?? ''),
				});
			},
		));
	}

	focus(): void {
		this.setEditContextOnDomNode();
		if (!IME.enabled) {
			this.focusImeFallback();
			return;
		}
		this.imeFallbackFocused = false;
		this.focusTracker.focus();
	}

	isFocused(): boolean {
		return this.focused;
	}

	refreshFocusState(): void {
		if (this.imeFallbackFocused) {
			this.handleElementFocusChange(this.imeTextArea.ownerDocument.activeElement === this.imeTextArea);
			return;
		}
		this.focusTracker.refreshFocusState();
	}

	public setEditContextOnDomNode(): void {
		const element = this.domNode.domNode as NativeEditContextElement;
		if (element.editContext !== this.nativeContext) element.editContext = this.nativeContext;
	}

	setAriaOptions(options: IEditorAriaOptions): void {
		this.screenReaderSupport.setAriaOptions(options);
	}

	public handleWillPaste(): void {
		this.logService.trace('NativeEditContext#handleWillPaste');
		this.screenReaderSupport.onWillPaste();
	}

	public handleWillCopy(): void {
		this.logService.trace('NativeEditContext#handleWillCopy');
		this.logService.trace('NativeEditContext#isFocused : ', this.domNode.domNode === getActiveElement(this.domNode.domNode.ownerDocument));
	}

	getLastRenderData(): Position | null {
		return this.lastRenderPosition;
	}

	writeScreenReaderContent(_reason: string): void {
		this.screenReaderSupport.writeScreenReaderContent();
	}

	public override onBeforeRender(_viewportData: ViewportData): void {
		this.parentBounds = this.container.getBoundingClientRect();
		this.parentScrollLeft = this.container.scrollLeft;
		this.parentScrollTop = this.container.scrollTop;
	}

	public override onConfigurationChanged(event: viewEvents.ViewConfigurationChangedEvent): boolean {
		if (event.hasChanged(EditorOption.readOnly)) {
			this.setReadOnly(this._context.configuration.options.get(EditorOption.readOnly));
		}
		if (event.hasChanged(EditorOption.ariaLabel)) {
			this.domNode.setAttribute('aria-label', this._context.configuration.options.get(EditorOption.ariaLabel));
		}
		this.screenReaderSupport.onConfigurationChanged(event);
		return event.hasChanged(EditorOption.readOnly) || event.hasChanged(EditorOption.ariaLabel);
	}

	public override onCursorStateChanged(event: viewEvents.ViewCursorStateChangedEvent): boolean {
		this.synchronizeState();
		this.screenReaderSupport.onCursorStateChanged(event);
		return true;
	}

	public override onDecorationsChanged(_event: viewEvents.ViewDecorationsChangedEvent): boolean {
		return true;
	}

	public override onFlushed(_event: viewEvents.ViewFlushedEvent): boolean {
		this.synchronizeState();
		return true;
	}

	public override onLineMappingChanged(_event: viewEvents.ViewLineMappingChangedEvent): boolean {
		this.synchronizeState();
		return true;
	}

	public override onLinesChanged(_event: viewEvents.ViewLinesChangedEvent): boolean {
		this.synchronizeState();
		return true;
	}

	public override onLinesDeleted(_event: viewEvents.ViewLinesDeletedEvent): boolean {
		this.synchronizeState();
		return true;
	}

	public override onLinesInserted(_event: viewEvents.ViewLinesInsertedEvent): boolean {
		this.synchronizeState();
		return true;
	}

	public override onScrollChanged(_event: viewEvents.ViewScrollChangedEvent): boolean {
		return true;
	}

	public override onZonesChanged(_event: viewEvents.ViewZonesChangedEvent): boolean {
		return true;
	}

	public override prepareRender(context: RenderingContext): void {
		this.renderPosition = this.readPosition();
		this.screenReaderSupport.prepareRender(context);
	}

	public override render(context: RestrictedRenderingContext): void {
		if (this.renderPosition) this.updateBounds(this.renderPosition);
		this.screenReaderSupport.render(context);
	}

	private handleElementFocusChange(focused: boolean): void {
		if (!focused) {
			this.composing = false;
			this.pendingHighSurrogate = undefined;
			if (!this.imeFallbackFocused) this.handleElementBlur();
			return;
		}
		if (this.focused) return;
		this.focused = true;
		this._context.viewModel.setHasFocus(true);
		this.focusEmitter.fire(undefined);
	}

	private handleElementBlur(): void {
		if (!this.focused) return;
		this.focused = false;
		this._context.viewModel.setHasFocus(false);
		this.blurEmitter.fire(undefined);
	}

	private handleImeStateChange(enabled: boolean): void {
		if (!enabled && this.focused && !this.imeFallbackFocused) {
			this.focusImeFallback();
	} else if (enabled && this.imeFallbackFocused) {
			this.imeFallbackFocused = false;
			this.focusTracker.resume();
			this.focusTracker.focus();
		}
	}

	private focusImeFallback(): void {
		if (!this.imeFallbackFocused) {
			this.imeFallbackFocused = true;
			if (!this.focused) {
				this.focused = true;
				this._context.viewModel.setHasFocus(true);
				this.focusEmitter.fire(undefined);
			}
		}
		this.imeTextArea.focus({ preventScroll: true });
	}

	/** Native EditContext retains its own editing buffer; there is no textarea value to clear. */
	clear(): void {}

	syncState(state: EditContextState): void {
		if (this.composing) return;
		this.lastRenderPosition = state.position;
		const text = normalizeTextLineEndings(state.text);
		const selectionStart = clampOffset(Math.min(state.selectionStart, state.selectionEnd), text.length);
		const selectionEnd = clampOffset(Math.max(state.selectionStart, state.selectionEnd), text.length);
		const textWindow = createNativeTextWindow(text, selectionStart, selectionEnd);
		const nextText = text.slice(textWindow.startOffset, textWindow.endOffset);
		const nextSelectionStart = selectionStart - textWindow.startOffset;
		const nextSelectionEnd = selectionEnd - textWindow.startOffset;
		const previousText = this.shadowText;
		const previousSelectionStart = this.shadowSelectionStart;
		const previousSelectionEnd = this.shadowSelectionEnd;
		this.shadowOffset = textWindow.startOffset;
		this.shadowText = nextText;
		this.shadowSelectionStart = nextSelectionStart;
		this.shadowSelectionEnd = nextSelectionEnd;
		this.pendingHighSurrogate = undefined;
		const nativeText = typeof this.nativeContext.text === "string" ? this.nativeContext.text : previousText;
		if (nativeText !== nextText) this.nativeContext.updateText(0, nativeText.length, nextText);
		if (
			this.nativeContext.selectionStart !== nextSelectionStart ||
			this.nativeContext.selectionEnd !== nextSelectionEnd
		) {
			this.nativeContext.updateSelection(nextSelectionStart, nextSelectionEnd);
		}
	}

	setReadOnly(readOnly: boolean): void {
		this.readOnlyState = readOnly;
		this.domNode.setAttribute("aria-readonly", String(readOnly));
		this.domNode.setAttribute("aria-autocomplete", readOnly ? "none" : "both");
		if (readOnly) this.restoreNativeState();
	}

	updateBounds(position: EditContextPosition): void {
		this.lastPosition = position;
		const bounds = this.createBounds(position);
		if (!bounds) return;
		this.nativeContext.updateSelectionBounds?.(bounds);
		this.nativeContext.updateControlBounds?.(bounds);
	}

	prepareComposition(): void {
		this.composing = true;
		this.pendingHighSurrogate = undefined;
		this.compositionStartOffset = Math.min(this.shadowSelectionStart, this.shadowSelectionEnd);
		this.compositionEndOffset = Math.max(this.shadowSelectionStart, this.shadowSelectionEnd);
		this.domNode.toggleClassName("ime-input", true);
	}

	positionComposition(position: EditContextPosition): void {
		this.compositionPosition = position;
		this.lastPosition = position;
		this.domNode.setLeft(position.left);
		this.domNode.setTop(position.top);
		this.domNode.setHeight(position.height);
		this.updateBounds(position);
	}

	clearComposition(): void {
		this.composing = false;
		this.compositionText = '';
		this.compositionActiveOffset = 0;
		this.pendingHighSurrogate = undefined;
		this.compositionPosition = undefined;
		this.domNode.toggleClassName("ime-input", false);
		this.domNode.setLeft("");
		this.domNode.setTop("");
		this.domNode.setHeight("");
	}

	private handleTextUpdate(event: NativeTextUpdateEvent): void {
		if (!isNativeTextUpdateEvent(event)) return;
		if (!this.isFocused()) {
			this.pendingHighSurrogate = undefined;
			this.restoreNativeState();
			return;
		}
		const text = normalizeTextLineEndings(event.text);
		if (text.length === 1 && isHighSurrogate(text.charCodeAt(0))) {
			this.pendingHighSurrogate = event;
			return;
		}
		const pending = this.pendingHighSurrogate;
		this.pendingHighSurrogate = undefined;
		if (pending && text.length === 1 && isLowSurrogate(text.charCodeAt(0)) && event.updateRangeStart > 0) {
			this.applyTextUpdate({
				...event,
				text: `${pending.text}${text}`,
				updateRangeStart: pending.updateRangeStart,
				updateRangeEnd: pending.updateRangeEnd,
			});
			return;
		}
		if (pending) this.applyTextUpdate(pending);
		this.applyTextUpdate(event);
	}

	private applyTextUpdate(event: NativeTextUpdateEvent): void {
		const previousText = this.shadowText;
		const previousSelectionStart = this.shadowSelectionStart;
		const previousSelectionEnd = this.shadowSelectionEnd;
		if (!isValidOffset(event.updateRangeStart, previousText.length) || !isValidOffset(event.updateRangeEnd, previousText.length)) return;
		const updateRangeStart = event.updateRangeStart;
		const updateRangeEnd = event.updateRangeEnd;
		if (updateRangeEnd < updateRangeStart) return;
		const text = normalizeTextLineEndings(event.text);
		if (this.pendingLineBreakTextUpdate && text === "\n") {
			this.pendingLineBreakTextUpdate = false;
			this.restoreNativeState();
			return;
		}
		const nextText = previousText.slice(0, updateRangeStart) + text + previousText.slice(updateRangeEnd);
		const selectionStart = clampOffset(
			isFiniteOffset(event.selectionStart) ? event.selectionStart : updateRangeStart + text.length,
			nextText.length,
		);
		const selectionEnd = clampOffset(
			isFiniteOffset(event.selectionEnd) ? event.selectionEnd : selectionStart,
			nextText.length,
		);
		if (this.readOnlyState) {
			this.restoreNativeState();
			return;
		}
		const absoluteUpdateRangeStart = this.shadowOffset + updateRangeStart;
		const absoluteUpdateRangeEnd = this.shadowOffset + updateRangeEnd;
		const absoluteSelectionStart = this.shadowOffset + selectionStart;
		const absoluteSelectionEnd = this.shadowOffset + selectionEnd;
		const absolutePreviousSelectionStart = this.shadowOffset + previousSelectionStart;
		const absolutePreviousSelectionEnd = this.shadowOffset + previousSelectionEnd;
		this.shadowText = nextText;
		this.shadowSelectionStart = selectionStart;
		this.shadowSelectionEnd = selectionEnd;
		this.textUpdateEmitter.fire({
			text,
			updateRangeStart: absoluteUpdateRangeStart,
			updateRangeEnd: absoluteUpdateRangeEnd,
			selectionStart: absoluteSelectionStart,
			selectionEnd: absoluteSelectionEnd,
			previousSelectionStart: absolutePreviousSelectionStart,
			previousSelectionEnd: absolutePreviousSelectionEnd,
			inputType: inferInputType(text, absoluteUpdateRangeStart, absoluteUpdateRangeEnd, absolutePreviousSelectionStart, absolutePreviousSelectionEnd),
		});
		if (this.composing) {
			this.compositionEndOffset = Math.max(this.compositionStartOffset, updateRangeStart + text.length);
			this.emitCompositionType();
		}
	}

	private handleCompositionStart(event: CompositionEvent): void {
		if (!this.isFocused()) {
			event.preventDefault();
			this.restoreNativeState();
			return;
		}
		if (
			this.composing ||
			this.readOnlyState ||
			this._context.viewModel.getSelections().length !== 1
		) {
			if (this.readOnlyState || this._context.viewModel.getSelections().length !== 1) {
				event.preventDefault();
				this.restoreNativeState();
			}
			return;
		}
		this.composing = true;
		this.compositionStartOffset = Math.min(this.shadowSelectionStart, this.shadowSelectionEnd);
		this.compositionEndOffset = Math.max(this.shadowSelectionStart, this.shadowSelectionEnd);
		this.compositionText = '';
		this.compositionActiveOffset = 0;
		this.compositionStartEmitter.fire({
			data: normalizeTextLineEndings(event.data ?? ""),
		});
	}

	private handleCompositionEnd(_event: CompositionEvent): void {
		if (this.pendingHighSurrogate) {
			const pending = this.pendingHighSurrogate;
			this.pendingHighSurrogate = undefined;
			this.applyTextUpdate(pending);
		}
		if (!this.composing) return;
		this.emitCompositionType();
		this.composing = false;
		this.compositionText = '';
		this.compositionActiveOffset = 0;
		this.compositionEndEmitter.fire(undefined);
	}

	private handleTextFormatUpdate(event: NativeTextFormatUpdateEvent): void {
		const formats = event.getTextFormats?.();
		if (!formats) return;
		const normalized: EditContextTextFormat[] = [];
		for (const format of formats) {
			if (
				!isValidOffset(format.rangeStart, this.shadowText.length) ||
				!isValidOffset(format.rangeEnd, this.shadowText.length) ||
				format.rangeEnd < format.rangeStart
			) {
				continue;
			}
			normalized.push(Object.freeze({
				rangeStart: this.shadowOffset + format.rangeStart,
				rangeEnd: this.shadowOffset + format.rangeEnd,
				underlineThickness: typeof format.underlineThickness === "string"
					? format.underlineThickness
					: "none",
			}));
		}
		this.textFormatUpdateEmitter.fire(Object.freeze({
			formats: Object.freeze(normalized),
			browserEvent: event,
		}));
	}

	private handleCharacterBoundsUpdate(event: NativeCharacterBoundsUpdateEvent): void {
		const updateStart = event.rangeStart;
		const updateEnd = event.rangeEnd;
		if (
			!isValidOffset(updateStart, this.shadowText.length) ||
			!isValidOffset(updateEnd, this.shadowText.length) ||
			updateEnd < updateStart
		) {
			return;
		}
		if (updateEnd - updateStart > MAX_CHARACTER_BOUNDS_REQUEST_LENGTH) return;
		const requestEnd = updateEnd;
		const bounds: DOMRect[] = [];
		for (let offset = updateStart; offset < requestEnd; offset += 1) {
			const modelOffset = this.shadowOffset + offset;
			const geometry = this.characterBoundsProvider?.(modelOffset);
			const bound = geometry
				? this.createBounds(geometry, geometry.width)
				: this.createFallbackCharacterBounds();
			if (bound) bounds.push(bound);
		}
		if (bounds.length === requestEnd - updateStart) {
			this.nativeContext.updateCharacterBounds?.(updateStart, bounds);
		}
	}

	private restoreNativeState(): void {
		const nativeText = typeof this.nativeContext.text === "string" ? this.nativeContext.text : this.shadowText;
		if (nativeText !== this.shadowText) {
			this.nativeContext.updateText(0, nativeText.length, this.shadowText);
		}
		if (
			this.nativeContext.selectionStart !== this.shadowSelectionStart ||
			this.nativeContext.selectionEnd !== this.shadowSelectionEnd
		) {
			this.nativeContext.updateSelection(this.shadowSelectionStart, this.shadowSelectionEnd);
		}
	}

	private createFallbackCharacterBounds(): DOMRect | undefined {
		const position = this.compositionPosition ?? this.lastPosition;
		return position ? this.createBounds(position) : undefined;
	}

	private emitCompositionType(): void {
		const start = clampOffset(this.compositionStartOffset, this.shadowText.length);
		const end = clampOffset(Math.max(start, this.compositionEndOffset), this.shadowText.length);
		const text = this.shadowText.slice(start, end);
		const activeOffset = clampOffset(this.shadowSelectionEnd - start, text.length);
		if (text === this.compositionText && activeOffset === this.compositionActiveOffset) return;
		this.emitType({
			text,
			replacePrevCharCnt: this.compositionText.length,
			replaceNextCharCnt: 0,
			positionDelta: activeOffset - text.length,
		});
		this.compositionText = text;
		this.compositionActiveOffset = activeOffset;
	}

	private createBounds(position: EditContextPosition, width = Math.max(1, position.height / 2)): DOMRect | undefined {
		const Rect = this.domNode.domNode.ownerDocument.defaultView?.DOMRect;
		if (typeof Rect !== "function") return undefined;
		const hasPreparedBounds = this.parentBounds !== undefined;
		const parentBounds = this.parentBounds ?? this.container.getBoundingClientRect();
		const scrollLeft = hasPreparedBounds ? this.parentScrollLeft : this.container.scrollLeft;
		const scrollTop = hasPreparedBounds ? this.parentScrollTop : this.container.scrollTop;
		return new Rect(
			parentBounds.left + position.left - scrollLeft,
			parentBounds.top + position.top - scrollTop,
			Math.max(1, width),
			Math.max(1, position.height),
		);
	}
}

function inferInputType(
	text: string,
	updateRangeStart: number,
	updateRangeEnd: number,
	previousSelectionStart: number,
	previousSelectionEnd: number,
): string | undefined {
	if (text.length > 0) {
		if (text === "\n") return "insertLineBreak";
		return updateRangeStart === updateRangeEnd ? "insertText" : "insertReplacementText";
	}
	if (updateRangeStart !== updateRangeEnd) {
		if (previousSelectionStart !== previousSelectionEnd) return "deleteContentBackward";
		return updateRangeEnd <= previousSelectionStart ? "deleteContentBackward" : "deleteContentForward";
	}
	return undefined;
}

function isEditingInputType(inputType: string): boolean {
	return typeof inputType === "string" && (inputType.startsWith("insert") ||
		inputType.startsWith("delete") ||
		inputType === "historyUndo" ||
		inputType === "historyRedo");
}
