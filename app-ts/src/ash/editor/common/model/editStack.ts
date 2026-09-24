import { type OffsetTextEdit } from "./historyCoalescing.js";
import { Selection } from "../core/selection.js";
import { TextChange } from "../core/textChange.js";
import { EndOfLineSequence } from '../model.js';
import { UndoRedoGroup } from '../../../platform/undoRedo/common/undoRedo.js';

export interface TextModelHistoryEntry {
	readonly edits: readonly OffsetTextEdit[];
	readonly textChanges: readonly TextChange[];
	readonly textUnits: number;
	readonly transactionId: number;
	readonly alternativeVersionId: number;
	readonly editsEOL: EndOfLineSequence;
	readonly eol: EndOfLineSequence;
	readonly historyGroup: UndoRedoGroup | undefined;
	readonly lineIds: readonly string[] | undefined;
	readonly beforeCursorState: Selection[] | null;
	readonly afterCursorState: Selection[] | null;
}

export interface TextModelHistorySnapshot {
	readonly undo: readonly TextModelHistoryEntry[];
	readonly redo: readonly TextModelHistoryEntry[];
	readonly textUnits: number;
}

export class TextModelHistory {
	private readonly undoStack: TextModelHistoryEntry[] = [];
	private readonly redoStack: TextModelHistoryEntry[] = [];
	private historyTextUnits = 0;
	private protectedGroup: UndoRedoGroup | undefined;
	private stackElementOpen = false;

	constructor(
		private readonly transactionLimit: number,
		private readonly textUnitLimit: number,
	) {}

	get canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	get canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	createSnapshot(): TextModelHistorySnapshot | undefined {
		if (this.protectedGroup) return undefined;
		return Object.freeze({
			undo: Object.freeze(this.undoStack.map(cloneEntry)),
			redo: Object.freeze(this.redoStack.map(cloneEntry)),
			textUnits: this.historyTextUnits,
		});
	}

	restoreSnapshot(snapshot: TextModelHistorySnapshot): void {
		if (this.protectedGroup) throw new Error('Cannot restore undo and redo while a history revision is active');
		this.reset();
		this.undoStack.push(...snapshot.undo.map(cloneEntry));
		this.redoStack.push(...snapshot.redo.map(cloneEntry));
		this.historyTextUnits = this.undoStack.concat(this.redoStack).reduce((total, entry) => total + entry.textUnits, 0);
		this.stackElementOpen = false;
		this.trim();
	}

	pushStackElement(): void {
		this.stackElementOpen = false;
	}

	popStackElement(): void {
		this.stackElementOpen = this.undoStack.length > 0 && this.redoStack.length === 0;
	}

	isRevisionActive(historyGroup: UndoRedoGroup): boolean {
		return this.protectedGroup === historyGroup;
	}

	prepareForEdit(historyGroup: UndoRedoGroup | undefined): void {
		if (this.protectedGroup && this.protectedGroup !== historyGroup) {
			this.protectedGroup = undefined;
			this.trim();
		}
	}

	beginRevision(historyGroup: UndoRedoGroup): void {
		if (this.protectedGroup) {
			throw new Error("A history revision is already active");
		}
		this.protectedGroup = historyGroup;
	}

	finishRevision(historyGroup: UndoRedoGroup): boolean {
		this.assertProtectedGroup(historyGroup);
		this.protectedGroup = undefined;
		this.trim();
		return this.undoStack.some(
			entry => entry.historyGroup === historyGroup,
		);
	}

	getRevisionEntry(
		historyGroup: UndoRedoGroup,
	): TextModelHistoryEntry | undefined {
		this.assertProtectedGroup(historyGroup);
		const entry = this.undoStack[this.undoStack.length - 1];
		return entry?.historyGroup === historyGroup ? entry : undefined;
	}

	discardRevision(historyGroup: UndoRedoGroup): void {
		this.cancelRevision(historyGroup);
	}

	cancelRevision(
		historyGroup: UndoRedoGroup,
	): TextModelHistoryEntry | undefined {
		this.assertProtectedGroup(historyGroup);
		this.protectedGroup = undefined;
		const entry = this.undoStack[this.undoStack.length - 1];
		if (!entry) return undefined;
		if (entry.historyGroup !== historyGroup) {
			throw new Error("The active history revision is not the latest undo step");
		}
		return this.takeUndo();
	}

	findUndoEntry(
		historyGroup: UndoRedoGroup | undefined,
		accepts: (entry: TextModelHistoryEntry) => boolean,
	): TextModelHistoryEntry | undefined {
		if (this.redoStack.length > 0) return undefined;
		const previous = this.undoStack[this.undoStack.length - 1];
		const canAppend = this.stackElementOpen && (
			historyGroup === undefined || previous?.historyGroup === historyGroup
		);
		return previous && canAppend && accepts(previous)
			? previous
			: undefined;
	}

	replaceUndoEntry(
		previous: TextModelHistoryEntry,
		edits: readonly OffsetTextEdit[],
		textChanges: readonly TextChange[],
		afterCursorState: Selection[] | null = previous.afterCursorState,
	): void {
		if (this.undoStack[this.undoStack.length - 1] !== previous) {
			throw new Error("Only the latest undo entry can be replaced");
		}
		const replacement = createEntry(
			edits,
			previous.transactionId,
			previous.alternativeVersionId,
			previous.editsEOL,
			previous.eol,
			previous.historyGroup,
			previous.lineIds,
			previous.beforeCursorState,
			afterCursorState,
			textChanges,
		);
		this.historyTextUnits += replacement.textUnits - previous.textUnits;
		this.undoStack[this.undoStack.length - 1] = replacement;
		this.trim();
	}

