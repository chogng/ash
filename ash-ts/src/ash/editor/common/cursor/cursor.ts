import { Emitter, type Event } from "../../../base/common/event.js";
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { CursorCollection } from './cursorCollection.js';
import { CursorContext } from './cursorContext.js';
import { Selection, SelectionDirection } from '../core/selection.js';
import { Position } from '../core/position.js';
import { Range } from '../core/range.js';
import { TrackedRangeStickiness, type ICursorStateComputer, type IIdentifiedSingleEditOperation, type ITextModel, type IValidEditOperation } from '../model.js';
import { type TrackedRange } from '../model/trackedRange.js';
import { normalizeTextLineEndings, TextModelChangeReason, type TextModelChange } from '../core/textChange.js';
import { TextModel } from "../model/textModel.js";
import { CursorChangeReason } from '../cursorEvents.js';
import { UndoRedoGroup } from '../../../platform/undoRedo/common/undoRedo.js';
import { ScrollType, type ICommand, type ICursorState, type IEditOperationBuilder } from '../editorCommon.js';
import { EditSources, type TextModelEditSource } from '../textModelEditSource.js';
import { CursorConfiguration, CursorState, EditOperationResult, EditOperationType, type IColumnSelectData, type ICursorSimpleModel, type PartialCursorState } from '../cursorCommon.js';
import { type ICoordinatesConverter } from '../coordinatesConverter.js';
import { CursorStateChangedEvent, ViewModelEventsCollector } from '../viewModelEventDispatcher.js';
import { VerticalRevealType, ViewCursorStateChangedEvent, ViewRevealRangeRequestEvent } from '../viewEvents.js';
import { DeleteOperations } from './cursorDeleteOperations.js';
import { BaseTypeWithAutoClosingCommand } from './cursorTypeEditOperations.js';
import { CompositionOutcome, TypeOperations } from './cursorTypeOperations.js';
import { RawContentChangedType, type InternalModelContentChangeEvent, type ModelInjectedTextChangedEvent } from '../textModelEvents.js';

export interface CursorSelectionChange {
	readonly selections: readonly Selection[];
	readonly reason: CursorChangeReason;
	readonly modelVersion: number;
}

interface CursorsControllerOptions {
	readonly selectionHistoryLimit?: number;
	readonly cursorHistoryLimit?: number;
}

class CursorControllerSettings {
	readonly selectionHistoryLimit: number;
	readonly cursorHistoryLimit: number;

	constructor(options: CursorsControllerOptions) {
		this.selectionHistoryLimit = readLimit(options.selectionHistoryLimit, 1_000, 'selectionHistoryLimit');
		this.cursorHistoryLimit = readLimit(options.cursorHistoryLimit, 100, 'cursorHistoryLimit');
	}
}

function readLimit(value: number | undefined, fallback: number, name: string): number {
	const limit = value ?? fallback;
	if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
	return limit;
}

interface TrackedCommandSelection {
	readonly rangeId: string;
	readonly direction: SelectionDirection;
}

interface CollectedCommand {
	readonly command: ICommand;
	readonly operations: IIdentifiedSingleEditOperation[];
}

/** Executes canonical editor commands as one model transaction. */
export class CommandExecutor {
	static executeCommands(
		model: ITextModel,
		selectionsBefore: Selection[],
		commands: readonly (ICommand | null)[],
		editReason: TextModelEditSource = EditSources.unknown({ name: 'executeCommands' }),
		historyGroup?: UndoRedoGroup,
	): Selection[] | null {
		const tracked = new Map<string, TrackedCommandSelection>();
		const fallbackSelections = selectionsBefore.map(selection => ({
			rangeId: model._setTrackedRange(null, selection, trackedSelectionStickiness(model, selection, undefined)),
			direction: selection.getDirection(),
		}));
		let trackedSequence = 0;
		try {
			const collected = commands.map((command, index) => command
				? collectCommand(model, command, index, tracked, () => `selection-${trackedSequence++}`)
				: null);
			const accepted = acceptNonOverlappingCommands(model, collected);
			const operations = accepted.flatMap(item => item?.operations ?? []);
			if (operations.length === 0) return null;

			return model.pushEditOperations(
				selectionsBefore,
				operations,
				inverse => computeCommandSelections(model, accepted, inverse, tracked, fallbackSelections),
				historyGroup,
				editReason,
			);
		} finally {
			for (const selection of fallbackSelections) {
				model._setTrackedRange(selection.rangeId, null, TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges);
			}
			for (const selection of tracked.values()) {
				model._setTrackedRange(selection.rangeId, null, TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges);
			}
		}
	}
}

function collectCommand(
	model: ITextModel,
	command: ICommand,
	commandIndex: number,
	tracked: Map<string, TrackedCommandSelection>,
	nextTrackedId: () => string,
): CollectedCommand {
	const operations: IIdentifiedSingleEditOperation[] = [];
	let operationIndex = 0;
	const add = (rangeValue: import('../core/range.js').IRange, text: string | null, forceMoveMarkers = false, isTracked = false): void => {
		const range = Range.lift(rangeValue);
		if (range.isEmpty() && (text === '' || text === null)) return;
		operations.push({
			identifier: { major: commandIndex, minor: operationIndex++ },
			range,
			text,
			forceMoveMarkers,
			isAutoWhitespaceEdit: command.insertsAutoWhitespace,
			_isTracked: isTracked,
		});
	};
	const builder: IEditOperationBuilder = {
		addEditOperation: (range, text, forceMoveMarkers) => add(range, text, forceMoveMarkers),
		addTrackedEditOperation: (range, text, forceMoveMarkers) => add(range, text, forceMoveMarkers, true),
		trackSelection: (selectionValue, trackPreviousOnEmpty) => {
			const selection = Selection.liftSelection(selectionValue);
			const stickiness = trackedSelectionStickiness(model, selection, trackPreviousOnEmpty);
			const rangeId = model._setTrackedRange(null, selection, stickiness);
			const id = nextTrackedId();
			tracked.set(id, { rangeId, direction: selection.getDirection() });
			return id;
		},
	};
	command.getEditOperations(model, builder);
	return { command, operations };
}

