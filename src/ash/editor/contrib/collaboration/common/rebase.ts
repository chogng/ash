import { collectDocumentNodeIds, findDocumentNode, type DocumentNode, type DocumentNodeId } from "../../../common/model/document.js";
import { isDocumentSelectionValid, nodeSelection, textSelection, type DocumentPoint, type DocumentSelection } from "../../../common/core/documentSelection.js";
import type { DocumentHistoryEntries, DocumentHistoryEntry } from "../../../common/model/documentHistory.js";
import { type DocumentSchema } from "../../../common/model/documentSchema.js";
import { applyDocumentTransaction, DocumentTransaction, type DocumentStep, type ReplaceTextStep } from "../../../common/model/documentTransaction.js";

export interface RebasedDocumentTransaction {
	readonly transaction: DocumentTransaction;
	readonly document: DocumentNode;
	readonly remoteDocument: DocumentNode;
	readonly droppedSteps: readonly DocumentStep[];
}

/** Reports a local transaction that cannot be replayed after a remote change. */
export class DocumentRebaseError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "DocumentRebaseError";
	}
}

/**
 * Rebuilds the local undo and redo branches after a server-ordered remote
 * transaction. Each entry is transformed in the document state where it will
 * actually run, so undo preserves remote content even after several local
 * changes. A conflicting branch is discarded as one unit rather than applying
 * a stale inverse to another author's document.
 */
export function rebaseDocumentHistory(document: DocumentNode, schema: DocumentSchema, entries: DocumentHistoryEntries, remote: DocumentTransaction): DocumentHistoryEntries {
	schema.validate(document);
	applyDocumentTransaction(document, schema, remote);
	const undo = rebaseUndoEntries(document, schema, entries.undo, remote);
	if (!undo) return emptyDocumentHistoryEntries();
	const redo = rebaseRedoEntries(document, schema, entries.redo, remote);
	if (!redo) return emptyDocumentHistoryEntries();
	return Object.freeze({ undo: Object.freeze(undo), redo: Object.freeze(redo) });
}

/**
 * Rebases a pending local transaction onto a remote transaction from the same
 * document snapshot. Stable node ids make structural targets durable while
 * text offsets and sibling indices are shifted through the remote steps.
 *
 * This is a one-sided rebase primitive for a collaboration adapter. It does
 * not choose a server order, provide client-id tie breaking, or implement an
 * OT/CRDT protocol. A caller should persist the returned transaction and
 * submit it only after applying the remote transaction to its model.
 */
export function rebaseDocumentTransaction(base: DocumentNode, schema: DocumentSchema, local: DocumentTransaction, remote: DocumentTransaction): RebasedDocumentTransaction {
	schema.validate(base);
	applyDocumentTransaction(base, schema, local);
	const remoteApplied = applyDocumentTransaction(base, schema, remote);
	const remoteChanges = collectRemoteChanges(base, schema, remote);
	const remoteDocument = remoteApplied.document;
	const rebasedSteps: DocumentStep[] = [];
	const droppedSteps: DocumentStep[] = [];
	const localCreatedIds = new Set<DocumentNodeId>();

	for (const originalStep of local.steps) {
		const step = mapStepThroughRemote(originalStep, remoteChanges, remoteDocument, localCreatedIds);
		if (!step) {
			droppedSteps.push(originalStep);
			continue;
		}
		if (step.kind === "insertNode") {
			for (const id of collectDocumentNodeIds(step.node)) {
				if (findDocumentNode(remoteDocument, id) || localCreatedIds.has(id)) throw new DocumentRebaseError(`Local node id '${id}' collides with the remote document`);
				localCreatedIds.add(id);
			}
		}
		rebasedSteps.push(step);
	}

	const mappedSelection = local.selection === undefined ? undefined : remoteApplied.mapping.mapSelection(local.selection);
	const transaction = new DocumentTransaction(rebasedSteps, {
		addToHistory: local.addToHistory,
		label: local.label,
		selection: mappedSelection,
		selectionSet: local.selectionSet,
		storedMarks: local.storedMarks,
		storedMarksSet: local.storedMarksSet,
		historyGroup: local.historyGroup,
		metadata: local.metadata,
	});

	try {
		const applied = applyDocumentTransaction(remoteDocument, schema, transaction);
		const selection = transaction.selectionSet ? normalizeSelection(local.selection, mappedSelection, remoteDocument, applied.document) : undefined;
		const normalizedTransaction = transaction.selectionSet ? transaction.withSelection(selection) : transaction;
		return Object.freeze({ transaction: normalizedTransaction, document: applied.document, remoteDocument, droppedSteps: Object.freeze(droppedSteps) });
	} catch (error) {
		throw new DocumentRebaseError("The rebased document transaction is not valid after the remote change", { cause: error });
	}
}