	pushUndo(
		edits: readonly OffsetTextEdit[],
		transactionId: number,
		alternativeVersionId: number,
		editsEOL: EndOfLineSequence,
		eol: EndOfLineSequence,
		historyGroup: UndoRedoGroup | undefined,
		lineIds?: readonly string[],
		beforeCursorState: Selection[] | null = null,
		afterCursorState: Selection[] | null = null,
		textChanges: readonly TextChange[] = [],
	): void {
		this.push(this.undoStack, edits, transactionId, alternativeVersionId, editsEOL, eol, historyGroup, lineIds, beforeCursorState, afterCursorState, textChanges);
		this.stackElementOpen = true;
		this.trim();
	}

	pushRedo(
		edits: readonly OffsetTextEdit[],
		transactionId: number,
		alternativeVersionId: number,
		editsEOL: EndOfLineSequence,
		eol: EndOfLineSequence,
		historyGroup: UndoRedoGroup | undefined,
		lineIds?: readonly string[],
		beforeCursorState: Selection[] | null = null,
		afterCursorState: Selection[] | null = null,
		textChanges: readonly TextChange[] = [],
	): void {
		this.push(this.redoStack, edits, transactionId, alternativeVersionId, editsEOL, eol, historyGroup, lineIds, beforeCursorState, afterCursorState, textChanges);
		this.stackElementOpen = false;
		this.trim();
	}

	takeUndo(): TextModelHistoryEntry | undefined {
		return this.take(this.undoStack);
	}

	takeRedo(): TextModelHistoryEntry | undefined {
		return this.take(this.redoStack);
	}

	clearRedo(): void {
		this.clear(this.redoStack);
	}

	reset(): void {
		this.undoStack.length = 0;
		this.redoStack.length = 0;
		this.historyTextUnits = 0;
		this.protectedGroup = undefined;
		this.stackElementOpen = false;
	}

	dispose(): void {
		this.reset();
	}

	private push(
		stack: TextModelHistoryEntry[],
		edits: readonly OffsetTextEdit[],
		transactionId: number,
		alternativeVersionId: number,
		editsEOL: EndOfLineSequence,
		eol: EndOfLineSequence,
		historyGroup: UndoRedoGroup | undefined,
		lineIds?: readonly string[],
		beforeCursorState: Selection[] | null = null,
		afterCursorState: Selection[] | null = null,
		textChanges: readonly TextChange[] = [],
	): void {
		const entry = createEntry(edits, transactionId, alternativeVersionId, editsEOL, eol, historyGroup, lineIds, beforeCursorState, afterCursorState, textChanges);
		stack.push(entry);
		this.historyTextUnits += entry.textUnits;
	}

	private take(
		stack: TextModelHistoryEntry[],
	): TextModelHistoryEntry | undefined {
		const entry = stack.pop();
		if (entry) {
			this.historyTextUnits -= entry.textUnits;
			this.stackElementOpen = false;
		}
		return entry;
	}

	private clear(stack: TextModelHistoryEntry[]): void {
		for (const entry of stack) {
			this.historyTextUnits -= entry.textUnits;
		}
		stack.length = 0;
	}

	private trim(): void {
		while (
			this.undoStack.length + this.redoStack.length >
				this.transactionLimit ||
			this.historyTextUnits > this.textUnitLimit
		) {
			if (
				this.protectedGroup &&
				this.undoStack.length === 1 &&
				this.undoStack[0].historyGroup === this.protectedGroup
			) {
				break;
			}
			const stack = this.undoStack.length > 0
				? this.undoStack
				: this.redoStack;
			const [removed] = stack.splice(0, 1);
			this.historyTextUnits -= removed.textUnits;
		}
	}

	private assertProtectedGroup(historyGroup: UndoRedoGroup): void {
		if (this.protectedGroup !== historyGroup) {
			throw new Error("The history revision is no longer active");
		}
	}
}

function createEntry(
	edits: readonly OffsetTextEdit[],
	transactionId: number,
	alternativeVersionId: number,
	editsEOL: EndOfLineSequence,
	eol: EndOfLineSequence,
	historyGroup: UndoRedoGroup | undefined,
	lineIds?: readonly string[],
	beforeCursorState: Selection[] | null = null,
	afterCursorState: Selection[] | null = null,
	textChanges: readonly TextChange[] = [],
): TextModelHistoryEntry {
	return Object.freeze({
		edits: Object.freeze(edits.map(edit => Object.freeze({ ...edit }))),
		textChanges: Object.freeze(textChanges.map(change => new TextChange(change.oldPosition, change.oldText, change.newPosition, change.newText))),
		textUnits: edits.reduce(
			(total, edit) => total + edit.text.length,
			0,
		),
		transactionId,
		alternativeVersionId,
		editsEOL,
		eol,
		historyGroup,
		lineIds: lineIds === undefined ? undefined : Object.freeze([...lineIds]),
		beforeCursorState: cloneSelections(beforeCursorState),
		afterCursorState: cloneSelections(afterCursorState),
	});
}

function cloneEntry(entry: TextModelHistoryEntry): TextModelHistoryEntry {
	return createEntry(entry.edits, entry.transactionId, entry.alternativeVersionId, entry.editsEOL, entry.eol, entry.historyGroup, entry.lineIds, entry.beforeCursorState, entry.afterCursorState, entry.textChanges);
}

function cloneSelections(selections: Selection[] | null): Selection[] | null {
	return selections?.map(Selection.liftSelection) ?? null;
}