function trackedSelectionStickiness(
	model: ITextModel,
	selection: Selection,
	trackPreviousOnEmpty: boolean | undefined,
): TrackedRangeStickiness {
	if (!selection.isEmpty()) return TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges;
	if (trackPreviousOnEmpty !== undefined) {
		return trackPreviousOnEmpty
			? TrackedRangeStickiness.GrowsOnlyWhenTypingBefore
			: TrackedRangeStickiness.GrowsOnlyWhenTypingAfter;
	}
	return selection.startColumn === model.getLineMaxColumn(selection.startLineNumber)
		? TrackedRangeStickiness.GrowsOnlyWhenTypingBefore
		: TrackedRangeStickiness.GrowsOnlyWhenTypingAfter;
}

function acceptNonOverlappingCommands(
	model: ITextModel,
	commands: readonly (CollectedCommand | null)[],
): readonly (CollectedCommand | null)[] {
	const accepted: IIdentifiedSingleEditOperation[] = [];
	return commands.map(item => {
		if (!item) return null;
		if (item.operations.some(operation => accepted.some(existing => operationsConflict(model, operation, existing)))) return null;
		accepted.push(...item.operations);
		return item;
	});
}

function operationsConflict(model: ITextModel, left: IIdentifiedSingleEditOperation, right: IIdentifiedSingleEditOperation): boolean {
	const leftRange = Range.lift(left.range);
	const rightRange = Range.lift(right.range);
	const leftStart = model.getOffsetAt(leftRange.getStartPosition());
	const leftEnd = model.getOffsetAt(leftRange.getEndPosition());
	const rightStart = model.getOffsetAt(rightRange.getStartPosition());
	const rightEnd = model.getOffsetAt(rightRange.getEndPosition());
	if (leftStart === rightStart && (leftStart === leftEnd || rightStart === rightEnd)) return true;
	return leftStart < rightEnd && rightStart < leftEnd;
}

function computeCommandSelections(
	model: ITextModel,
	commands: readonly (CollectedCommand | null)[],
	inverse: readonly IValidEditOperation[],
	tracked: ReadonlyMap<string, TrackedCommandSelection>,
	fallbackSelections: readonly TrackedCommandSelection[],
): Selection[] {
	const inverseByCommand = new Map<number, IValidEditOperation[]>();
	for (const operation of inverse) {
		if (!operation.identifier) continue;
		const list = inverseByCommand.get(operation.identifier.major) ?? [];
		list.push(operation);
		inverseByCommand.set(operation.identifier.major, list);
	}

	return fallbackSelections.map((fallback, index) => {
		const item = commands[index];
		const commandInverse = inverseByCommand.get(index);
		if (!item || !commandInverse?.length) {
			const range = model._getTrackedRange(fallback.rangeId);
			if (!range) throw new ReferenceError('Command fallback selection was released early');
			return Selection.fromRange(range, fallback.direction);
		}
		commandInverse.sort((left, right) => (left.identifier?.minor ?? 0) - (right.identifier?.minor ?? 0));
		return item.command.computeCursorState(model, {
			getInverseEditOperations: () => commandInverse,
			getTrackedSelection: id => {
				const entry = tracked.get(id);
				if (!entry) throw new ReferenceError(`Unknown tracked selection '${id}'`);
				const range = model._getTrackedRange(entry.rangeId);
				if (!range) throw new ReferenceError(`Tracked selection '${id}' was released early`);
				return Selection.fromRange(range, entry.direction);
			},
		});
	});
}

interface SelectionHistoryEntry {
	readonly before: readonly Selection[];
	readonly after: readonly Selection[];
}

interface ActiveComposition {
	readonly historyGroup: UndoRedoGroup;
	readonly deletions: Array<CompositionDeletion | null>;
	outcomes: CompositionOutcome[] | null;
	valid: boolean;
}

interface CompositionDeletion {
	readonly text: string;
	readonly selectionStart: number;
	readonly selectionEnd: number;
}

function compositionReplacementRange(model: ITextModel, selection: Selection, replacePrevCharCnt: number, replaceNextCharCnt: number): Range {
	if (!selection.isEmpty()) {
		return selection;
	}
	const position = selection.getPosition();
	return new Range(
		position.lineNumber,
		Math.max(1, position.column - replacePrevCharCnt),
		position.lineNumber,
		Math.min(model.getLineMaxColumn(position.lineNumber), position.column + replaceNextCharCnt),
	);
}

function compositionOutcomes(model: ITextModel, selections: readonly Selection[], deletions: readonly (CompositionDeletion | null)[], text: string, positionDelta: number): CompositionOutcome[] | null {
	if (selections.length !== deletions.length) {
		return null;
	}
	const insertedText = normalizeTextLineEndings(text);
	const insertedSelectionOffset = insertedText.length + positionDelta;
	if (insertedSelectionOffset < 0 || insertedSelectionOffset > insertedText.length) {
		return null;
	}
	const outcomes: CompositionOutcome[] = [];
	for (let index = 0; index < selections.length; index += 1) {
		const selection = selections[index]!;
		const deletion = deletions[index];
		if (!deletion || !selection.isEmpty()) {
			return null;
		}
		let insertedEnd: Position;
		let insertedStart: Position;
		try {
			insertedEnd = model.modifyPosition(selection.getPosition(), -positionDelta);
			insertedStart = model.modifyPosition(insertedEnd, -insertedText.length);
		} catch {
			return null;
		}
		const insertedTextRange = Range.fromPositions(insertedStart, insertedEnd);
		if (model.getValueInRange(insertedTextRange) !== insertedText) {
			return null;
		}
		outcomes.push(new CompositionOutcome(
			deletion.text,
			deletion.selectionStart,
			deletion.selectionEnd,
			insertedText,
			insertedSelectionOffset,
			insertedSelectionOffset,
			insertedTextRange,
		));
	}
	return outcomes;
}