type HistoricalInsertionOrder = "before" | "after";

function rebaseUndoEntries(document: DocumentNode, schema: DocumentSchema, entries: readonly DocumentHistoryEntry[], remote: DocumentTransaction): DocumentHistoryEntry[] | undefined {
	let localDocument = document;
	let remoteAtCurrent = remote;
	const rebased = new Array<DocumentHistoryEntry>(entries.length);
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		const localPrevious = applyDocumentTransaction(localDocument, schema, entry.inverse).document;
		const insertionOrder = historicalInsertionOrder(localDocument, remoteAtCurrent, entry.inverse);
		const remoteAtPrevious = rebaseHistoryTransaction(localDocument, schema, remoteAtCurrent, entry.inverse);
		if (!remoteAtPrevious) return undefined;
		const forward = rebaseLocalHistoryTransaction(localPrevious, schema, entry.transaction, remoteAtPrevious.transaction, insertionOrder);
		if (!forward) return undefined;
		const applied = applyDocumentTransaction(remoteAtPrevious.document, schema, forward.transaction);
		rebased[index] = createRebasedHistoryEntry(entry, forward.transaction, applied.inverse, mapHistorySelection(localPrevious, schema, remoteAtPrevious.transaction, entry.selectionBefore), mapHistorySelection(localDocument, schema, remoteAtCurrent, entry.selectionAfter));
		localDocument = localPrevious;
		remoteAtCurrent = remoteAtPrevious.transaction;
	}
	return rebased;
}

function rebaseRedoEntries(document: DocumentNode, schema: DocumentSchema, entries: readonly DocumentHistoryEntry[], remote: DocumentTransaction): DocumentHistoryEntry[] | undefined {
	let localDocument = document;
	let remoteAtCurrent = remote;
	const rebased = new Array<DocumentHistoryEntry>(entries.length);
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		const forward = rebaseLocalHistoryTransaction(localDocument, schema, entry.transaction, remoteAtCurrent, "after");
		if (!forward) return undefined;
		const applied = applyDocumentTransaction(remoteAtCurrentDocument(localDocument, schema, remoteAtCurrent), schema, forward.transaction);
		const remoteAtNext = rebaseHistoryTransaction(localDocument, schema, remoteAtCurrent, entry.transaction);
		if (!remoteAtNext) return undefined;
		rebased[index] = createRebasedHistoryEntry(entry, forward.transaction, applied.inverse, mapHistorySelection(localDocument, schema, remoteAtCurrent, entry.selectionBefore), mapHistorySelection(applyDocumentTransaction(localDocument, schema, entry.transaction).document, schema, remoteAtNext.transaction, entry.selectionAfter));
		localDocument = applyDocumentTransaction(localDocument, schema, entry.transaction).document;
		remoteAtCurrent = remoteAtNext.transaction;
	}
	return rebased;
}

