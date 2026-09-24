import './textAreaEditContext.css';
import { Disposable } from "../../../../../base/common/lifecycle.js";
import { h } from "../../../../../base/browser/dom.js";
import { FastDomNode } from "../../../../../base/browser/fastDomNode.js";
import { type IKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { type Event } from "../../../../../base/common/event.js";
import { AbstractEditContext, type CompositionController, type EditContextOptions, type EditContextPosition, type EditContextState } from "../editContext.js";
import { type IEditorAriaOptions } from '../../../editorBrowser.js';
import { SelectionDirection } from '../../../../common/core/selection.js';
import { Position } from '../../../../common/core/position.js';
import { Range } from '../../../../common/core/range.js';
import { type View } from '../../../view.js';
import { type RenderingContext, type RestrictedRenderingContext } from '../../../view/renderingContext.js';
import { type ViewContext } from '../../../../common/viewModel/viewContext.js';
import { type IViewModel } from '../../../../common/viewModel.js';
import * as viewEvents from '../../../../common/viewEvents.js';
import { EditorOption } from '../../../../common/config/editorOptions.js';
import { SimplePagedScreenReaderStrategy } from '../screenReaderUtils.js';
import { TextAreaInput, type ICompositionData, type ICompositionStartEvent, type ITextAreaInputHost } from "./textAreaEditContextInput.js";
import { TextAreaEditContextRegistry } from "./textAreaEditContextRegistry.js";
import { TextAreaState, type ITextAreaWrapper } from "./textAreaEditContextState.js";

/** Options accepted by the textarea-backed edit context. */
export type TextAreaEditContextOptions = EditContextOptions;

/**
 * Textarea implementation used when the browser has no EditContext API.
 *
 * The concrete edit context owns its textarea input, composition controller,
 * focus state, ARIA state, and screen-reader mirror.
 */
export class TextAreaEditContext extends AbstractEditContext implements ITextAreaWrapper {
	readonly textArea: FastDomNode<HTMLTextAreaElement>;
	readonly textAreaInput: TextAreaInput;
	private readonly accessibilityController: TextAreaAccessibilityController;
	private lastRenderPosition: Position | null = null;
	private renderPosition: EditContextPosition | undefined;

	get onDidFocus(): Event<void> { return this.textAreaInput.onFocus; }
	get onDidBlur(): Event<void> { return this.textAreaInput.onBlur; }
	get onDidBeforeInput(): Event<InputEvent> { return this.textAreaInput.onDidBeforeInput; }
	get onDidInput(): Event<InputEvent> { return this.textAreaInput.onDidInput; }
	get onKeyDown(): Event<IKeyboardEvent> { return this.textAreaInput.onKeyDown; }
	get onKeyUp(): Event<IKeyboardEvent> { return this.textAreaInput.onKeyUp; }
	get onDidCompositionStart(): Event<ICompositionStartEvent> { return this.textAreaInput.onCompositionStart; }
	get onDidCompositionUpdate(): Event<ICompositionData> { return this.textAreaInput.onCompositionUpdate; }
	get onDidCompositionEnd(): Event<void> { return this.textAreaInput.onCompositionEnd; }

	constructor(
		context: ViewContext,
		container: HTMLElement,
		options: TextAreaEditContextOptions,
	) {
		super(context);
		const ownerDocument = container.ownerDocument;
		this.textArea = new FastDomNode(h(ownerDocument, "textarea"));
		this.textArea.setClassName("stanza-editor-input");
		this.textArea.domNode.tabIndex = -1;
		this.textArea.domNode.spellcheck = false;
		this.textArea.domNode.readOnly = options.readOnly;
		this.textArea.domNode.wrap = "off";
		this.textArea.domNode.dir = options.textDirection;
		this.textArea.domNode.autocomplete = "off";
		this.textArea.setAttribute("autocapitalize", "off");
		this.textArea.setAttribute("aria-label", options.ariaLabel ?? "Stanza editor input");
		this.textArea.setAttribute("aria-multiline", "true");
		this.textArea.setAttribute("aria-roledescription", "code editor");
		this.textArea.setAttribute("aria-readonly", String(this.textArea.domNode.readOnly));
		const inputHost: ITextAreaInputHost = {
			context: this._context,
			getScreenReaderContent: () => this.accessibilityController.getScreenReaderContent(),
			deduceModelPosition: (viewAnchorPosition, deltaOffset, lineFeedCount) => (
				this._context.viewModel.deduceModelPositionRelativeToViewPosition(
					viewAnchorPosition,
					deltaOffset,
					lineFeedCount,
				)
			),
		};
		this.textAreaInput = this._register(new TextAreaInput(inputHost, this.textArea.domNode));
		this._register(this.textAreaInput.onFocus(() => this._context.viewModel.setHasFocus(true)));
		this._register(this.textAreaInput.onBlur(() => this._context.viewModel.setHasFocus(false)));
		this._register(TextAreaEditContextRegistry.register(options.ownerId, this));
		const compositionController = this.initializeController(options);
		this.accessibilityController = this._register(new TextAreaAccessibilityController(this, options.viewport, this._context.viewModel, compositionController));
		this._register(this.textAreaInput.onSelectionChangeRequest(selection => this.viewController.setSelection(selection)));
		this.synchronizeState();
		this.registerInputListeners();
	}

	get domNode(): FastDomNode<HTMLElement> {
		return this.textArea;
	}

	get readOnly(): boolean {
		return this.textArea.domNode.readOnly;
	}

	private registerInputListeners(): void {
		this._register(this.textAreaInput.onType(event => this.emitType(event)));
		this._register(this.textAreaInput.onWillCopy(event => this._onWillCopy.fire(event)));
		this._register(this.textAreaInput.onWillCut(event => this._onWillCut.fire(event)));
		this._register(this.textAreaInput.onWillPaste(event => this._onWillPaste.fire(event)));
		this._register(this.textAreaInput.onCut(() => this.viewController.cut()));
		this._register(this.textAreaInput.onPaste(event => {
			const metadata = event.metadata;
			this.viewController.paste(
				event.text,
				this._context.configuration.options.get(EditorOption.emptySelectionClipboard) && !!metadata?.isFromEmptySelection,
				metadata?.multicursorText ?? null,
				metadata?.mode ?? null,
			);
		}));
	}

	focus(): void {
		this.textAreaInput.focusTextArea();
	}

	isFocused(): boolean {
		return this.textAreaInput.isFocused();
	}

	refreshFocusState(): void {
		this.textAreaInput.refreshFocusState();
	}

	setAriaOptions(options: IEditorAriaOptions): void {
		if (options.activeDescendant) {
			this.textArea.setAttribute('aria-haspopup', 'true');
			this.textArea.setAttribute('aria-autocomplete', 'list');
			this.textArea.setAttribute('aria-activedescendant', options.activeDescendant);
		} else {
			this.textArea.setAttribute('aria-haspopup', 'false');
			this.textArea.setAttribute('aria-autocomplete', 'both');
			this.textArea.removeAttribute('aria-activedescendant');
		}
		if (options.role) this.textArea.setAttribute('role', options.role);
	}

	getLastRenderData(): Position | null {
		return this.lastRenderPosition;
	}

	public getTextAreaDomNode(): HTMLTextAreaElement {
		return this.textArea.domNode;
	}

	writeScreenReaderContent(reason: string): void {
		this.textAreaInput.writeNativeTextAreaContent(reason);
	}

	clear(): void {
		this.textAreaInput.clear();
	}

	getValue(): string {
		return this.textAreaInput.getValue();
	}

	setValue(reason: string, value: string): void {
		this.textAreaInput.setValue(reason, value);
	}

	getSelectionStart(): number {
		return this.textAreaInput.getSelectionStart();
	}

	getSelectionEnd(): number {
		return this.textAreaInput.getSelectionEnd();
	}

	setSelectionRange(reason: string, selectionStart: number, selectionEnd: number): void {
		this.textAreaInput.setSelectionRange(reason, selectionStart, selectionEnd);
	}

	/** The accessibility controller is the state mirror for textarea input. */
	syncState(state: EditContextState): void {
		this.lastRenderPosition = state.position;
	}

	/** Textarea accessibility geometry is maintained by its dedicated controller. */
	updateBounds(_position: EditContextPosition): void {}

	setReadOnly(readOnly: boolean): void {
		this.textArea.domNode.readOnly = readOnly;
		this.textArea.setAttribute("aria-readonly", String(readOnly));
	}

	prepareComposition(): void {
		this.textAreaInput.clear();
		this.textArea.toggleClassName("ime-input", true);
	}

	positionComposition(position: EditContextPosition): void {
		this.textArea.setLeft(position.left);
		this.textArea.setTop(position.top);
		this.textArea.setHeight(position.height);
	}

	clearComposition(): void {
		this.textAreaInput.clear();
		this.textArea.toggleClassName("ime-input", false);
		this.textArea.setLeft("");
		this.textArea.setTop("");
		this.textArea.setHeight("");
	}

	public override onConfigurationChanged(event: viewEvents.ViewConfigurationChangedEvent): boolean {
		if (event.hasChanged(EditorOption.readOnly)) {
			this.setReadOnly(this._context.configuration.options.get(EditorOption.readOnly));
		}
		if (event.hasChanged(EditorOption.ariaLabel)) {
			this.textArea.setAttribute('aria-label', this._context.configuration.options.get(EditorOption.ariaLabel));
		}
		return event.hasChanged(EditorOption.readOnly) || event.hasChanged(EditorOption.ariaLabel);
	}

	public override onCursorStateChanged(_event: viewEvents.ViewCursorStateChangedEvent): boolean {
		this.synchronizeState();
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

	public override prepareRender(_context: RenderingContext): void {
		this.renderPosition = this.readPosition();
	}

	public override render(_context: RestrictedRenderingContext): void {
		if (this.renderPosition) this.updateBounds(this.renderPosition);
		this.writeScreenReaderContent('render');
	}

	public override dispose(): void {
		this._context.viewModel.setHasFocus(false);
		this.textArea.domNode.remove();
		super.dispose();
	}
}

const ACCESSIBILITY_LINES_PER_PAGE = 500;
const MAXIMUM_ACCESSIBLE_INPUT_TEXT_UNITS = 32 * 1_024;

/** Produces the active editor window mirrored into the textarea for assistive technology. */
class TextAreaAccessibilityController extends Disposable {
	private accessibleInputSyncScheduled = false;
	private readonly screenReaderStrategy = new SimplePagedScreenReaderStrategy();

	constructor(
		private readonly input: TextAreaEditContext,
		private readonly viewport: View,
		private readonly viewModel: IViewModel,
		compositionController: CompositionController,
	) {
		super();
		this._register(input.onDidFocus(() => this.input.writeScreenReaderContent('focus')));
		this._register(compositionController.onDidChange(() => this.scheduleScreenReaderContent()));
	}

	getScreenReaderContent(): TextAreaState {
		if (this.isDisposed) return TextAreaState.EMPTY;
		const model = this.viewport.textModel;
		const selection = this.viewModel.getSelections()[0]!;
		this.updateAccessibleSelectionDescription();
		if (model.length > MAXIMUM_ACCESSIBLE_INPUT_TEXT_UNITS) {
			const selectionStartOffset = model.offsetAt(selection.getStartPosition());
			const selectionEndOffset = model.offsetAt(selection.getEndPosition());
			const window = accessibleInputWindow(
				model.length,
				selectionStartOffset,
				selectionEndOffset,
				model.offsetAt(selection.getPosition()),
			);
			const text = model.getTextInRange(Range.fromPositions(model.positionAt(window.startOffset), model.positionAt(window.endOffset)));
			return new TextAreaState(
				text,
				selection.getDirection() === SelectionDirection.RTL
					? clampOffset(selectionEndOffset - window.startOffset, text.length)
					: clampOffset(selectionStartOffset - window.startOffset, text.length),
				selection.getDirection() === SelectionDirection.RTL
					? clampOffset(selectionStartOffset - window.startOffset, text.length)
					: clampOffset(selectionEndOffset - window.startOffset, text.length),
				selection,
				undefined,
			);
		}
		const contentState = this.screenReaderStrategy.fromEditorSelection(
			model,
			selection,
			ACCESSIBILITY_LINES_PER_PAGE,
			true,
		);
		return TextAreaState.fromScreenReaderContentState(contentState);
	}

	private updateAccessibleSelectionDescription(): void {
		const selections = this.viewModel.getSelections();
		if (selections.length === 1) {
			this.input.domNode.removeAttribute('aria-description');
			return;
		}
		const primary = selections[0]!.getPosition();
		this.input.domNode.setAttribute(
			'aria-description',
			`${selections.length} selections. Primary at line ${primary.lineNumber}, column ${primary.column}.`,
		);
	}

	private scheduleScreenReaderContent(): void {
		if (this.accessibleInputSyncScheduled) return;
		this.accessibleInputSyncScheduled = true;
		queueMicrotask(() => {
			this.accessibleInputSyncScheduled = false;
			this.input.writeScreenReaderContent('composition changed');
		});
	}
}

function accessibleInputWindow(modelLength: number, selectionStartOffset: number, selectionEndOffset: number, activeOffset: number): { readonly startOffset: number; readonly endOffset: number } {
	if (modelLength <= MAXIMUM_ACCESSIBLE_INPUT_TEXT_UNITS) return { startOffset: 0, endOffset: modelLength };
	const selectionLength = selectionEndOffset - selectionStartOffset;
	if (selectionLength <= MAXIMUM_ACCESSIBLE_INPUT_TEXT_UNITS) {
		const margin = Math.floor((MAXIMUM_ACCESSIBLE_INPUT_TEXT_UNITS - selectionLength) / 2);
		let startOffset = Math.max(0, selectionStartOffset - margin);
		startOffset = Math.min(startOffset, modelLength - MAXIMUM_ACCESSIBLE_INPUT_TEXT_UNITS);
		if (selectionEndOffset > startOffset + MAXIMUM_ACCESSIBLE_INPUT_TEXT_UNITS) startOffset = selectionEndOffset - MAXIMUM_ACCESSIBLE_INPUT_TEXT_UNITS;
		return { startOffset, endOffset: startOffset + MAXIMUM_ACCESSIBLE_INPUT_TEXT_UNITS };
	}
	const startOffset = Math.min(Math.max(0, activeOffset - Math.floor(MAXIMUM_ACCESSIBLE_INPUT_TEXT_UNITS / 2)), modelLength - MAXIMUM_ACCESSIBLE_INPUT_TEXT_UNITS);
	return { startOffset, endOffset: startOffset + MAXIMUM_ACCESSIBLE_INPUT_TEXT_UNITS };
}

function clampOffset(offset: number, length: number): number {
	return Math.min(Math.max(0, offset), length);
}
