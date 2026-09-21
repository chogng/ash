import { type IKeyboardEvent } from '../../../base/browser/keyboardEvent.js';
import { type IMouseWheelEvent } from '../../../base/browser/mouseEvent.js';
import { addDisposableListener } from '../../../base/browser/dom.js';
import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { isLinux, operatingSystem, OperatingSystem } from '../../../base/common/platform.js';
import { ReplaceCommand } from '../../common/commands/replaceCommand.js';
import { EditorLineWrapping, EditorOption } from '../../common/config/editorOptions.js';
import { ColumnSelection } from '../../common/cursor/cursorColumnSelection.js';
import { CursorMove, CursorMoveCommands } from '../../common/cursor/cursorMoveCommands.js';
import { DeleteOperations } from '../../common/cursor/cursorDeleteOperations.js';
import { type DeleteWordContext, WordNavigationType, WordOperations } from '../../common/cursor/cursorWordOperations.js';
import { CursorChangeReason } from '../../common/cursorEvents.js';
import { CursorState, EditOperationType, SelectionStartKind, SingleCursorState } from '../../common/cursorCommon.js';
import { TypeOperations } from '../../common/cursor/cursorTypeOperations.js';
import { Selection } from '../../common/core/selection.js';
import { Position } from '../../common/core/position.js';
import { Range } from '../../common/core/range.js';
import { getMapForWordSeparators } from '../../common/core/wordCharacterClassifier.js';
import { type TextModelChange } from '../../common/core/textChange.js';
import { type TextModel } from '../../common/model/textModel.js';
import { EditorCursorNavigationCommand, EditorCursorNavigationMode, navigateStanzaVisualCursors } from '../../common/viewModel/visualCursorNavigation.js';
import { type IViewModel } from '../../common/viewModel.js';
import { ViewEventHandler } from '../../common/viewEventHandler.js';
import { type View } from '../view.js';
import { NavigationCommandRevealType } from '../coreCommands.js';
import { type AbstractEditContext, type CompositionController, type EditContextTextUpdate } from '../controller/editContext/editContext.js';
import { TextAreaEditContext } from '../controller/editContext/textArea/textAreaEditContext.js';
import { ViewUserInputEvents } from './viewUserInputEvents.js';
import { type IAccessibilityService } from '../../../platform/accessibility/common/accessibility.js';
import { type IEditorMouseEvent, type IPartialEditorMouseEvent } from '../editorBrowser.js';
import { type SemanticTokenSource } from '../viewParts/viewLines/viewLine.js';
import { type ILogService } from '../../../platform/log/common/log.js';
import { type ICommand } from '../../common/editorCommon.js';
import { InputMode } from '../../common/inputMode.js';

/** A native text update that can be consumed by an editor contribution before model routing. */
export interface EditorViewTextUpdateEvent extends EditContextTextUpdate {
	readonly defaultPrevented: boolean;
	preventDefault(): void;
}

/** One committed browser edit reported to editor contributions. */
export interface EditorViewDidEditEvent {
	readonly inputType: string;
	readonly insertedText: string | undefined;
	readonly change: TextModelChange;
}

export interface ViewControllerOptions {
	readonly ownerId?: string;
	readonly logService?: ILogService;
	readonly ariaLabel?: string;
	readonly accessibilityService?: IAccessibilityService;
	readonly semanticTokenSource?: SemanticTokenSource;
	readonly userInputEvents?: ViewUserInputEvents;
}

export interface IMouseDispatchData {
	position: Position;
	mouseColumn: number;
	revealType: NavigationCommandRevealType;
	startedOnLineNumbers: boolean;
	inSelectionMode: boolean;
	mouseDownCount: number;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
	leftButton: boolean;
	middleButton: boolean;
	onInjectedText: boolean;
}

const enum MouseSelectionKind {
	Character,
	Word,
	WholeLine,
	ExtendToWord,
	ExtendToLine,
	Column,
}

interface MouseSelectionState {
	readonly kind: MouseSelectionKind;
	readonly anchorRange: Range;
	readonly baseSelections: readonly Selection[] | undefined;
	readonly toggleCandidateIndex: number | undefined;
}

/**
 * Routes semantic editor commands into common editing operations.
 *
 * Browser input adapters normalize raw events, while this class owns their lifecycle,
 * command execution, command transformation, overtype, and contribution-facing events.
 */
export class ViewController extends Disposable {
	private readonly didChangeOvertypeEmitter = this._register(new Emitter<boolean>());
	private readonly didEditEmitter = this._register(new Emitter<EditorViewDidEditEvent>());
	readonly userInputEvents: ViewUserInputEvents;
	readonly ownerId: string;
	readonly editContext: AbstractEditContext;
	readonly element: HTMLElement;
	readonly textArea: HTMLTextAreaElement | undefined;
	readonly compositionController: CompositionController;
	readonly onWillBeforeInput: Event<InputEvent>;
	readonly onWillTextUpdate: Event<EditorViewTextUpdateEvent>;
	readonly onWillKeydown: Event<KeyboardEvent>;
	private overtype = false;
	private mouseSelection: MouseSelectionState | undefined;

	readonly onDidChangeOvertype: Event<boolean> = this.didChangeOvertypeEmitter.event;
	readonly onDidEdit: Event<EditorViewDidEditEvent> = this.didEditEmitter.event;