function rebaseHistoryTransaction(base: DocumentNode, schema: DocumentSchema, local: DocumentTransaction, remote: DocumentTransaction): RebasedDocumentTransaction | undefined {
	try {
		const rebased = rebaseDocumentTransaction(base, schema, local, remote);
		return local.steps.length === 0 || rebased.transaction.steps.length > 0 ? rebased : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Maps an already acknowledged local history entry after remote work. For a
 * simultaneous insertion, the historical local step stays before the remote
 * insertion; otherwise redo could turn an insertion into a replacement and
 * remove another author's text.
 */
function rebaseLocalHistoryTransaction(base: DocumentNode, schema: DocumentSchema, local: DocumentTransaction, remote: DocumentTransaction, insertionOrder: HistoricalInsertionOrder): RebasedDocumentTransaction | undefined {
	try {
		const remoteApplied = applyDocumentTransaction(base, schema, remote);
		const remoteChanges = collectRemoteChanges(base, schema, remote);
		const localCreatedIds = new Set<DocumentNodeId>();
		const steps: DocumentStep[] = [];
		for (const originalStep of local.steps) {
			const step = mapHistoryStepThroughRemote(originalStep, remoteChanges, remoteApplied.document, localCreatedIds, insertionOrder);
			if (!step) return undefined;
			if (step.kind === "insertNode") {
				for (const id of collectDocumentNodeIds(step.node)) {
					if (findDocumentNode(remoteApplied.document, id) || localCreatedIds.has(id)) throw new DocumentRebaseError(`Local node id '${id}' collides with the remote document`);
					localCreatedIds.add(id);
				}
			}
			steps.push(step);
		}
		const transaction = new DocumentTransaction(steps, {
			addToHistory: local.addToHistory,
			label: local.label,
			selection: local.selection === undefined ? undefined : remoteApplied.mapping.mapSelection(local.selection),
			selectionSet: local.selectionSet,
			storedMarks: local.storedMarks,
			storedMarksSet: local.storedMarksSet,
			historyGroup: local.historyGroup,
			metadata: local.metadata,
		});
		const applied = applyDocumentTransaction(remoteApplied.document, schema, transaction);
		return Object.freeze({ transaction, document: applied.document, remoteDocument: remoteApplied.document, droppedSteps: Object.freeze([]) });
	} catch {
		return undefined;
	}
}

function mapHistoryStepThroughRemote(step: DocumentStep, changes: readonly RemoteChange[], remoteDocument: DocumentNode, localCreatedIds: ReadonlySet<DocumentNodeId>, insertionOrder: HistoricalInsertionOrder): DocumentStep | undefined {
	let mapped: DocumentStep | undefined = step;
	for (const change of changes) {
		if (!mapped) return undefined;
		if (mapped.kind === "replaceText") {
			mapped = mapHistoryReplaceTextThroughRemote(mapped, [change], remoteDocument, insertionOrder, localCreatedIds);
			if (!mapped) return undefined;
			continue;
		}
		if (mapped.kind === "insertNode") {
			if (!isNodeAvailable(remoteDocument, mapped.parentId, localCreatedIds)) return undefined;
			mapped = { ...mapped, index: mapHistoryChildIndex(mapped.parentId, mapped.index, change, insertionOrder) };
			continue;
		}
		if (mapped.kind === "moveNode") {
			if (!isNodeAvailable(remoteDocument, mapped.nodeId, localCreatedIds) || !isNodeAvailable(remoteDocument, mapped.parentId, localCreatedIds)) return undefined;
			mapped = { ...mapped, index: mapHistoryChildIndex(mapped.parentId, mapped.index, change, insertionOrder) };
			continue;
		}
		if (!isNodeAvailable(remoteDocument, mapped.nodeId, localCreatedIds)) return undefined;
	}
	return mapped;
}

function mapHistoryReplaceTextThroughRemote(step: ReplaceTextStep, changes: readonly RemoteChange[], remoteDocument: DocumentNode, insertionOrder: HistoricalInsertionOrder, localCreatedIds: ReadonlySet<DocumentNodeId>): ReplaceTextStep | undefined {
	let mapped = step;
	for (const change of changes) {
		if (localCreatedIds.has(mapped.nodeId)) continue;
		if (!isNodeAvailable(remoteDocument, mapped.nodeId, localCreatedIds)) throw new DocumentRebaseError(`History text node '${mapped.nodeId}' no longer exists`);
		const remote = change.step;
		if (remote.kind !== "replaceText" || remote.nodeId !== mapped.nodeId) continue;
		const textNode = findDocumentNode(remoteDocument, mapped.nodeId)?.node;
		if (!textNode || textNode.text === undefined) throw new DocumentRebaseError(`History text node '${mapped.nodeId}' no longer exists`);
		const fromBias = mapped.from === mapped.to ? insertionOrder === "before" ? "backward" : "forward" : "forward";
		const from = mapTextOffset(mapped.from, remote, fromBias);
		const to = mapTextOffset(mapped.to, remote, mapped.from === mapped.to ? fromBias : "backward");
		mapped = { ...mapped, from: Math.max(0, Math.min(textNode.text.length, from)), to: Math.max(0, Math.min(textNode.text.length, Math.max(from, to))) };
		if (step.from !== step.to && mapped.from === mapped.to) return undefined;
	}
	return mapped;
}

function mapHistoryChildIndex(parentId: DocumentNodeId, index: number, change: RemoteChange, insertionOrder: HistoricalInsertionOrder): number {
	const step = change.step;
	if (step.kind === "insertNode" && step.parentId === parentId) return step.index < index || (step.index === index && insertionOrder === "after") ? index + 1 : index;
	if (step.kind === "deleteNode") {
		const location = findDocumentNode(change.before, step.nodeId);
		return location?.parent?.id === parentId && location.index < index ? index - 1 : index;
	}
	if (step.kind !== "moveNode") return index;
	const location = findDocumentNode(change.before, step.nodeId);
	let mapped = index;
	if (location?.parent?.id === parentId && location.index < mapped) mapped -= 1;
	if (step.parentId === parentId && (step.index < mapped || (step.index === mapped && insertionOrder === "after"))) mapped += 1;
	return mapped;
}

function historicalInsertionOrder(document: DocumentNode, remote: DocumentTransaction, inverse: DocumentTransaction): HistoricalInsertionOrder {
	for (const inverseStep of inverse.steps) {
		for (const remoteStep of remote.steps) {
			if (inverseStep.kind === "replaceText" && remoteStep.kind === "replaceText" && remoteStep.nodeId === inverseStep.nodeId && remoteStep.from === remoteStep.to) {
				if (remoteStep.from === inverseStep.to) return "before";
				if (remoteStep.from === inverseStep.from) return "after";
			}
			if (inverseStep.kind === "deleteNode" && remoteStep.kind === "insertNode") {
				const location = findDocumentNode(document, inverseStep.nodeId);
				if (location?.parent?.id !== remoteStep.parentId) continue;
				if (remoteStep.index === location.index + 1) return "before";
				if (remoteStep.index === location.index) return "after";
			}
		}
	}
	return "after";
}

function remoteAtCurrentDocument(document: DocumentNode, schema: DocumentSchema, remote: DocumentTransaction): DocumentNode {
	return applyDocumentTransaction(document, schema, remote).document;
}

function createRebasedHistoryEntry(entry: DocumentHistoryEntry, transaction: DocumentTransaction, inverse: DocumentTransaction, selectionBefore: DocumentSelection | undefined, selectionAfter: DocumentSelection | undefined): DocumentHistoryEntry {
	return Object.freeze({ transaction, inverse, selectionBefore, selectionAfter, historyGroup: entry.historyGroup });
}

function mapHistorySelection(document: DocumentNode, schema: DocumentSchema, remote: DocumentTransaction, selection: DocumentSelection | undefined): DocumentSelection | undefined {
	if (!selection) return undefined;
	const applied = applyDocumentTransaction(document, schema, remote);
	const mapped = applied.mapping.mapSelection(selection);
	return mapped && isDocumentSelectionValid(applied.document, mapped) ? mapped : undefined;
}

function emptyDocumentHistoryEntries(): DocumentHistoryEntries {
	return Object.freeze({ undo: Object.freeze([]), redo: Object.freeze([]) });
}

interface RemoteChange {
	readonly before: DocumentNode;
	readonly after: DocumentNode;
	readonly step: DocumentStep;
}

function collectRemoteChanges(base: DocumentNode, schema: DocumentSchema, transaction: DocumentTransaction): readonly RemoteChange[] {
	let current = base;
	const changes: RemoteChange[] = [];
	for (const step of transaction.steps) {
		const before = current;
		try {
			current = applyDocumentTransaction(current, schema, new DocumentTransaction([step], { addToHistory: false })).document;
		} catch (error) {
			throw new DocumentRebaseError("The remote transaction must be replayable one step at a time for rebasing", { cause: error });
		}
		changes.push(Object.freeze({ before, after: current, step }));
	}
	return Object.freeze(changes);
}

function mapStepThroughRemote(step: DocumentStep, changes: readonly RemoteChange[], remoteDocument: DocumentNode, localCreatedIds: ReadonlySet<DocumentNodeId>): DocumentStep | undefined {
	let mapped: DocumentStep | undefined = step;
	for (const change of changes) {
		if (!mapped) return undefined;
		mapped = mapStepThroughChange(mapped, change, remoteDocument, localCreatedIds);
	}
	return mapped;
}

function mapStepThroughChange(step: DocumentStep, change: RemoteChange, remoteDocument: DocumentNode, localCreatedIds: ReadonlySet<DocumentNodeId>): DocumentStep | undefined {
	if (step.kind === "replaceText") return mapReplaceTextStep(step, change, remoteDocument, localCreatedIds);
	if (step.kind === "insertNode") {
		if (!isNodeAvailable(remoteDocument, step.parentId, localCreatedIds)) return undefined;
		return { ...step, index: mapChildIndex(step.parentId, step.index, change) };
	}
	if (step.kind === "moveNode") {
		if (!isNodeAvailable(remoteDocument, step.nodeId, localCreatedIds) || !isNodeAvailable(remoteDocument, step.parentId, localCreatedIds)) return undefined;
		return { ...step, index: mapChildIndex(step.parentId, step.index, change) };
	}
	if (!isNodeAvailable(remoteDocument, step.nodeId, localCreatedIds)) return undefined;
	return step;
}

function mapReplaceTextStep(step: ReplaceTextStep, change: RemoteChange, remoteDocument: DocumentNode, localCreatedIds: ReadonlySet<DocumentNodeId>): ReplaceTextStep | undefined {
	if (localCreatedIds.has(step.nodeId)) return step;
	if (!isNodeAvailable(remoteDocument, step.nodeId, localCreatedIds)) return undefined;
	const remoteStep = change.step;
	if (remoteStep.kind !== "replaceText" || remoteStep.nodeId !== step.nodeId) return step;
	const textNode = findDocumentNode(remoteDocument, step.nodeId)?.node;
	if (!textNode || textNode.text === undefined) return undefined;
	const from = mapTextOffset(step.from, remoteStep, "backward");
	const to = mapTextOffset(step.to, remoteStep, "forward");
	return { ...step, from: Math.max(0, Math.min(textNode.text.length, from)), to: Math.max(0, Math.min(textNode.text.length, Math.max(from, to))) };
}

function mapTextOffset(offset: number, remote: ReplaceTextStep, bias: "backward" | "forward"): number {
	const insertedLength = normalizeText(remote.text).length;
	const change = insertedLength - (remote.to - remote.from);
	if (offset < remote.from || (offset === remote.from && bias === "backward")) return offset;
	if (offset > remote.to || (offset === remote.to && bias === "forward")) return offset + change;
	return bias === "backward" ? remote.from : remote.from + insertedLength;
}

function mapChildIndex(parentId: DocumentNodeId, index: number, change: RemoteChange): number {
	const step = change.step;
	if (step.kind === "insertNode" && step.parentId === parentId && step.index <= index) return index + 1;
	if (step.kind === "deleteNode") {
		const location = findDocumentNode(change.before, step.nodeId);
		if (location?.parent?.id === parentId && location.index < index) return index - 1;
		return index;
	}
	if (step.kind !== "moveNode") return index;
	const location = findDocumentNode(change.before, step.nodeId);
	let mapped = index;
	if (location?.parent?.id === parentId && location.index < mapped) mapped -= 1;
	if (step.parentId === parentId && step.index <= mapped) mapped += 1;
	return mapped;
}

function isNodeAvailable(document: DocumentNode, nodeId: DocumentNodeId, localCreatedIds: ReadonlySet<DocumentNodeId>): boolean {
	return localCreatedIds.has(nodeId) || findDocumentNode(document, nodeId) !== undefined;
}

function normalizeSelection(original: DocumentSelection | undefined, mapped: DocumentSelection | undefined, remoteDocument: DocumentNode, document: DocumentNode): DocumentSelection | undefined {
	if (!original) return mapped && isDocumentSelectionValid(document, mapped) ? mapped : undefined;
	if (original.kind === "all") return original;
	if (original.kind === "node") {
		if (findDocumentNode(document, original.nodeId)) return nodeSelection(original.nodeId);
		return mapped && isDocumentSelectionValid(document, mapped) ? mapped : undefined;
	}
	const mappedText = mapped?.kind === "text" ? mapped : undefined;
	const anchor = normalizePoint(original.anchor, mappedText?.anchor, remoteDocument, document);
	const head = normalizePoint(original.head, mappedText?.head, remoteDocument, document);
	if (!anchor || !head) return undefined;
	return textSelection(anchor, head);
}

function normalizePoint(original: DocumentPoint, mapped: DocumentPoint | undefined, remoteDocument: DocumentNode, document: DocumentNode): DocumentPoint | undefined {
	const current = findDocumentNode(document, original.nodeId)?.node;
	if (!current || current.text === undefined) return mapped && isDocumentSelectionValid(document, textSelection(mapped)) ? mapped : undefined;
	if (!findDocumentNode(remoteDocument, original.nodeId)) return { nodeId: current.id, offset: Math.min(original.offset, current.text.length) };
	if (mapped && findDocumentNode(document, mapped.nodeId)?.node.text !== undefined) return mapped;
	return { nodeId: current.id, offset: Math.min(original.offset, current.text.length) };
}

function normalizeText(text: string): string {
	return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}
