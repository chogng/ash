import { DocumentTransaction } from "./documentTransaction.js";
import { type DocumentSelection } from "../core/documentSelection.js";

export interface DocumentHistoryEntry {
	readonly transaction: DocumentTransaction;
	readonly inverse: DocumentTransaction;
	readonly selectionBefore: DocumentSelection | undefined;
	readonly selectionAfter: DocumentSelection | undefined;
	readonly historyGroup: string | undefined;
}

/** Immutable snapshots of the local undo and redo branches. */
export interface DocumentHistoryEntries {
	readonly undo: readonly DocumentHistoryEntry[];
	readonly redo: readonly DocumentHistoryEntry[];
}

/** Transaction history for one Stanza document; selection state travels with each step. */
export class DocumentHistory {
	private readonly undoStack: DocumentHistoryEntry[] = [];
	private readonly redoStack: DocumentHistoryEntry[] = [];
	private readonly limit: number;
	private groupOpen = false;

	constructor(limit = 1_000) {
		if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Document history limit must be a non-negative safe integer");
		this.limit = limit;
	}

	get canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	get canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	pushUndo(entry: DocumentHistoryEntry): void {
		if (this.limit === 0) {
			this.redoStack.length = 0;
			this.groupOpen = false;
			return;
		}
		this.redoStack.length = 0;
		const previous = this.undoStack.at(-1);
		if (this.groupOpen && previous?.historyGroup !== undefined && previous.historyGroup === entry.historyGroup) this.undoStack[this.undoStack.length - 1] = mergeHistoryEntries(previous, entry);
		else this.undoStack.push(entry);
		this.groupOpen = entry.historyGroup !== undefined;
		this.trim(this.undoStack);
	}

	takeUndo(): DocumentHistoryEntry | undefined {
		this.groupOpen = false;
		return this.undoStack.pop();
	}

	pushRedo(entry: DocumentHistoryEntry): void {
		if (this.limit === 0) return;
		this.redoStack.push(entry);
		this.groupOpen = false;
		this.trim(this.redoStack);
	}

	takeRedo(): DocumentHistoryEntry | undefined {
		this.groupOpen = false;
		return this.redoStack.pop();
	}

	clear(): void {
		this.undoStack.length = 0;
		this.redoStack.length = 0;
		this.groupOpen = false;
	}

	closeGroup(): void {
		this.groupOpen = false;
	}

	restoreUndo(entry: DocumentHistoryEntry): void {
		if (this.limit === 0) return;
		this.undoStack.push(entry);
		this.groupOpen = false;
		this.trim(this.undoStack);
	}

	restoreRedo(entry: DocumentHistoryEntry): void {
		if (this.limit === 0) return;
		this.redoStack.push(entry);
		this.groupOpen = false;
		this.trim(this.redoStack);
	}

	/** Replaces both local history branches with entries rebased by a collaboration adapter. */
	rebase(mapper: (entries: DocumentHistoryEntries) => DocumentHistoryEntries): void {
		const entries = mapper(Object.freeze({ undo: Object.freeze([...this.undoStack]), redo: Object.freeze([...this.redoStack]) }));
		this.undoStack.splice(0, this.undoStack.length, ...entries.undo);
		this.redoStack.splice(0, this.redoStack.length, ...entries.redo);
		this.trim(this.undoStack);
		this.trim(this.redoStack);
		this.groupOpen = false;
	}

	private trim(stack: DocumentHistoryEntry[]): void {
		const excess = stack.length - this.limit;
		if (excess > 0) stack.splice(0, excess);
	}
}

function mergeHistoryEntries(previous: DocumentHistoryEntry, next: DocumentHistoryEntry): DocumentHistoryEntry {
	return Object.freeze({
		transaction: new DocumentTransaction([...previous.transaction.steps, ...next.transaction.steps], { label: next.transaction.label, selection: next.transaction.selection, selectionSet: next.transaction.selectionSet, storedMarks: next.transaction.storedMarks, storedMarksSet: next.transaction.storedMarksSet, historyGroup: next.historyGroup, metadata: [...previous.transaction.metadata, ...next.transaction.metadata] }),
		inverse: new DocumentTransaction([...next.inverse.steps, ...previous.inverse.steps], { addToHistory: false, label: next.inverse.label }),
		selectionBefore: previous.selectionBefore,
		selectionAfter: next.selectionAfter,
		historyGroup: next.historyGroup,
	});
}