	constructor(
		readonly viewport: View,
		private readonly viewModel: IViewModel,
		options: ViewControllerOptions,
		createEditContext: (viewController: ViewController) => AbstractEditContext,
	) {
		super();
		try {
			this.userInputEvents = options.userInputEvents ?? new ViewUserInputEvents(viewport.coordinatesConverter);
			this.ownerId = options.ownerId === undefined ? nextViewId() : validateOwnerId(options.ownerId);
			this.editContext = createEditContext(this);
			this.element = this.editContext.domNode.domNode;
			this.textArea = this.editContext instanceof TextAreaEditContext ? this.editContext.getTextAreaDomNode() : undefined;
			this.compositionController = this.editContext.compositionController;
			this.onWillBeforeInput = this.editContext.onWillBeforeInput;
			this.onWillTextUpdate = this.editContext.onWillTextUpdate;
			this.onWillKeydown = this.editContext.onWillKeydown;
			this._register(this.onDidChangeOvertype(overtyping => {
				viewport.domNode.domNode.classList.toggle('overtype', overtyping);
			}));
			this._register(toDisposable(() => {
				viewport.domNode.domNode.classList.remove('input-focused');
				viewport.domNode.domNode.classList.remove('overtype');
			}));
			this._register(addDisposableListener(viewport.domNode.domNode, 'focus', event => {
				if (event.target === viewport.domNode.domNode) viewport.focus();
			}));
			this._register(this.editContext.onDidFocus(() => viewport.domNode.domNode.classList.add('input-focused')));
			this._register(this.editContext.onDidBlur(() => {
				viewport.domNode.domNode.classList.remove('input-focused');
				this.editContext.clear();
			}));
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	revealPosition(position: Position): void { this.viewport.revealPosition(position); }
	clearInput(): void { this.editContext.clear(); }

	get overtyping(): boolean {
		return this.overtype;
	}

	get hasExpandedSelections(): boolean {
		return this.viewModel.getSelections().some(selection => !selection.isEmpty());
	}

	public setSelection(modelSelection: Selection): void {
		this.viewport.textModel.validateRange(modelSelection);
		this.viewModel.setSelections('api', [modelSelection]);
		this.viewport.revealPosition(modelSelection.getPosition());
	}

	public moveTo(viewPosition: Position, revealType: NavigationCommandRevealType): void {
		const position = this.viewport.coordinatesConverter.convertViewPositionToModelPosition(viewPosition);
		this.viewModel.setSelections('mouse', [Selection.fromPositions(position)]);
		this.revealMousePosition(position, revealType);
	}

	public dispatchMouse(data: IMouseDispatchData): void {
		const position = this.viewport.coordinatesConverter.convertViewPositionToModelPosition(data.position);
		if (data.inSelectionMode && this.mouseSelection) {
			this.applyMouseSelection(this.mouseSelection, position, data.revealType);
			return;
		}

		this.mouseSelection = undefined;
		const options = this.viewport;
		const selectionClipboard = isLinux && options.getOption(EditorOption.selectionClipboard);
		if (data.middleButton && !selectionClipboard) {
			if (!options.getOption(EditorOption.scrollOnMiddleClick)) {
				this.beginMouseSelection(MouseSelectionKind.Column, position, data, false);
			}
			return;
		}

		const multiCursor = this.hasMultiCursorModifier(data);
		if (data.startedOnLineNumbers) {
			this.beginMouseSelection(data.shiftKey ? MouseSelectionKind.ExtendToLine : MouseSelectionKind.WholeLine, position, data, multiCursor);
			return;
		}
		if (data.mouseDownCount >= 4) {
			const model = this.viewport.textModel;
			this.setSelection(Selection.fromPositions(model.positionAt(0), model.positionAt(model.length)));
			return;
		}
		if (data.mouseDownCount === 3) {
			this.beginMouseSelection(data.shiftKey ? MouseSelectionKind.ExtendToLine : MouseSelectionKind.WholeLine, position, data, multiCursor);
			return;
		}
		if (data.mouseDownCount === 2) {
			if (!data.onInjectedText) {
				this.beginMouseSelection(data.shiftKey ? MouseSelectionKind.ExtendToWord : MouseSelectionKind.Word, position, data, multiCursor);
			}
			return;
		}

		if (multiCursor) {
			if (this.hasNonMultiCursorModifier(data)) return;
			this.beginMouseSelection(data.shiftKey ? MouseSelectionKind.Column : MouseSelectionKind.Character, position, data, !data.shiftKey);
			return;
		}
		if (data.altKey || options.getOption(EditorOption.columnSelection)) {
			this.beginMouseSelection(MouseSelectionKind.Column, position, data, false);
			return;
		}
		this.beginMouseSelection(MouseSelectionKind.Character, position, data, false);
	}

	private beginMouseSelection(kind: MouseSelectionKind, position: Position, data: IMouseDispatchData, addSelection: boolean): void {
		const primary = this.viewModel.getSelections()[0]!;
		const extend = data.shiftKey || data.inSelectionMode;
		let anchorRange: Range;
		switch (kind) {
			case MouseSelectionKind.Word:
				anchorRange = wordSelectionRange(this.viewport.cursorConfig, this.viewport.textModel, position);
				break;
			case MouseSelectionKind.WholeLine:
				anchorRange = Range.fromPositions(lineStart(position.lineNumber));
				break;
			case MouseSelectionKind.ExtendToWord:
			case MouseSelectionKind.ExtendToLine:
				anchorRange = Range.fromPositions(primary.getSelectionStart());
				break;
			case MouseSelectionKind.Column:
			case MouseSelectionKind.Character:
				anchorRange = Range.fromPositions(extend ? primary.getSelectionStart() : position);
				break;
		}
		const initialSelection = selectionForMouseTarget(kind, this.viewport.cursorConfig, this.viewport.textModel, anchorRange, position);
		const baseSelections = addSelection ? Object.freeze([...this.viewModel.getSelections()]) : undefined;
		this.mouseSelection = {
			kind,
			anchorRange,
			baseSelections,
			toggleCandidateIndex: baseSelections ? findPointerToggleCandidate(baseSelections, initialSelection) : undefined,
		};
		this.applyMouseSelection(this.mouseSelection, position, data.revealType);
	}

	private applyMouseSelection(state: MouseSelectionState, position: Position, revealType: NavigationCommandRevealType): void {
		if (state.kind === MouseSelectionKind.Column) {
			this.viewModel.setSelections('mouse', ColumnSelection.columnSelect(this.viewport.textModel, state.anchorRange.getStartPosition(), position));
			this.revealMousePosition(position, revealType);
			return;
		}
		const selection = selectionForMouseTarget(state.kind, this.viewport.cursorConfig, this.viewport.textModel, state.anchorRange, position);
		this.viewModel.setSelections('mouse', state.baseSelections
			? combinePointerSelection(state.baseSelections, selection, state.toggleCandidateIndex)
			: [selection]);
		this.revealMousePosition(position, revealType);
	}

	private revealMousePosition(position: Position, revealType: NavigationCommandRevealType): void {
		if (revealType !== NavigationCommandRevealType.None) this.viewport.revealPosition(position);
	}

	private hasMultiCursorModifier(data: IMouseDispatchData): boolean {
		return data[this.viewport.getOption(EditorOption.multiCursorModifier)];
	}

	private hasNonMultiCursorModifier(data: IMouseDispatchData): boolean {
		switch (this.viewport.getOption(EditorOption.multiCursorModifier)) {
			case 'altKey': return data.ctrlKey || data.metaKey;
			case 'ctrlKey': return data.altKey || data.metaKey;
			case 'metaKey': return data.ctrlKey || data.altKey;
		}
	}

	toggleOvertype(): boolean {
		this.overtype = !this.overtype;
		InputMode.setInputMode(this.overtype ? 'overtype' : 'insert');
		this.didChangeOvertypeEmitter.fire(this.overtype);
		return this.overtype;
	}

	public type(text: string, inputType = 'insertText'): TextModelChange | undefined {
		return this.executeType(this.viewModel.getSelections(), text, inputType);
	}

	public paste(text: string, pasteOnNewLine: boolean, multicursorText: string[] | null, _mode: string | null = null): void {
		this.runViewModelEdit('insertFromPaste', undefined, () => this.viewModel.paste(text, pasteOnNewLine, multicursorText, 'keyboard'));
	}

	public compositionType(text: string, replacePrevCharCnt: number, replaceNextCharCnt: number, positionDelta: number): void {
		this.runViewModelEdit('insertCompositionText', text, () => this.viewModel.compositionType(text, replacePrevCharCnt, replaceNextCharCnt, positionDelta, 'keyboard'));
	}

	public compositionStart(): void {
		this.viewModel.startComposition();
	}

	public compositionEnd(): void {
		this.viewModel.endComposition('keyboard');
	}

	public cut(): void {
		this.runViewModelEdit('deleteByCut', undefined, () => this.viewModel.cut('keyboard'));
	}

	public enter(inputType = 'insertLineBreak'): TextModelChange | undefined {
		return this.executeEnter(this.viewModel.getSelections(), inputType);
	}

	public deleteBackward(inputType = 'deleteContentBackward'): TextModelChange | undefined {
		return this.executeDelete('left', this.viewModel.getSelections(), inputType);
	}

	public deleteForward(inputType = 'deleteContentForward'): TextModelChange | undefined {
		return this.executeDelete('right', this.viewModel.getSelections(), inputType);
	}

	public deleteWordBackward(inputType = 'deleteWordBackward'): TextModelChange | undefined {
		return this.executeCommands(createWordDeleteCommands(this.viewport.cursorConfig, this.viewport.textModel, this.viewModel, 'left'), inputType, EditOperationType.DeletingLeft, true, false);
	}

	public deleteWordForward(inputType = 'deleteWordForward'): TextModelChange | undefined {
		return this.executeCommands(createWordDeleteCommands(this.viewport.cursorConfig, this.viewport.textModel, this.viewModel, 'right'), inputType, EditOperationType.DeletingRight, true, false);
	}

	public deleteSoftLineBackward(inputType = 'deleteSoftLineBackward'): TextModelChange | undefined {
		return this.executeCommands(createDeleteToLineBoundaryCommands(this.viewport.textModel, this.viewModel.getSelections(), 'start'), inputType, EditOperationType.Other, true, true);
	}

	public deleteSoftLineForward(inputType = 'deleteSoftLineForward'): TextModelChange | undefined {
		return this.executeCommands(createDeleteToLineBoundaryCommands(this.viewport.textModel, this.viewModel.getSelections(), 'end'), inputType, EditOperationType.Other, true, true);
	}

	public insertTab(): TextModelChange | undefined {
		return this.runViewModelEdit('insertText', '\t', () => this.viewModel.executeCommands(TypeOperations.tab(this.viewport.cursorConfig, this.viewport.textModel, this.viewModel.getSelections()), 'keyboard'), false);
	}

	public applyTextUpdate(update: EditContextTextUpdate): TextModelChange | undefined {
		const model = this.viewport.textModel;
		const selections = this.selectionsForTextUpdate(update);
		const inputType = update.inputType ?? (update.text.length > 0 ? 'insertText' : 'deleteContentBackward');
		if (update.text.length > 0) {
			if (inputType === 'insertLineBreak' || inputType === 'insertParagraph') return this.executeEnter(selections, inputType, update.text);
			return this.executeType(selections, update.text, inputType);
		}
		if (inputType === 'deleteContentForward') return this.executeDelete('right', selections, inputType);
		if (inputType === 'deleteContentBackward') {
			return this.executeDelete('left', selections, inputType);
		}
		this.viewModel.setSelections(inputType, selections);
		return this.runViewModelEdit(inputType, undefined, () => this.viewModel.type('', inputType));
	}

	public undo(): void {
		if (this.viewModel.cursorConfig.readOnly) return;
		this.viewport.textModel.undo();
		this.revealPrimary();
	}

	public redo(): void {
		if (this.viewModel.cursorConfig.readOnly) return;
		this.viewport.textModel.redo();
		this.revealPrimary();
	}

	private executeType(selections: readonly Selection[], text: string, inputType: string): TextModelChange | undefined {
		this.viewModel.setSelections(inputType, selections);
		return this.runViewModelEdit(inputType, text, () => this.viewModel.type(text, 'keyboard'));
	}

	private executeEnter(selections: readonly Selection[], inputType: string, text = '\n'): TextModelChange | undefined {
		this.viewModel.setSelections(inputType, selections);
		return this.runViewModelEdit(inputType, undefined, () => this.viewModel.type(text, 'keyboard'));
	}

	private executeDelete(direction: 'left' | 'right', selections: readonly Selection[], inputType: string): TextModelChange | undefined {
		const previousType = this.viewModel.getPrevEditOperationType();
		const operation = direction === 'left'
			? DeleteOperations.deleteLeft(previousType, this.viewport.cursorConfig, this.viewport.textModel, [...selections], this.viewModel.getCursorAutoClosedCharacters())
			: DeleteOperations.deleteRight(previousType, this.viewport.cursorConfig, this.viewport.textModel, [...selections]);
		return this.executeCommands(
			operation[1],
			inputType,
			direction === 'left' ? EditOperationType.DeletingLeft : EditOperationType.DeletingRight,
			operation[0],
			false,
		);
	}

	private executeCommands(commands: readonly (ICommand | null)[], inputType: string, type: EditOperationType, pushBefore: boolean, pushAfter: boolean): TextModelChange | undefined {
		if (pushBefore) this.viewport.textModel.pushStackElement();
		let change: TextModelChange | undefined;
		const capture = this.viewport.textModel.onDidChangeContent(event => { change = event; });
		try {
			this.viewModel.executeCommands([...commands], inputType);
		} finally {
			capture.dispose();
		}
		this.viewModel.setPrevEditOperationType(type);
		if (pushAfter) this.viewport.textModel.pushStackElement();
		this.revealPrimary();
		if (change) this.didEditEmitter.fire(Object.freeze({ inputType, insertedText: undefined, change }));
		return change;
	}

	private selectionsForTextUpdate(update: EditContextTextUpdate): readonly Selection[] {
		const current = this.viewModel.getSelections();
		const primary = current[0]!;
		const primaryStart = this.viewport.textModel.offsetAt(primary.getStartPosition());
		const primaryEnd = this.viewport.textModel.offsetAt(primary.getEndPosition());
		if (primaryStart === update.previousSelectionStart && primaryEnd === update.previousSelectionEnd) return current;
		return [Selection.fromPositions(
			this.viewport.textModel.positionAt(update.updateRangeStart),
			this.viewport.textModel.positionAt(update.updateRangeEnd),
		)];
	}

	private runViewModelEdit(inputType: string, insertedText: string | undefined, edit: () => void, emitDidEdit = true): TextModelChange | undefined {
		let change: TextModelChange | undefined;
		const capture = this.viewport.textModel.onDidChangeContent(event => { change = event; });
		try {
			edit();
		} finally {
			capture.dispose();
		}
		this.revealPrimary();
		if (change && emitDidEdit) this.didEditEmitter.fire(Object.freeze({ inputType, insertedText, change }));
		return change;
	}

	private revealPrimary(): void {
		this.viewport.revealPosition(this.viewModel.getSelections()[0]!.getPosition());
	}

	/** Forwards view-originated input without taking ownership of its policy. */
	emitKeyDown(event: IKeyboardEvent): void {
		this.userInputEvents.emitKeyDown(event);
	}

	emitKeyUp(event: IKeyboardEvent): void {
		this.userInputEvents.emitKeyUp(event);
	}

	emitContextMenu(event: IEditorMouseEvent): void {
		this.userInputEvents.emitContextMenu(event);
	}

	emitMouseMove(event: IEditorMouseEvent): void {
		this.userInputEvents.emitMouseMove(event);
	}

	emitMouseLeave(event: IPartialEditorMouseEvent): void {
		this.userInputEvents.emitMouseLeave(event);
	}

	emitMouseDown(event: IEditorMouseEvent): void {
		this.userInputEvents.emitMouseDown(event);
	}

	emitMouseUp(event: IEditorMouseEvent): void {
		this.userInputEvents.emitMouseUp(event);
	}

	emitMouseDrag(event: IEditorMouseEvent): void {
		this.userInputEvents.emitMouseDrag(event);
	}

	emitMouseDrop(event: IPartialEditorMouseEvent): void {
		this.userInputEvents.emitMouseDrop(event);
	}

	emitMouseDropCanceled(): void {
		this.userInputEvents.emitMouseDropCanceled();
	}

	emitMouseWheel(event: IMouseWheelEvent): void {
		this.userInputEvents.emitMouseWheel(event);
	}

}

function findPointerToggleCandidate(selections: readonly Selection[], selection: Selection): number | undefined {
	const index = selections.findIndex(candidate => selectionsHaveSameRange(candidate, selection));
	return index < 0 ? undefined : index;
}

function combinePointerSelection(selections: readonly Selection[], active: Selection, toggleIndex: number | undefined): readonly Selection[] {
	if (toggleIndex !== undefined && (!Number.isSafeInteger(toggleIndex) || toggleIndex < 0 || toggleIndex >= selections.length)) {
		throw new RangeError('Pointer toggle candidate is outside the selection set');
	}
	if (toggleIndex !== undefined && selectionsHaveSameRange(selections[toggleIndex]!, active)) {
		return selections.length === 1 ? selections : Object.freeze(selections.filter((_, index) => index !== toggleIndex));
	}
	const retained = toggleIndex === undefined ? [...selections] : selections.filter((_, index) => index !== toggleIndex);
	const duplicateIndex = retained.findIndex(selection => selectionsHaveSameRange(selection, active));
	if (duplicateIndex >= 0) {
		return Object.freeze([retained[duplicateIndex]!, ...retained.slice(0, duplicateIndex), ...retained.slice(duplicateIndex + 1)]);
	}
	return Object.freeze([active, ...retained.filter(selection => !selectionRangesOverlap(selection, active))]);
}

function selectionsHaveSameRange(left: Selection, right: Selection): boolean {
	return left.getStartPosition().equals(right.getStartPosition()) && left.getEndPosition().equals(right.getEndPosition());
}

function selectionRangesOverlap(left: Selection, right: Selection): boolean {
	if (left.isEmpty()) return pointOverlapsSelection(left.getPosition(), right);
	if (right.isEmpty()) return pointOverlapsSelection(right.getPosition(), left);
	return left.getStartPosition().isBefore(right.getEndPosition()) && right.getStartPosition().isBefore(left.getEndPosition());
}

function pointOverlapsSelection(point: Position, selection: Selection): boolean {
	return selection.isEmpty()
		? point.equals(selection.getPosition())
		: !point.isBefore(selection.getStartPosition()) && point.isBefore(selection.getEndPosition());
}

function selectionForMouseTarget(kind: MouseSelectionKind, config: View['cursorConfig'], model: TextModel, anchorRange: Range, position: Position): Selection {
	const anchor = anchorRange.getStartPosition();
	switch (kind) {
		case MouseSelectionKind.Character:
			return Selection.fromPositions(anchor, position);
		case MouseSelectionKind.Column:
			return Selection.fromPositions(anchor);
		case MouseSelectionKind.Word:
			return wordSelection(config, model, anchorRange, position);
		case MouseSelectionKind.WholeLine:
			return wholeLineSelection(model, anchor.lineNumber, position.lineNumber);
		case MouseSelectionKind.ExtendToWord:
			return extendSelectionToWord(config, model, anchor, position);
		case MouseSelectionKind.ExtendToLine:
			return extendSelectionToLine(model, anchor, position.lineNumber);
	}
}

function wordSelection(config: View['cursorConfig'], model: TextModel, anchorRange: Range, position: Position): Selection {
	const activeRange = wordSelectionRange(config, model, position);
	return Position.compare(activeRange.getStartPosition(), anchorRange.getStartPosition()) < 0
		? Selection.fromPositions(anchorRange.getEndPosition(), activeRange.getStartPosition())
		: Selection.fromPositions(anchorRange.getStartPosition(), activeRange.getEndPosition());
}

function extendSelectionToWord(config: View['cursorConfig'], model: TextModel, anchor: Position, position: Position): Selection {
	const range = wordSelectionRange(config, model, position);
	const active = Position.compare(range.getStartPosition(), anchor) < 0 ? range.getStartPosition() : range.getEndPosition();
	return Selection.fromPositions(anchor, active);
}

function wordSelectionRange(config: View['cursorConfig'], model: TextModel, position: Position): Range {
	const cursor = new SingleCursorState(Range.fromPositions(position), SelectionStartKind.Simple, 0, position, 0);
	return WordOperations.word(config, model, cursor, false, position).selection;
}

function wholeLineSelection(model: TextModel, anchorLineNumber: number, activeLineNumber: number): Selection {
	return activeLineNumber >= anchorLineNumber
		? Selection.fromPositions(lineStart(anchorLineNumber), lineEndExclusive(model, activeLineNumber))
		: Selection.fromPositions(lineEndExclusive(model, anchorLineNumber), lineStart(activeLineNumber));
}

function extendSelectionToLine(model: TextModel, anchor: Position, activeLineNumber: number): Selection {
	const active = activeLineNumber < anchor.lineNumber ? lineStart(activeLineNumber) : lineEndExclusive(model, activeLineNumber);
	return Selection.fromPositions(anchor, active);
}

function lineStart(lineNumber: number): Position {
	return new Position(lineNumber, 1);
}

function lineEndExclusive(model: TextModel, lineNumber: number): Position {
	return lineNumber < model.lineCount
		? new Position(lineNumber + 1, 1)
		: new Position(lineNumber, model.getLineContent(lineNumber).length + 1);
}

let viewId = 1;

function nextViewId(): string { return `ash-editor-view-${viewId++}`; }

function validateOwnerId(value: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError('Editor view ownerId must be a non-empty string');
	return value;
}

function createDeleteToLineBoundaryCommands(model: TextModel, selections: readonly Selection[], boundary: 'start' | 'end'): Array<ICommand | null> {
	return selections.map(selection => {
		const position = selection.getPosition();
		const range = selection.isEmpty()
			? boundary === 'start'
				? Range.fromPositions(new Position(position.lineNumber, 1), position)
				: Range.fromPositions(position, new Position(position.lineNumber, model.getLineMaxColumn(position.lineNumber)))
			: selection;
		return range.isEmpty() ? null : new ReplaceCommand(range, '');
	});
}

function createWordDeleteCommands(config: View['cursorConfig'], model: TextModel, viewModel: IViewModel, direction: 'left' | 'right'): Array<ICommand | null> {
	const wordSeparators = getMapForWordSeparators(config.wordSeparators, config.wordSegmenterLocales);
	const autoClosedCharacters = viewModel.getCursorAutoClosedCharacters();
	return viewModel.getSelections().map(selection => {
		const context: DeleteWordContext = {
			wordSeparators,
			model,
			selection,
			whitespaceHeuristics: true,
			autoClosingDelete: config.autoClosingDelete,
			autoClosingBrackets: config.autoClosingBrackets,
			autoClosingQuotes: config.autoClosingQuotes,
			autoClosingPairs: config.autoClosingPairs,
			autoClosedCharacters,
		};
		const range = direction === 'left'
			? WordOperations.deleteWordLeft(context, WordNavigationType.WordStart)
			: WordOperations.deleteWordRight(context, WordNavigationType.WordEnd);
		return range && !range.isEmpty() ? new ReplaceCommand(range, '') : null;
	});
}

export interface KeyboardNavigationControllerOptions {
	readonly operatingSystem?: OperatingSystem;
}

export interface KeyboardNavigationCommand {
	readonly command: EditorCursorNavigationCommand;
	readonly mode: EditorCursorNavigationMode;
}

/**
 * Routes browser keydown navigation into Stanza common selection commands.
 */
export class KeyboardNavigationController extends Disposable {
	private readonly targetOperatingSystem: OperatingSystem;
	private modelNavigationStates: readonly SingleCursorState[] | undefined;
	private preferredVisualHorizontalOffsets: readonly number[] | undefined;
	private applyingNavigation = false;

	constructor(
		private readonly viewport: View,
		private readonly viewModel: IViewModel,
		userInputEvents: ViewUserInputEvents,
		options: KeyboardNavigationControllerOptions = {},
	) {
		super();
		try {
			this.targetOperatingSystem = readOperatingSystem(
				options.operatingSystem,
			);
		} catch (error) {
			this.dispose();
			throw error;
		}
		if (viewport.textModel !== viewModel.model) {
			this.dispose();
			throw new TypeError(
				"Stanza keyboard and selection controllers must share one text model",
			);
		}
		const previousKeyDownHandler = userInputEvents.onKeyDown;
		const keyDownHandler = (event: IKeyboardEvent): void => {
			previousKeyDownHandler?.(event);
			if (!event.browserEvent.defaultPrevented) {
				this.handleKeyDown(event);
			}
		};
		userInputEvents.onKeyDown = keyDownHandler;
		this._register(toDisposable(() => {
			if (userInputEvents.onKeyDown === keyDownHandler) {
				userInputEvents.onKeyDown = previousKeyDownHandler;
			}
		}));
		const cursorListener = this._register(new class extends ViewEventHandler {
			constructor(private readonly reset: () => void) { super(); }
			override onCursorStateChanged(): boolean {
				this.reset();
				return false;
			}
		}(() => {
			if (this.applyingNavigation) return;
			this.modelNavigationStates = undefined;
			this.preferredVisualHorizontalOffsets = undefined;
		}));
		viewModel.addViewEventHandler(cursorListener);
		this._register(toDisposable(() => viewModel.removeViewEventHandler(cursorListener)));
	}

	private handleKeyDown(event: IKeyboardEvent): void {
		const navigation = resolveStanzaKeyboardNavigation(
			event,
			this.targetOperatingSystem,
		);
		if (!navigation) return;
		event.stop();
		const layout = this.viewport.viewportLayout;
		const pageLineCount = Math.max(
			1,
			Math.floor(layout.viewportSize.height / layout.lineHeight),
		);
		const visualCommand = isVisualVerticalCommand(navigation.command)
			? navigation.command
			: undefined;
		const visualResult = this.viewport.lineWrapping === EditorLineWrapping.On &&
			visualCommand !== undefined
			? navigateStanzaVisualCursors(
				this.viewport.textModel,
				this.viewport.getVisualLineProjection(),
				this.viewModel.getCursorStates().map(state => state.modelState.selection),
				{
					command: visualCommand,
					mode: navigation.mode,
					pageLineCount,
					preferredHorizontalOffsets: this.preferredVisualHorizontalOffsets,
				},
				text => this.viewport.measureTextWidth(text),
				{
					getHorizontalOffset: position => this.viewport.getVisualHorizontalOffset(position),
					getNearestPosition: (visualLineIndex, horizontalOffset) => this.viewport.getNearestPositionAtVisualHorizontalOffset(visualLineIndex, horizontalOffset),
				},
			)
			: undefined;
		const currentStates = this.viewModel.getCursorStates();
		const sourceStates = this.modelNavigationStates?.length === currentStates.length
			&& this.modelNavigationStates.every((state, index) => state.selection.equalsSelection(currentStates[index]!.modelState.selection))
			? currentStates.map((state, index) => new CursorState(this.modelNavigationStates![index]!, state.viewState))
			: currentStates;
		const movedStates = visualResult ? undefined : moveCursorStates(this.viewModel, sourceStates, navigation, pageLineCount);
		const modelStates = visualResult
			? visualResult.selections.map(selection => CursorState.fromModelSelection(selection))
			: movedStates!;
		this.applyingNavigation = true;
		try {
			this.viewModel.setCursorStates('keyboard', CursorChangeReason.Explicit, modelStates);
		} finally {
			this.applyingNavigation = false;
		}
		this.modelNavigationStates = movedStates?.every(state => state.modelState !== null)
			? movedStates.map(state => state.modelState!)
			: undefined;
		this.preferredVisualHorizontalOffsets = visualResult?.preferredHorizontalOffsets;
		this.viewport.revealPosition(this.viewModel.getCursorStates()[0]!.modelState.position);
	}
}

function moveCursorStates(viewModel: IViewModel, cursors: CursorState[], navigation: KeyboardNavigationCommand, pageLineCount: number) {
	const inSelectionMode = navigation.mode === EditorCursorNavigationMode.Extend;
	switch (navigation.command) {
		case EditorCursorNavigationCommand.CharacterLeft:
			return CursorMoveCommands.simpleMove(viewModel, cursors, CursorMove.Direction.Left, inSelectionMode, 1, CursorMove.Unit.Character)!;
		case EditorCursorNavigationCommand.CharacterRight:
			return CursorMoveCommands.simpleMove(viewModel, cursors, CursorMove.Direction.Right, inSelectionMode, 1, CursorMove.Unit.Character)!;
		case EditorCursorNavigationCommand.LineUp:
			return CursorMoveCommands.simpleMove(viewModel, cursors, CursorMove.Direction.Up, inSelectionMode, 1, CursorMove.Unit.Line)!;
		case EditorCursorNavigationCommand.LineDown:
			return CursorMoveCommands.simpleMove(viewModel, cursors, CursorMove.Direction.Down, inSelectionMode, 1, CursorMove.Unit.Line)!;
		case EditorCursorNavigationCommand.PageUp:
			return CursorMoveCommands.simpleMove(viewModel, cursors, CursorMove.Direction.Up, inSelectionMode, pageLineCount, CursorMove.Unit.Line)!;
		case EditorCursorNavigationCommand.PageDown:
			return CursorMoveCommands.simpleMove(viewModel, cursors, CursorMove.Direction.Down, inSelectionMode, pageLineCount, CursorMove.Unit.Line)!;
		case EditorCursorNavigationCommand.LineStart:
			return CursorMoveCommands.moveToBeginningOfLine(viewModel, cursors, inSelectionMode);
		case EditorCursorNavigationCommand.LineEnd:
			return CursorMoveCommands.moveToEndOfLine(viewModel, cursors, inSelectionMode, false);
		case EditorCursorNavigationCommand.DocumentStart:
			return CursorMoveCommands.moveToBeginningOfBuffer(viewModel, cursors, inSelectionMode);
		case EditorCursorNavigationCommand.DocumentEnd:
			return CursorMoveCommands.moveToEndOfBuffer(viewModel, cursors, inSelectionMode);
		case EditorCursorNavigationCommand.WordLeft:
			return cursors.map(cursor => CursorState.fromModelState(moveModelCursorByWord(viewModel, cursor.modelState, inSelectionMode, 'left', cursors.length > 1)));
		case EditorCursorNavigationCommand.WordRight:
			return cursors.map(cursor => CursorState.fromModelState(moveModelCursorByWord(viewModel, cursor.modelState, inSelectionMode, 'right', cursors.length > 1)));
	}
}

function moveModelCursorByWord(viewModel: IViewModel, cursor: SingleCursorState, inSelectionMode: boolean, direction: 'left' | 'right', hasMulticursor: boolean): SingleCursorState {
	if (cursor.hasSelection() && !inSelectionMode) {
		const edge = direction === 'left' ? cursor.selection.getStartPosition() : cursor.selection.getEndPosition();
		return cursor.move(false, edge.lineNumber, edge.column, 0);
	}
	const config = viewModel.cursorConfig;
	const classifier = getMapForWordSeparators(config.wordSeparators, config.wordSegmenterLocales);
	const target = direction === 'left'
		? WordOperations.moveWordLeft(classifier, viewModel.model, cursor.position, WordNavigationType.WordStartFast, hasMulticursor)
		: WordOperations.moveWordRight(classifier, viewModel.model, cursor.position, WordNavigationType.WordEnd);
	return cursor.move(inSelectionMode, target.lineNumber, target.column, 0);
}

function isVisualVerticalCommand(command: EditorCursorNavigationCommand): command is EditorCursorNavigationCommand.LineUp | EditorCursorNavigationCommand.LineDown | EditorCursorNavigationCommand.PageUp | EditorCursorNavigationCommand.PageDown {
	return command === EditorCursorNavigationCommand.LineUp ||
		command === EditorCursorNavigationCommand.LineDown ||
		command === EditorCursorNavigationCommand.PageUp ||
		command === EditorCursorNavigationCommand.PageDown;
}

export function resolveStanzaKeyboardNavigation(event: Pick<IKeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "altGraphKey" | "isComposing">, targetOperatingSystem: OperatingSystem): KeyboardNavigationCommand | undefined {
	if (event.isComposing || event.altGraphKey) return undefined;
	const mode = event.shiftKey
		? EditorCursorNavigationMode.Extend
		: EditorCursorNavigationMode.Move;
	const noCommandModifier =
		!event.ctrlKey && !event.altKey && !event.metaKey;
	if (noCommandModifier) {
		const command = unmodifiedCommand(event.key);
		return command ? { command, mode } : undefined;
	}

	if (targetOperatingSystem === OperatingSystem.Macintosh) {
		if (event.altKey && !event.ctrlKey && !event.metaKey) {
			if (event.key === "ArrowLeft") {
				return { command: EditorCursorNavigationCommand.WordLeft, mode };
			}
			if (event.key === "ArrowRight") {
				return { command: EditorCursorNavigationCommand.WordRight, mode };
			}
		}
		if (event.metaKey && !event.ctrlKey && !event.altKey) {
			const command = macCommandCommand(event.key);
			return command ? { command, mode } : undefined;
		}
		return undefined;
	}

	if (event.ctrlKey && !event.altKey && !event.metaKey) {
		const command = controlCommand(event.key);
		return command ? { command, mode } : undefined;
	}
	return undefined;
}

function unmodifiedCommand(key: string): EditorCursorNavigationCommand | undefined {
	switch (key) {
		case "ArrowLeft":
			return EditorCursorNavigationCommand.CharacterLeft;
		case "ArrowRight":
			return EditorCursorNavigationCommand.CharacterRight;
		case "ArrowUp":
			return EditorCursorNavigationCommand.LineUp;
		case "ArrowDown":
			return EditorCursorNavigationCommand.LineDown;
		case "Home":
			return EditorCursorNavigationCommand.LineStart;
		case "End":
			return EditorCursorNavigationCommand.LineEnd;
		case "PageUp":
			return EditorCursorNavigationCommand.PageUp;
		case "PageDown":
			return EditorCursorNavigationCommand.PageDown;
		default:
			return undefined;
	}
}

function controlCommand(key: string): EditorCursorNavigationCommand | undefined {
	switch (key) {
		case "ArrowLeft":
			return EditorCursorNavigationCommand.WordLeft;
		case "ArrowRight":
			return EditorCursorNavigationCommand.WordRight;
		case "Home":
			return EditorCursorNavigationCommand.DocumentStart;
		case "End":
			return EditorCursorNavigationCommand.DocumentEnd;
		default:
			return undefined;
	}
}

function macCommandCommand(key: string): EditorCursorNavigationCommand | undefined {
	switch (key) {
		case "ArrowLeft":
			return EditorCursorNavigationCommand.LineStart;
		case "ArrowRight":
			return EditorCursorNavigationCommand.LineEnd;
		case "ArrowUp":
		case "Home":
			return EditorCursorNavigationCommand.DocumentStart;
		case "ArrowDown":
		case "End":
			return EditorCursorNavigationCommand.DocumentEnd;
		default:
			return undefined;
	}
}

function readOperatingSystem(value: OperatingSystem | undefined): OperatingSystem {
	const resolved = value ?? operatingSystem;
	if (!Object.values(OperatingSystem).includes(resolved)) {
		throw new TypeError("Unknown Stanza keyboard operating system");
	}
	return resolved;
}