interface AutoClosedAction {
	readonly open: string;
	readonly close: string;
	readonly enclosing: TrackedRange;
	readonly closer: TrackedRange;
}

/**
 * Per-editor selection state for one shared `TextModel`.
 *
 * Text remains document-owned. This controller owns only one editor instance's
 * tracked selections and command-level selection history.
 */
export class CursorsController extends Disposable {
	public context: CursorContext;
	private readonly settings: CursorControllerSettings;
	private readonly changeEmitter =
		this._register(new Emitter<CursorSelectionChange>());
	private readonly readOnlyEditEmitter = this._register(new Emitter<void>());
	private cursors: CursorCollection;
	private readonly viewModel: ICursorSimpleModel;
	private readonly coordinatesConverter: ICoordinatesConverter;
	private readonly selectionHistory =
		new Map<number, SelectionHistoryEntry>();
	private readonly selectionHistoryOrder: number[] = [];
	private readonly cursorHistory: Array<readonly Selection[]> = [];
	private readonly cursorRedoHistory: Array<readonly Selection[]> = [];
	private autoClosedActions: AutoClosedAction[] = [];
	private currentSelections: readonly Selection[];
	private activeComposition: ActiveComposition | undefined;
	private executingCommand = false;
	private previousEditOperationType = EditOperationType.Other;
	private hasFocus = false;
	private columnSelectData: IColumnSelectData | null = null;
	private knownModelVersion: number;

	readonly onDidChange: Event<CursorSelectionChange> =
		this.changeEmitter.event;
	readonly onDidAttemptReadOnlyEdit: Event<void> = this.readOnlyEditEmitter.event;

