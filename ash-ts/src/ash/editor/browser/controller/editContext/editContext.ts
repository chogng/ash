import { stopEvent } from "../../../../base/browser/dom.js";
import { type FastDomNode } from '../../../../base/browser/fastDomNode.js';
import { type IKeyboardEvent } from "../../../../base/browser/keyboardEvent.js";
import { Emitter, Event, type Event as EditorEvent } from "../../../../base/common/event.js";
import { IME } from "../../../../base/common/ime.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { type Position } from "../../../common/core/position.js";
import { Range } from '../../../common/core/range.js';
import { type Selection } from '../../../common/core/selection.js';
import { TextDecorationCollection, type TextDecorationId } from '../../../common/model/decorationCollection.js';
import { TrackedRangeStickiness } from '../../../common/model.js';
import { normalizeTextLineEndings } from "../../../common/core/textChange.js";
import { type IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { type IEditorAriaOptions } from '../../editorBrowser.js';
import { type View } from "../../view.js";
import { ViewPart } from '../../view/viewPart.js';
import { type EditorViewTextUpdateEvent } from "../../view/viewController.js";
import { type SemanticTokenSource } from '../../viewParts/viewLines/viewLine.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import { type IViewModel } from '../../../common/viewModel.js';
import { isFirefox } from '../../../../base/browser/browser.js';
import { createClipboardCopyEvent, createClipboardPasteEvent, type IClipboardCopyEvent, type IClipboardPasteEvent } from "./clipboardUtils.js";

/** The state that the browser editing surface mirrors from the common editor. */
export interface EditContextState {
	readonly text: string;
	readonly selectionStart: number;
	readonly selectionEnd: number;
	readonly position: Position;
}

/** A browser text update expressed independently of the concrete input element. */
export interface EditContextTextUpdate {
	readonly text: string;
	readonly updateRangeStart: number;
	readonly updateRangeEnd: number;
	readonly selectionStart: number;
	readonly selectionEnd: number;
	readonly previousSelectionStart: number;
	readonly previousSelectionEnd: number;
	readonly inputType: string | undefined;
}

/** Composition lifecycle data shared by textarea and native EditContext. */
export interface EditContextCompositionData {
	readonly data: string;
}

interface CompositionTypeData {
	readonly text: string;
	readonly replacePrevCharCnt: number;
	readonly replaceNextCharCnt: number;
	readonly positionDelta: number;
}

/** Composition formatting reported by the native EditContext implementation. */
export interface EditContextTextFormat {
	readonly rangeStart: number;
	readonly rangeEnd: number;
	readonly underlineThickness: string;
}

export interface EditContextTextFormatUpdate {
	readonly formats: readonly EditContextTextFormat[];
	readonly browserEvent: globalThis.Event;
}

export interface EditContextCharacterBounds {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

export interface EditContextOptions {
	readonly ariaLabel?: string;
	readonly readOnly: boolean;
	readonly textDirection: string;
	/** Stable editor-view identity used by host integrations. */
	readonly ownerId: string;
	/** Resolves model-relative character geometry for native IME requests. */
	readonly characterBoundsProvider: (
		modelOffset: number,
	) => EditContextCharacterBounds | undefined;
	readonly viewController: EditContextViewController;
	readonly viewport: View;
	readonly accessibilityService?: IAccessibilityService;
	readonly semanticTokenSource?: SemanticTokenSource;
}

export interface EditContextViewController {
	readonly hasExpandedSelections: boolean;
	readonly compositionController: CompositionController;
	setSelection(selection: Selection): void;
	type(text: string, inputType?: string): unknown;
	enter(inputType?: string): unknown;
	deleteBackward(inputType?: string): unknown;
	deleteForward(inputType?: string): unknown;
	deleteWordBackward(inputType?: string): unknown;
	deleteWordForward(inputType?: string): unknown;
	deleteSoftLineBackward(inputType?: string): unknown;
	deleteSoftLineForward(inputType?: string): unknown;
	insertTab(): unknown;
	applyTextUpdate(update: EditContextTextUpdate): unknown;
	undo(): void;
	redo(): void;
	toggleOvertype(): boolean;
	paste(text: string, pasteOnNewLine: boolean, multicursorText: string[] | null, mode: string | null): void;
	cut(): void;
	compositionType(text: string, replacePrevCharCnt: number, replaceNextCharCnt: number, positionDelta: number): void;
	compositionStart(): void;
	compositionEnd(): void;
	emitKeyDown(event: IKeyboardEvent): void;
	emitKeyUp(event: IKeyboardEvent): void;
}

/** Content coordinates of the primary editor caret. */
export interface EditContextPosition {
	readonly left: number;
	readonly top: number;
	readonly height: number;
}

/**
 * Browser editing surface used by the semantic editor-view collaborators.
 *
 * The common editor never talks directly to a textarea or to the browser's
 * EditContext object. Implementations translate their platform-specific DOM
 * events into this contract and mirror common-editor state back to the
 * browser. This is the same seam that lets VS Code provide native and
 * textarea edit contexts side by side.
 */
export abstract class AbstractEditContext extends ViewPart {
	abstract readonly domNode: FastDomNode<HTMLElement>;
	protected readonly _onWillCopy = this._register(new Emitter<IClipboardCopyEvent>());
	protected readonly _onWillCut = this._register(new Emitter<IClipboardCopyEvent>());
	protected readonly _onWillPaste = this._register(new Emitter<IClipboardPasteEvent>());
	private readonly willBeforeInputEmitter = this._register(new Emitter<InputEvent>());
	private readonly willTextUpdateEmitter = this._register(new Emitter<EditorViewTextUpdateEvent>());
	private readonly willKeydownEmitter = this._register(new Emitter<KeyboardEvent>());
	private readonly typeEmitter = this._register(new Emitter<CompositionTypeData>());
	private compositionControllerValue: CompositionController | undefined;
	abstract readonly onDidFocus: EditorEvent<void>;
	abstract readonly onDidBlur: EditorEvent<void>;
	abstract readonly onDidBeforeInput: EditorEvent<InputEvent>;
	abstract readonly onDidInput: EditorEvent<InputEvent>;
	readonly onWillBeforeInput: EditorEvent<InputEvent> = this.willBeforeInputEmitter.event;
	readonly onWillTextUpdate: EditorEvent<EditorViewTextUpdateEvent> = this.willTextUpdateEmitter.event;
	readonly onWillKeydown: EditorEvent<KeyboardEvent> = this.willKeydownEmitter.event;
	/** Native EditContext publishes this event; textarea uses an empty event. */
	readonly onDidTextUpdate: EditorEvent<EditContextTextUpdate> = Event.None;
	/** Native EditContext publishes composition formatting; textarea has no equivalent. */
	readonly onDidTextFormatUpdate: EditorEvent<EditContextTextFormatUpdate> = Event.None;
	abstract readonly onKeyDown: EditorEvent<IKeyboardEvent>;
	abstract readonly onKeyUp: EditorEvent<IKeyboardEvent>;
	abstract readonly onDidCompositionStart: EditorEvent<EditContextCompositionData>;
	abstract readonly onDidCompositionUpdate: EditorEvent<EditContextCompositionData>;
	abstract readonly onDidCompositionEnd: EditorEvent<void>;
	/** Clipboard events are emitted before the editor's clipboard contribution handles them. */
	readonly onWillCopy: EditorEvent<IClipboardCopyEvent> = this._onWillCopy.event;
	readonly onWillCut: EditorEvent<IClipboardCopyEvent> = this._onWillCut.event;
	readonly onWillPaste: EditorEvent<IClipboardPasteEvent> = this._onWillPaste.event;
	private viewport: View | undefined;
	private viewControllerValue: EditContextViewController | undefined;

	constructor(context: ViewContext) {
		super(context);
	}

	abstract get readOnly(): boolean;
	abstract focus(): void;
	abstract isFocused(): boolean;
	abstract refreshFocusState(): void;
	abstract setAriaOptions(options: IEditorAriaOptions): void;
	abstract getLastRenderData(): Position | null;
	abstract writeScreenReaderContent(reason: string): void;
	/** Clears transient browser input after a routed DOM event. */
	abstract clear(): void;
	/** Mirrors the common model and primary selection into the browser surface. */
	abstract syncState(state: EditContextState): void;
	/** Updates native control and selection geometry for the primary caret. */
	abstract updateBounds(position: EditContextPosition): void;
	/** Starts the browser's composition presentation. */
	abstract prepareComposition(): void;
	/** Positions the browser's composition presentation in viewport content space. */
	abstract positionComposition(position: EditContextPosition): void;
	/** Removes transient composition presentation state. */
	abstract clearComposition(): void;
	/** Updates the read-only state when IME availability changes. */
	abstract setReadOnly(readOnly: boolean): void;

	get compositionController(): CompositionController {
		if (!this.compositionControllerValue) throw new ReferenceError('Edit context controller is not initialized');
		return this.compositionControllerValue;
	}

	protected initializeController(options: EditContextOptions): CompositionController {
		if (this.compositionControllerValue) throw new ReferenceError('Edit context controller is already initialized');
		this.viewport = options.viewport;
		this.viewControllerValue = options.viewController;
		const compositionController = this._register(new CompositionController(
			this,
			options.viewport,
			this._context.viewModel,
			options.viewController,
			this.typeEmitter.event,
		));
		this.compositionControllerValue = compositionController;
		const viewController = options.viewController;
		this._register(this.onDidBeforeInput(event => this.routeBeforeInput(event, viewController, compositionController)));
		this._register(this.onDidInput(event => {
			if (!event.isComposing || !compositionController.composing) this.clear();
		}));
		this._register(this.onDidTextUpdate(update => this.routeTextUpdate(update, viewController, compositionController)));
		this._register(this.onKeyDown(event => this.routeKeydown(event, viewController)));
		this._register(this.onKeyUp(event => viewController.emitKeyUp(event)));
		return compositionController;
	}

	protected get viewController(): EditContextViewController {
		if (!this.viewControllerValue) throw new ReferenceError('Edit context view controller is not initialized');
		return this.viewControllerValue;
	}

	protected emitType(event: CompositionTypeData): void {
		if (!this.compositionController.composing) this.clear();
		this.typeEmitter.fire(event);
	}

	protected readPosition(): EditContextPosition {
		const viewport = this.requireViewport();
		const position = this._context.viewModel.getSelections()[0]!.getPosition();
		return viewport.getPositionContentCoordinates(position);
	}

	protected fireWillCopy(browserEvent: ClipboardEvent, isCut: boolean): IClipboardCopyEvent {
		const event = createClipboardCopyEvent(browserEvent, isCut, this._context, undefined, isFirefox);
		(isCut ? this._onWillCut : this._onWillCopy).fire(event);
		return event;
	}

	protected fireWillPaste(browserEvent: ClipboardEvent): IClipboardPasteEvent {
		const event = createClipboardPasteEvent(browserEvent);
		this._onWillPaste.fire(event);
		return event;
	}

	private routeBeforeInput(event: InputEvent, viewController: EditContextViewController, compositionController: CompositionController): void {
		if (event.defaultPrevented || (event.isComposing && compositionController.composing)) return;
		if (!this.isFocused()) {
			event.preventDefault();
			return;
		}
		this.willBeforeInputEmitter.fire(event);
		if (event.defaultPrevented) return;

		switch (event.inputType) {
			case "insertText":
			case "insertReplacementText":
				return;
			case "insertLineBreak":
			case "insertParagraph":
				stopEvent(event);
				this.clear();
				viewController.enter(event.inputType);
				return;
			case "deleteContentBackward":
				stopEvent(event);
				this.clear();
				viewController.deleteBackward(event.inputType);
				return;
			case "deleteContentForward":
				stopEvent(event);
				this.clear();
				viewController.deleteForward(event.inputType);
				return;
			case "deleteWordBackward":
				stopEvent(event);
				this.clear();
				viewController.deleteWordBackward(event.inputType);
				return;
			case "deleteWordForward":
				stopEvent(event);
				this.clear();
				viewController.deleteWordForward(event.inputType);
				return;
			case "deleteSoftLineBackward":
				stopEvent(event);
				this.clear();
				viewController.deleteSoftLineBackward(event.inputType);
				return;
			case "deleteSoftLineForward":
				stopEvent(event);
				this.clear();
				viewController.deleteSoftLineForward(event.inputType);
				return;
			case "historyUndo":
				stopEvent(event);
				this.clear();
				viewController.undo();
				return;
			case "historyRedo":
				stopEvent(event);
				this.clear();
				viewController.redo();
				return;
			default:
				return;
		}
	}

	private routeTextUpdate(update: EditContextTextUpdate, viewController: EditContextViewController, compositionController: CompositionController): void {
		if (compositionController.composing) return;
		if (update.updateRangeStart === update.updateRangeEnd && update.text.length === 0) return;
		const event = makeTextUpdateEvent(update);
		this.willTextUpdateEmitter.fire(event);
		if (event.defaultPrevented) return;
		viewController.applyTextUpdate(update);
	}

	private routeKeydown(event: IKeyboardEvent, viewController: EditContextViewController): void {
		const browserEvent = event.browserEvent;
		if (browserEvent.defaultPrevented || !this.isFocused()) return;
		this.willKeydownEmitter.fire(browserEvent);
		viewController.emitKeyDown(event);
		if (browserEvent.defaultPrevented) return;
		if (!event.isComposing && !event.altGraphKey) {
			if (isUndoKeybinding(browserEvent)) {
				event.stop();
				this.clear();
				viewController.undo();
				return;
			}
			if (isRedoKeybinding(browserEvent)) {
				event.stop();
				this.clear();
				viewController.redo();
				return;
			}
		}
		if (!event.isComposing && event.key === "Insert" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
			event.stop();
			viewController.toggleOvertype();
			return;
		}
		if (
			event.isComposing ||
			event.key !== "Tab" ||
			event.shiftKey ||
			event.ctrlKey ||
			event.altKey ||
			event.metaKey
		) return;
		if (viewController.hasExpandedSelections) return;
		event.stop();
		// Tab is a keyboard command, not a browser text-input transaction. Keep it
		// out of post-edit consumers such as SuggestController, matching VS Code's
		// command dispatch ordering.
		viewController.insertTab();
	}

	protected synchronizeState(): void {
		const viewport = this.requireViewport();
		const selection = this._context.viewModel.getSelections()[0]!;
		this.syncState({
			text: viewport.textModel.getText(),
			selectionStart: viewport.textModel.offsetAt(selection.getStartPosition()),
			selectionEnd: viewport.textModel.offsetAt(selection.getEndPosition()),
			position: selection.getPosition(),
		});
	}

	private requireViewport(): View {
		if (!this.viewport) throw new ReferenceError('Edit context is not initialized');
		return this.viewport;
	}

}

function makeTextUpdateEvent(update: EditContextTextUpdate): EditorViewTextUpdateEvent {
	let defaultPrevented = false;
	return {
		...update,
		get defaultPrevented(): boolean {
			return defaultPrevented;
		},
		preventDefault(): void {
			defaultPrevented = true;
		},
	};
}

function isUndoKeybinding(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">): boolean {
	return hasPrimaryModifier(event) && !event.shiftKey && event.key.toLowerCase() === "z";
}

function isRedoKeybinding(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">): boolean {
	if (!hasPrimaryModifier(event)) return false;
	const key = event.key.toLowerCase();
	return (key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey);
}

function hasPrimaryModifier(event: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "metaKey">): boolean {
	return !event.altKey && event.ctrlKey !== event.metaKey;
}

interface ActiveComposition {
	readonly startOffset: number;
	length: number;
	updated: boolean;
	cancelRequested: boolean;
}

/**
 * Maps an edit-context composition stream to one protected Stanza composition session.
 */
export class CompositionController extends Disposable {
	private readonly _onDidChange = this._register(new Emitter<boolean>());
	private readonly input: AbstractEditContext;
	private readonly initialReadOnly: boolean;
	private readonly compositionDecorations: TextDecorationCollection<void>;
	private compositionDecorationIds: readonly TextDecorationId[] = Object.freeze([]);
	private activeComposition: ActiveComposition | undefined;

	readonly onDidChange: Event<boolean> = this._onDidChange.event;

	constructor(
		input: AbstractEditContext,
		private readonly viewport: View,
		private readonly viewModel: IViewModel,
		private readonly viewController: EditContextViewController,
		onType: Event<CompositionTypeData>,
	) {
		super();
		if (viewport.textModel !== viewModel.model) {
			this.dispose();
			throw new TypeError(
				"Stanza composition and view model must share one text model",
			);
		}
		this.input = input;
		this.initialReadOnly = input.readOnly;
		this.compositionDecorations = this._register(new TextDecorationCollection(viewport.textModel));
		this._register(toDisposable(() => {
			this.cancelComposition();
			this.input.setReadOnly(this.initialReadOnly);
			this.clearPresentation();
		}));
		this._register(input.onDidCompositionStart(() => this.handleCompositionStart()));
		this._register(input.onDidCompositionEnd(() => this.handleCompositionEnd()));
		this._register(onType(event => this.handleType(event)));
		this._register(input.onKeyDown(event => {
			if (event.isComposing && event.key === "Escape" && this.activeComposition) {
				this.activeComposition.cancelRequested = true;
			}
		}));
		this._register(input.onDidBlur(() => this.cancelComposition()));
		this._register(IME.onDidChange(enabled => {
			if (!enabled) this.cancelComposition();
			this.synchronizeReadOnly();
		}));
		this._register(viewport.onDidChangeLayout(() => {
			if (this.activeComposition) this.positionInputAtPrimary();
		}));
		this.synchronizeReadOnly();
	}

	get composing(): boolean {
		return Boolean(this.activeComposition);
	}

	private handleCompositionStart(): void {
		if (this.activeComposition) return;
		if (
			!this.input.isFocused() ||
			!IME.enabled ||
			this.viewport.cursorConfig.readOnly ||
			this.viewModel.getSelections().length !== 1
		) return;
		this.input.prepareComposition();
		const startPosition = this.viewModel.getSelections()[0]!.getStartPosition();
		this.viewController.compositionStart();
		this.activeComposition = {
			startOffset: this.viewport.textModel.getOffsetAt(startPosition),
			length: 0,
			updated: false,
			cancelRequested: false,
		};
		this.viewport.domNode.domNode.classList.add("composing");
		this._onDidChange.fire(true);
		this.viewport.revealPosition(startPosition);
		this.positionInput(startPosition);
	}

	private handleCompositionEnd(): void {
		const active = this.activeComposition;
		if (!active) return;
		if (active.cancelRequested) {
			this.cancelComposition();
			return;
		}
		this.activeComposition = undefined;
		this.viewController.compositionEnd();
		this.finishPresentation();
	}

	private handleType(event: CompositionTypeData): void {
		const active = this.activeComposition;
		if (!active) {
			if (event.replacePrevCharCnt || event.replaceNextCharCnt || event.positionDelta) {
				this.viewController.compositionType(
					event.text,
					event.replacePrevCharCnt,
					event.replaceNextCharCnt,
					event.positionDelta,
				);
			} else {
				this.viewController.type(event.text);
			}
			return;
		}
		this.viewController.compositionType(
			event.text,
			event.replacePrevCharCnt,
			event.replaceNextCharCnt,
			event.positionDelta,
		);
		if (this.activeComposition !== active) return;
		active.length = Math.max(
			0,
			active.length - event.replacePrevCharCnt - event.replaceNextCharCnt + event.text.length,
		);
		active.updated = true;
		this.setCompositionRange(Range.fromPositions(
			this.viewport.textModel.positionAt(active.startOffset),
			this.viewport.textModel.positionAt(active.startOffset + active.length),
		));
		this.viewport.revealPosition(
			this.viewModel.getSelections()[0]!.getPosition(),
		);
		this.positionInputAtPrimary();
	}

	private cancelComposition(): void {
		const active = this.activeComposition;
		if (!active) return;
		this.activeComposition = undefined;
		this.viewController.compositionEnd();
		if (active.updated) this.viewport.textModel.undo();
		this.finishPresentation();
	}

	private positionInputAtPrimary(): void {
		this.positionInput(this.viewModel.getSelections()[0]!.getPosition());
	}

	private positionInput(position: Position): void {
		const coordinates = this.viewport.getPositionContentCoordinates(position);
		this.input.positionComposition(coordinates);
	}

	private finishPresentation(): void {
		const changed = this.clearPresentation();
		if (changed) this._onDidChange.fire(false);
	}

	private clearPresentation(): boolean {
		const changed = this.viewport.domNode.domNode.classList.contains("composing") ||
			this.input.domNode.domNode.classList.contains("ime-input");
		this.viewport.domNode.domNode.classList.remove("composing");
		this.input.clearComposition();
		this.setCompositionRange(undefined);
		return changed;
	}

	private setCompositionRange(range: Range | undefined): void {
		this.compositionDecorationIds = this.compositionDecorations.deltaDecorations(
			this.compositionDecorationIds,
			range ? [{
				range,
				stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
				options: {
					description: 'composition-decoration',
					inlineClassName: 'edit-context-composition-primary',
				},
				metadata: undefined,
			}] : [],
		);
	}

	private synchronizeReadOnly(): void {
		this.input.setReadOnly(this.initialReadOnly || !IME.enabled);
	}
}