	constructor(
		private readonly model: TextModel,
		viewModel: ICursorSimpleModel,
		coordinatesConverter: ICoordinatesConverter,
		cursorConfig: CursorConfiguration,
		options: CursorsControllerOptions = {},
	) {
		super();
		this.viewModel = viewModel;
		this.coordinatesConverter = coordinatesConverter;
		this.context = new CursorContext(model, viewModel, coordinatesConverter, cursorConfig);
		this.settings = new CursorControllerSettings(options);
		this.cursors = new CursorCollection(this.context);
		this.currentSelections = this.cursors.getSelections();
		this.knownModelVersion = model.version;
		try {
			this._register(toDisposable(() => this.cursors.dispose()));
			this._register(model.onDidChangeContent(change => this.acceptModelChange(change)));
			this._register(toDisposable(() => {
				this.selectionHistory.clear();
				this.selectionHistoryOrder.length = 0;
				this.cursorHistory.length = 0;
				this.cursorRedoHistory.length = 0;
				for (const action of this.autoClosedActions) this.disposeAutoClosedAction(action);
				this.autoClosedActions = [];
				this.invalidateActiveComposition();
			}));
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	public updateConfiguration(cursorConfig: CursorConfiguration): void {
		this.assertNotDisposed();
		this.context = new CursorContext(this.model, this.viewModel, this.coordinatesConverter, cursorConfig);
		this.cursors.updateContext(this.context);
	}

	public setHasFocus(hasFocus: boolean): void {
		this.assertNotDisposed();
		this.hasFocus = hasFocus;
	}

	public onLineMappingChanged(eventsCollector: ViewModelEventsCollector): void {
		this.assertNotDisposed();
		if (this.knownModelVersion !== this.model.version) return;
		this.setStates(eventsCollector, 'viewModel', CursorChangeReason.NotSet, this.getCursorStates());
	}

	public getPrimaryCursorState(): CursorState {
		this.assertNotDisposed();
		return this.cursors.getPrimaryCursor();
	}

	public getLastAddedCursorIndex(): number {
		this.assertNotDisposed();
		return this.cursors.getLastAddedCursorIndex();
	}

	public getCursorStates(): CursorState[] {
		this.assertNotDisposed();
		return this.cursors.getAll();
	}

	public setStates(eventsCollector: ViewModelEventsCollector, source: string | null | undefined, reason: CursorChangeReason, states: PartialCursorState[] | null): boolean {
		this.assertNotDisposed();
		if (states === null) return false;

		let reachedMaxCursorCount = false;
		if (states.length > this.context.cursorConfig.multiCursorLimit) {
			states = states.slice(0, this.context.cursorConfig.multiCursorLimit);
			reachedMaxCursorCount = true;
		}
		if (states.length === 0) throw new RangeError('Cursor states must not be empty');

		const oldStates = this.cursors.getAll();
		const oldSelections = this.cursors.getSelections();
		const modelVersion = this.model.version;
		this.cursors.setStates(states);
		this.cursors.normalize();
		this.currentSelections = this.cursors.getSelections();
		this.columnSelectData = null;
		this.pruneAutoClosedActions();

		const newStates = this.cursors.getAll();
		if (cursorStatesEqual(oldStates, newStates)) return false;

		const selections = this.cursors.getSelections();
		eventsCollector.emitViewEvent(new ViewCursorStateChangedEvent(this.cursors.getViewSelections(), selections, reason));
		if (!selectionsEqual(oldSelections, selections)) {
			eventsCollector.emitOutgoingEvent(new CursorStateChangedEvent(
				oldSelections,
				selections,
				modelVersion,
				this.model.version,
				source || 'keyboard',
				reason,
				reachedMaxCursorCount,
			));
			this.changeEmitter.fire(Object.freeze({
				selections,
				reason,
				modelVersion: this.model.version,
			}));
		}
		return true;
	}

	public getSelection(): Selection {
		this.assertNotDisposed();
		return this.cursors.getPrimaryCursor().modelState.selection;
	}

	public getCursorColumnSelectData(): IColumnSelectData {
		this.assertNotDisposed();
		if (this.columnSelectData) return { ...this.columnSelectData };
		const primary = this.cursors.getPrimaryCursor();
		const selectionStart = primary.viewState.selectionStart.getStartPosition();
		const position = primary.viewState.position;
		return {
			isReal: false,
			fromViewLineNumber: selectionStart.lineNumber,
			fromViewVisualColumn: this.context.cursorConfig.visibleColumnFromColumn(this.viewModel, selectionStart),
			toViewLineNumber: position.lineNumber,
			toViewVisualColumn: this.context.cursorConfig.visibleColumnFromColumn(this.viewModel, position),
		};
	}

	public setCursorColumnSelectData(columnSelectData: IColumnSelectData): void {
		this.assertNotDisposed();
		this.columnSelectData = { ...columnSelectData };
	}

	public getTopMostViewPosition(): Position {
		this.assertNotDisposed();
		return this.cursors.getTopMostViewPosition();
	}

	public getBottomMostViewPosition(): Position {
		this.assertNotDisposed();
		return this.cursors.getBottomMostViewPosition();
	}

	public getSelections(): Selection[] {
		this.assertNotDisposed();
		return this.cursors.getSelections();
	}

	public getPosition(): Position {
		this.assertNotDisposed();
		return this.cursors.getPrimaryCursor().modelState.position;
	}

	public revealAll(eventsCollector: ViewModelEventsCollector, source: string | null | undefined, minimalReveal: boolean, verticalType: VerticalRevealType, revealHorizontal: boolean, scrollType: ScrollType): void {
		this.assertNotDisposed();
		const viewPositions = this.cursors.getViewPositions();
		const range = viewPositions.length === 1 ? Range.fromPositions(viewPositions[0]!) : null;
		const selections = viewPositions.length > 1 ? this.cursors.getViewSelections() : null;
		eventsCollector.emitViewEvent(new ViewRevealRangeRequestEvent(source, minimalReveal, range, selections, verticalType, revealHorizontal, scrollType));
	}

	public revealPrimary(eventsCollector: ViewModelEventsCollector, source: string | null | undefined, minimalReveal: boolean, verticalType: VerticalRevealType, revealHorizontal: boolean, scrollType: ScrollType): void {
		this.assertNotDisposed();
		eventsCollector.emitViewEvent(new ViewRevealRangeRequestEvent(
			source,
			minimalReveal,
			null,
			[this.cursors.getPrimaryCursor().viewState.selection],
			verticalType,
			revealHorizontal,
			scrollType,
		));
	}

	public saveState(): ICursorState[] {
		this.assertNotDisposed();
		return this.cursors.getSelections().map(selection => ({
			inSelectionMode: !selection.isEmpty(),
			selectionStart: selection.getSelectionStart(),
			position: selection.getPosition(),
		}));
	}

	public restoreState(eventsCollector: ViewModelEventsCollector, states: ICursorState[]): void {
		this.assertNotDisposed();
		const selections = states.map(state => {
			const position = new Position(state.position?.lineNumber || 1, state.position?.column || 1);
			const selectionStart = new Position(
				state.selectionStart?.lineNumber || position.lineNumber,
				state.selectionStart?.column || position.column,
			);
			return Selection.fromPositions(selectionStart, position);
		});
		this.setStates(eventsCollector, 'restoreState', CursorChangeReason.NotSet, CursorState.fromModelSelections(selections));
		this.revealAll(eventsCollector, 'restoreState', false, VerticalRevealType.Simple, true, ScrollType.Immediate);
	}

	public executeEdits(eventsCollector: ViewModelEventsCollector, source: string | null | undefined, edits: IIdentifiedSingleEditOperation[], cursorStateComputer: ICursorStateComputer, reason: TextModelEditSource): void {
		this.assertNotDisposed();
		if (edits.length === 0) return;
		const before = this.getSelections();
		this.executingCommand = true;
		try {
			const after = this.model.pushEditOperations(before, edits, cursorStateComputer, undefined, reason);
			if (after) this.setStates(eventsCollector, source, CursorChangeReason.NotSet, CursorState.fromModelSelections(after));
		} finally {
			this.executingCommand = false;
		}
	}

	public startComposition(_eventsCollector: ViewModelEventsCollector): void {
		this.assertNotDisposed();
		this.assertNoActiveComposition('begin another composition');
		this.activeComposition = this.createActiveComposition(this.getSelections());
		this.model.beginHistoryRevision(this.activeComposition.historyGroup);
	}

	private createActiveComposition(selections: readonly Selection[]): ActiveComposition {
		const deletions = selections.map(selection => {
			if (selection.isEmpty()) {
				return null;
			}
			const text = this.model.getValueInRange(selection);
			return { text, selectionStart: 0, selectionEnd: text.length };
		});
		return {
			historyGroup: new UndoRedoGroup(),
			deletions,
			outcomes: null,
			valid: true,
		};
	}

	public endComposition(eventsCollector: ViewModelEventsCollector, source?: string | null): void {
		this.assertNotDisposed();
		const active = this.activeComposition;
		if (!active) return;
		active.valid = false;
		try {
			if (source === 'keyboard') {
				this.executeEditOperation(eventsCollector, TypeOperations.compositionEndWithInterceptors(this.previousEditOperationType, this.context.cursorConfig, this.model, active.outcomes, this.getSelections(), [...this.getAutoClosedCharacters()]), EditSources.cursor({ kind: 'compositionEnd', detailedSource: source }), source);
			}
		} finally {
			if (this.activeComposition === active) {
				this.activeComposition = undefined;
			}
			this.model.finishHistoryRevision(active.historyGroup);
		}
	}

	public type(eventsCollector: ViewModelEventsCollector, text: string, source?: string | null): void {
		this.assertNotDisposed();
		if (source === 'keyboard' && this.canOvertypeAutoClosedText(text)) {
			const selections = this.getSelections().map(selection => Selection.fromPositions(this.model.modifyPosition(selection.getPosition(), text.length)));
			this.setStates(eventsCollector, source, CursorChangeReason.NotSet, CursorState.fromModelSelections(selections));
			this.previousEditOperationType = EditOperationType.TypingOther;
			return;
		}
		const configuration = this.context.cursorConfig.languageConfigurationService.getLanguageConfiguration(this.model.getLanguageIdAtPosition(this.getPosition().lineNumber, this.getPosition().column));
		const typedUnits = source === 'keyboard' && !configuration.characterPair.getAutoClosingPairs().some(pair => pair.open === text)
			? this.typingUnits(text)
			: [text];
		for (const character of typedUnits) {
			const operation = source === 'keyboard'
				? TypeOperations.typeWithInterceptors(Boolean(this.activeComposition), this.previousEditOperationType, this.context.cursorConfig, this.model, this.getSelections(), [...this.getAutoClosedCharacters()], character)
				: TypeOperations.typeWithoutInterceptors(this.previousEditOperationType, this.context.cursorConfig, this.model, this.getSelections(), character);
			this.executeEditOperation(eventsCollector, operation, EditSources.cursor({ kind: 'type', detailedSource: source }), source);
		}
	}

	private *typingUnits(text: string): IterableIterator<string> {
		if (this.context.cursorConfig.inputMode === 'overtype') {
			yield* text;
			return;
		}
		let offset = 0;
		while (offset < text.length) {
			// Spaces retain undo boundaries; language-sensitive characters must
			// observe all edits preceding them, including changes of language.
			const boundaries = new Set([' ', '\n', '\r']);
			for (const selection of this.getSelections()) {
				const position = selection.getPosition();
				const languageId = this.model.getLanguageIdAtPosition(position.lineNumber, position.column);
				const language = this.context.cursorConfig.languageConfigurationService.getLanguageConfiguration(languageId);
				for (const pair of [...language.characterPair.getAutoClosingPairs(), ...language.getSurroundingPairs()]) {
					for (const character of pair.open + pair.close) {
						boundaries.add(character);
					}
				}
				for (const character of language.electricCharacter?.getElectricCharacters() ?? []) {
					boundaries.add(character);
				}
			}
			const start = offset;
			const first = String.fromCodePoint(text.codePointAt(offset)!);
			offset += first.length;
			if (!boundaries.has(first)) {
				while (offset < text.length) {
					const character = String.fromCodePoint(text.codePointAt(offset)!);
					if (boundaries.has(character)) {
						break;
					}
					offset += character.length;
				}
			}
			yield text.slice(start, offset);
		}
	}

	private canOvertypeAutoClosedText(text: string): boolean {
		if (!text || text.includes('\n')) return false;
		const owned = this.getAutoClosedCharacters();
		return this.getSelections().every(selection => selection.isEmpty() && owned.some(range => (
			Position.equals(range.getStartPosition(), selection.getPosition())
			&& this.model.getValueInRange(range) === text
		)));
	}

	public compositionType(eventsCollector: ViewModelEventsCollector, text: string, replacePrevCharCnt: number, replaceNextCharCnt: number, positionDelta: number, source?: string | null): void {
		this.assertNotDisposed();
		if (text.length === 0 && replacePrevCharCnt === 0 && replaceNextCharCnt === 0) {
			if (positionDelta !== 0) {
				const selections = this.getSelections().map(selection => {
					const position = selection.getPosition().delta(0, positionDelta);
					return Selection.fromPositions(position);
				});
				this.setStates(eventsCollector, source, CursorChangeReason.NotSet, CursorState.fromModelSelections(selections));
			}
			return;
		}
		const active = this.activeComposition;
		const selections = this.getSelections();
		if (active) {
			for (let index = 0; index < selections.length; index += 1) {
				if (active.deletions[index]) {
					continue;
				}
				const selection = selections[index]!;
				const range = compositionReplacementRange(this.model, selection, replacePrevCharCnt, replaceNextCharCnt);
				active.deletions[index] = {
					text: this.model.getValueInRange(range),
					selectionStart: replacePrevCharCnt,
					selectionEnd: replacePrevCharCnt,
				};
			}
		}
		this.executeEditOperation(eventsCollector, TypeOperations.compositionType(this.previousEditOperationType, this.context.cursorConfig, this.model, this.getSelections(), text, replacePrevCharCnt, replaceNextCharCnt, positionDelta), EditSources.cursor({ kind: 'compositionType', detailedSource: source }), source);
		if (active && this.activeComposition === active) {
			active.outcomes = compositionOutcomes(this.model, this.getSelections(), active.deletions, text, positionDelta);
		}
	}

	public paste(eventsCollector: ViewModelEventsCollector, text: string, pasteOnNewLine: boolean, multicursorText?: string[] | null, source?: string | null): void {
		this.assertNotDisposed();
		this.executeEditOperation(eventsCollector, TypeOperations.paste(this.context.cursorConfig, this.model, this.getSelections(), text, pasteOnNewLine, multicursorText ?? []), EditSources.cursor({ kind: 'paste', detailedSource: source }), source, CursorChangeReason.Paste);
	}

	public cut(eventsCollector: ViewModelEventsCollector, source?: string | null): void {
		this.assertNotDisposed();
		this.executeEditOperation(eventsCollector, DeleteOperations.cut(this.context.cursorConfig, this.model, this.getSelections()), EditSources.cursor({ kind: 'cut', detailedSource: source }), source);
	}

	public onModelContentChanged(eventsCollector: ViewModelEventsCollector, event: InternalModelContentChangeEvent | ModelInjectedTextChangedEvent): void {
		this.assertNotDisposed();
		if (!('rawContentChangedEvent' in event)) {
			if (this.executingCommand) return;
			this.executingCommand = true;
			try {
				this.setStates(eventsCollector, 'modelChange', CursorChangeReason.NotSet, this.getCursorStates());
			} finally {
				this.executingCommand = false;
			}
			return;
		}
		const rawEvent = event.rawContentChangedEvent;
		this.knownModelVersion = rawEvent.versionId;
		if (this.executingCommand) return;
		this.previousEditOperationType = EditOperationType.Other;
		this.cursorHistory.length = 0;
		this.cursorRedoHistory.length = 0;
		this.invalidateActiveComposition();
		if (rawEvent.containsEvent(RawContentChangedType.Flush)) {
			const oldSelections = this.cursors.getSelections();
			this.cursors.dispose();
			this.cursors = new CursorCollection(this.context);
			this.currentSelections = this.cursors.getSelections();
			this.columnSelectData = null;
			this.pruneAutoClosedActions();
			const selections = [...this.currentSelections];
			eventsCollector.emitViewEvent(new ViewCursorStateChangedEvent(this.cursors.getViewSelections(), selections, CursorChangeReason.ContentFlush));
			eventsCollector.emitOutgoingEvent(new CursorStateChangedEvent(
				oldSelections,
				selections,
				rawEvent.versionId,
				rawEvent.versionId,
				'model',
				CursorChangeReason.ContentFlush,
				false,
			));
			this.changeEmitter.fire(Object.freeze({
				selections,
				reason: CursorChangeReason.ContentFlush,
				modelVersion: rawEvent.versionId,
			}));
			return;
		}
		const reason = rawEvent.isUndoing
				? CursorChangeReason.Undo
				: rawEvent.isRedoing
					? CursorChangeReason.Redo
					: CursorChangeReason.RecoverFromMarkers;
		const selections = this.hasFocus && rawEvent.resultingSelection?.length
			? rawEvent.resultingSelection
			: this.cursors.readSelectionFromMarkers();
		if (this.setStates(eventsCollector, 'modelChange', reason, CursorState.fromModelSelections(selections)) && this.hasFocus && rawEvent.resultingSelection?.length) {
			this.revealAll(eventsCollector, 'modelChange', false, VerticalRevealType.Simple, true, ScrollType.Smooth);
		}
	}

	getPrevEditOperationType(): EditOperationType {
		this.assertNotDisposed();
		return this.previousEditOperationType;
	}

	setPrevEditOperationType(type: EditOperationType): void {
		this.assertNotDisposed();
		this.previousEditOperationType = type;
	}

	/** Returns closing ranges that are still owned by this cursor controller. */
	getAutoClosedCharacters(): readonly Range[] {
		this.assertNotDisposed();
		this.pruneAutoClosedActions();
		return Object.freeze(this.autoClosedActions.map(action => action.closer.range));
	}

	/** Records the paired ranges produced by one committed type operation. */
	private recordAutoClosedCharacters(closers: readonly Range[], enclosing: readonly Range[], committedModelVersion: number): void {
		this.assertNotDisposed();
		if (!Array.isArray(closers) || !Array.isArray(enclosing) || closers.length !== enclosing.length) {
			throw new RangeError('Auto-closed character and enclosing ranges must have the same length');
		}
		if (!Number.isSafeInteger(committedModelVersion) || committedModelVersion < 1) {
			throw new RangeError('Committed model version must be a positive safe integer');
		}
		if (committedModelVersion !== this.model.version) return;
		const additions: AutoClosedAction[] = [];
		try {
			for (let index = 0; index < closers.length; index += 1) {
				additions.push(this.createAutoClosedAction(closers[index]!, enclosing[index]!));
			}
		} catch (error) {
			for (const action of additions) this.disposeAutoClosedAction(action);
			throw error;
		}
		this.autoClosedActions.push(...additions);
		this.pruneAutoClosedActions();
	}

	get readOnly(): boolean {
		this.assertNotDisposed();
		return this.context.cursorConfig.readOnly;
	}

	setSelections(selections: readonly Selection[], reason = CursorChangeReason.NotSet): void {
		this.assertNotDisposed();
		this.assertNoActiveComposition("set selections");
		this.previousEditOperationType = EditOperationType.Other;
		this.cursorHistory.length = 0;
		this.cursorRedoHistory.length = 0;
		this.installSelections(selections, reason);
	}

	/** Records one cursor-only selection transition that `undoCursorOperation` may restore. */
	setCursorSelections(selections: readonly Selection[]): void {
		this.assertNotDisposed();
		this.assertNoActiveComposition("set cursor selections");
		this.previousEditOperationType = EditOperationType.Other;
		if (selectionsEqual(this.currentSelections, selections)) return;
		this.rememberCursorSelections(this.currentSelections);
		this.cursorRedoHistory.length = 0;
		this.installSelections(selections, CursorChangeReason.Explicit);
	}

	/** Restores the preceding cursor-only selection state without changing document undo history. */
	undoCursorOperation(): boolean {
		this.assertNotDisposed();
		this.assertNoActiveComposition("undo cursor operation");
		const previous = this.cursorHistory.pop();
		if (!previous) return false;
		this.rememberCursorRedoSelections(this.currentSelections);
		this.installSelections(previous, CursorChangeReason.Explicit);
		return true;
	}

	/** Reapplies the latest selection state consumed by `undoCursorOperation`. */
	redoCursorOperation(): boolean {
		this.assertNotDisposed();
		this.assertNoActiveComposition('redo cursor operation');
		const next = this.cursorRedoHistory.pop();
		if (!next) return false;
		this.rememberCursorSelections(this.currentSelections);
		this.installSelections(next, CursorChangeReason.Explicit);
		return true;
	}

	/** Ends command coalescing without creating an empty history entry. */
	pushUndoStop(): void {
		this.assertNotDisposed();
		this.assertNoActiveComposition("push an undo stop");
		this.model.pushStackElement();
	}

	public executeCommand(eventsCollector: ViewModelEventsCollector, command: ICommand, source?: string | null): void;
	public executeCommand(command: ICommand, source?: string | null): void;
	public executeCommand(eventsCollectorOrCommand: ViewModelEventsCollector | ICommand, commandOrSource?: ICommand | string | null, source?: string | null): void {
		this.assertNotDisposed();
		this.assertNoActiveComposition('execute a command');
		const eventsCollector = eventsCollectorOrCommand instanceof ViewModelEventsCollector ? eventsCollectorOrCommand : new ViewModelEventsCollector();
		const command = eventsCollectorOrCommand instanceof ViewModelEventsCollector ? commandOrSource as ICommand : eventsCollectorOrCommand;
		const detailedSource = eventsCollectorOrCommand instanceof ViewModelEventsCollector ? source : commandOrSource as string | null | undefined;
		this.cursors.killSecondaryCursors();
		this.executeEditOperation(eventsCollector, new EditOperationResult(EditOperationType.Other, [command], {
			shouldPushStackElementBefore: false,
			shouldPushStackElementAfter: false,
		}), EditSources.cursor({ kind: 'executeCommand', detailedSource }), detailedSource);
	}

	public executeCommands(eventsCollector: ViewModelEventsCollector, commands: (ICommand | null)[], source?: string | null): void;
	public executeCommands(commands: readonly (ICommand | null)[], source?: string | null): void;
	public executeCommands(eventsCollectorOrCommands: ViewModelEventsCollector | readonly (ICommand | null)[], commandsOrSource?: (ICommand | null)[] | string | null, source?: string | null): void {
		this.assertNotDisposed();
		this.assertNoActiveComposition('execute commands');
		const eventsCollector = eventsCollectorOrCommands instanceof ViewModelEventsCollector ? eventsCollectorOrCommands : new ViewModelEventsCollector();
		const commands = eventsCollectorOrCommands instanceof ViewModelEventsCollector ? commandsOrSource as (ICommand | null)[] : eventsCollectorOrCommands;
		const detailedSource = eventsCollectorOrCommands instanceof ViewModelEventsCollector ? source : commandsOrSource as string | null | undefined;
		if (commands.length === 0) return;
		this.executeEditOperation(eventsCollector, new EditOperationResult(EditOperationType.Other, [...commands], {
			shouldPushStackElementBefore: false,
			shouldPushStackElementAfter: false,
		}), EditSources.cursor({ kind: 'executeCommands', detailedSource }), detailedSource);
	}

	private executeEditOperation(eventsCollector: ViewModelEventsCollector, operation: EditOperationResult | null, reason: TextModelEditSource, source: string | null | undefined, cursorChangeReason = CursorChangeReason.NotSet): void {
		if (!operation) return;
		if (this.context.cursorConfig.readOnly) {
			this.readOnlyEditEmitter.fire();
			return;
		}
		this.cursorHistory.length = 0;
		this.cursorRedoHistory.length = 0;
		const compositionOwnsHistory = this.activeComposition !== undefined;
		if (operation.shouldPushStackElementBefore && !compositionOwnsHistory) {
			this.model.pushStackElement();
		}
		const before = this.getSelections();
		let change: TextModelChange | undefined;
		const capture = this.model.onDidChangeContent(event => { change = event; });
		this.executingCommand = true;
		try {
			const after = CommandExecutor.executeCommands(this.model, before, operation.commands, reason, this.activeComposition?.historyGroup);
			if (after) {
				this.setStates(eventsCollector, source, cursorChangeReason, CursorState.fromModelSelections(after));
				const closers: Range[] = [];
				const enclosing: Range[] = [];
				for (const command of operation.commands) {
					if (command instanceof BaseTypeWithAutoClosingCommand && command.closeCharacterRange && command.enclosingRange) {
						closers.push(command.closeCharacterRange);
						enclosing.push(command.enclosingRange);
					}
				}
				if (closers.length > 0) this.recordAutoClosedCharacters(closers, enclosing, this.model.version);
				this.previousEditOperationType = operation.type;
				if (change) this.rememberSelectionHistory(change.transactionId, { before, after: this.getSelections() });
			}
		} finally {
			this.executingCommand = false;
			capture.dispose();
		}
		if (operation.shouldPushStackElementAfter && !compositionOwnsHistory) {
			this.model.pushStackElement();
		}
	}

	private acceptModelChange(change: TextModelChange): void {
		this.knownModelVersion = change.version;
		if (this.executingCommand) {
			this.refreshTrackedSelections(CursorChangeReason.RecoverFromMarkers, false);
			return;
		}
		this.cursorHistory.length = 0;
		this.cursorRedoHistory.length = 0;
		this.invalidateActiveComposition();
		if (change.reason === TextModelChangeReason.Reset) {
			this.selectionHistory.clear();
			this.selectionHistoryOrder.length = 0;
		}
		const history = this.selectionHistory.get(change.transactionId);
		if (history && change.reason === TextModelChangeReason.Undo) {
			this.installSelections(
				history.before,
				CursorChangeReason.Undo,
			);
			return;
		}
		if (history && change.reason === TextModelChangeReason.Redo) {
			this.installSelections(
				history.after,
				CursorChangeReason.Redo,
			);
			return;
		}
		if (
			this.hasFocus
			&& change.resultingSelection?.length
			&& (change.reason === TextModelChangeReason.Undo || change.reason === TextModelChangeReason.Redo)
		) {
			this.installSelections(
				change.resultingSelection,
				change.reason === TextModelChangeReason.Undo ? CursorChangeReason.Undo : CursorChangeReason.Redo,
			);
			return;
		}
		if (
			history &&
			change.reason === TextModelChangeReason.HistoryCancellation
		) {
			this.installSelections(
				history.before,
				CursorChangeReason.Undo,
			);
			this.forgetSelectionHistory(change.transactionId);
			return;
		}
		this.refreshTrackedSelections(
			change.reason === TextModelChangeReason.Reset
				? CursorChangeReason.ContentFlush
				: CursorChangeReason.RecoverFromMarkers,
		);
	}

	private installSelections(
		selections: readonly Selection[],
		reason?: CursorChangeReason,
		normalize = false,
	): void {
		validateSelections(this.model, selections);
		const previous = this.currentSelections;
		this.cursors.setSelections([...selections]);
		if (normalize) this.cursors.normalize();
		this.currentSelections = this.cursors.getSelections();
		this.pruneAutoClosedActions();
		if (reason !== undefined && !selectionsEqual(previous, this.currentSelections)) {
			this.changeEmitter.fire(Object.freeze({
				selections: this.currentSelections,
				reason,
				modelVersion: this.model.version,
			}));
		}
	}

	private refreshTrackedSelections(
		reason: CursorChangeReason,
		notify = true,
		forceNotify = false,
	): void {
		const selections = this.cursors.readSelectionFromMarkers();
		const previous = this.currentSelections;
		this.cursors.setSelections(selections);
		this.currentSelections = selections;
		this.pruneAutoClosedActions();
		if (notify && (forceNotify || !selectionsEqual(previous, selections))) {
			this.changeEmitter.fire(Object.freeze({
				selections,
				reason,
				modelVersion: this.model.version,
			}));
		}
	}

	private rememberSelectionHistory(
		transactionId: number,
		entry: SelectionHistoryEntry,
	): void {
		const previous = this.selectionHistory.get(transactionId);
		if (previous) {
			this.selectionHistory.set(transactionId, {
				before: previous.before,
				after: entry.after,
			});
			return;
		}
		this.selectionHistory.set(transactionId, entry);
		this.selectionHistoryOrder.push(transactionId);
		while (
			this.selectionHistoryOrder.length >
			this.settings.selectionHistoryLimit
		) {
			const oldest = this.selectionHistoryOrder.shift();
			if (oldest !== undefined) this.selectionHistory.delete(oldest);
		}
	}

	private rememberCursorSelections(selections: readonly Selection[]): void {
		if (this.settings.cursorHistoryLimit === 0) return;
		this.cursorHistory.push(selections);
		while (this.cursorHistory.length > this.settings.cursorHistoryLimit) this.cursorHistory.shift();
	}

	private rememberCursorRedoSelections(selections: readonly Selection[]): void {
		if (this.settings.cursorHistoryLimit === 0) return;
		this.cursorRedoHistory.push(selections);
		while (this.cursorRedoHistory.length > this.settings.cursorHistoryLimit) this.cursorRedoHistory.shift();
	}

	private forgetSelectionHistory(transactionId: number): void {
		this.selectionHistory.delete(transactionId);
		const index = this.selectionHistoryOrder.indexOf(transactionId);
		if (index >= 0) this.selectionHistoryOrder.splice(index, 1);
	}

	private assertNoActiveComposition(operation: string): void {
		if (this.activeComposition?.valid) {
			throw new Error(`Cannot ${operation} during an active composition`);
		}
	}

	private invalidateActiveComposition(): void {
		const active = this.activeComposition;
		if (!active) return;
		active.valid = false;
		this.activeComposition = undefined;
		this.model.finishHistoryRevision(active.historyGroup);
	}

	private createAutoClosedAction(closerRange: Range, enclosingRange: Range): AutoClosedAction {
		const enclosingStart = this.model.offsetAt(enclosingRange.getStartPosition());
		const enclosingEnd = this.model.offsetAt(enclosingRange.getEndPosition());
		const closeStart = this.model.offsetAt(closerRange.getStartPosition());
		const closeEnd = this.model.offsetAt(closerRange.getEndPosition());
		if (enclosingStart >= closeStart || closeEnd !== enclosingEnd) {
			throw new RangeError('Auto-closed ranges must describe an opener followed by its closer');
		}
		const open = this.model.getTextInRange(Range.fromPositions(enclosingRange.getStartPosition(), closerRange.getStartPosition()));
		const close = this.model.getTextInRange(closerRange);
		if (open.length === 0 || close.length === 0) throw new RangeError('Auto-closed ranges must contain text');
		const enclosing = this.model.trackRange(enclosingRange, TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges);
		try {
			const closer = this.model.trackRange(closerRange, TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges);
			return { open, close, enclosing, closer };
		} catch (error) {
			enclosing.dispose();
			throw error;
		}
	}

	private pruneAutoClosedActions(): void {
		if (this.isDisposed || this.autoClosedActions.length === 0) return;
		const retained: AutoClosedAction[] = [];
		for (const action of this.autoClosedActions) {
			if (this.isAutoClosedActionValid(action)) retained.push(action);
			else this.disposeAutoClosedAction(action);
		}
		this.autoClosedActions = retained;
	}

	private isAutoClosedActionValid(action: AutoClosedAction): boolean {
		const enclosing = action.enclosing.range;
		const closer = action.closer.range;
		if (enclosing.startLineNumber !== enclosing.endLineNumber || closer.startLineNumber !== closer.endLineNumber) return false;
		if (closer.endLineNumber !== enclosing.endLineNumber || closer.endColumn !== enclosing.endColumn) return false;
		if (this.model.getTextInRange(closer) !== action.close) return false;
		if (this.model.getTextInRange(Range.fromPositions(enclosing.getStartPosition(), closer.getStartPosition())) !== action.open) return false;
		return this.currentSelections.some(selection => (
			enclosing.getStartPosition().isBefore(selection.getStartPosition()) &&
			selection.getEndPosition().isBefore(enclosing.getEndPosition())
		));
	}

	private disposeAutoClosedAction(action: AutoClosedAction): void {
		action.closer.dispose();
		action.enclosing.dispose();
	}

}

function validateSelections(model: TextModel, selections: readonly Selection[]): void {
	if (selections.length === 0) throw new RangeError('Selections must not be empty');
	for (const selection of selections) {
		model.offsetAt(selection.getSelectionStart());
		model.offsetAt(selection.getPosition());
	}
}

function selectionsEqual(left: readonly Selection[], right: readonly Selection[]): boolean {
	return left.length === right.length && left.every((selection, index) => selection.equalsSelection(right[index]!));
}

function cursorStatesEqual(left: readonly CursorState[], right: readonly CursorState[]): boolean {
	return left.length === right.length && left.every((state, index) => state.equals(right[index]!));
}
