import { collectDocumentNodeIds, findDocumentNode, type DocumentAttributes, type DocumentNode, type DocumentNodeId } from '../../model/document.js';
import { localize } from 'ash:editor/nls.js';
import { isDocumentSelectionValid, nodeSelection, textSelection, type DocumentPoint, type DocumentSelection } from '../../core/documentSelection.js';
import type { DocumentHistoryEntries, DocumentHistoryEntry } from '../../model/documentHistory.js';
import { type DocumentSchema } from '../../model/documentSchema.js';
import { applyDocumentTransaction, DocumentTransaction, DocumentTransactionMapping, type DocumentStep, type ReplaceTextStep } from '../../model/documentTransaction.js';

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
		this.name = 'DocumentRebaseError';
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
	const localChanges = collectTransactionChanges(base, schema, local);
	const remoteApplied = applyDocumentTransaction(base, schema, remote);
	const remoteChanges = collectTransactionChanges(base, schema, remote);
	const remoteDocument = remoteApplied.document;
	assertReinsertedNodesUnchanged(base, remoteDocument, local);
	const rebasedSteps: DocumentStep[] = [];
	const droppedSteps: DocumentStep[] = [];
	const localCreatedIds = new Set<DocumentNodeId>();
	const localDeletedIds = new Set<DocumentNodeId>();

	const attributes = new Map<string, DocumentAttributes>();
	for (const [index, originalStep] of local.steps.entries()) {
		let step = mapStepThroughRemote(originalStep, remoteChanges, remoteDocument, localCreatedIds);
		if (!step) {
			droppedSteps.push(originalStep);
			continue;
		}
		trackMappedNodeIds(step, localChanges[index]!.before, remoteDocument, localCreatedIds, localDeletedIds);
		step = mergeMappedAttributes(step, localChanges[index]!.before, remoteDocument, attributes);
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
		throw new DocumentRebaseError('The rebased document transaction is not valid after the remote change', { cause: error });
	}
}

type HistoricalInsertionOrder = 'before' | 'after';

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
		const forward = rebaseLocalHistoryTransaction(localDocument, schema, entry.transaction, remoteAtCurrent, 'after');
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
		assertReinsertedNodesUnchanged(base, remoteApplied.document, local);
		const remoteChanges = collectTransactionChanges(base, schema, remote);
		const localCreatedIds = new Set<DocumentNodeId>();
		const localDeletedIds = new Set<DocumentNodeId>();
		const steps: DocumentStep[] = [];
		const localChanges = collectTransactionChanges(base, schema, local);
		const attributes = new Map<string, DocumentAttributes>();
		for (const [index, originalStep] of local.steps.entries()) {
			let step = mapHistoryStepThroughRemote(originalStep, remoteChanges, remoteApplied.document, localCreatedIds, insertionOrder);
			if (!step) return undefined;
			trackMappedNodeIds(step, localChanges[index]!.before, remoteApplied.document, localCreatedIds, localDeletedIds);
			step = mergeMappedAttributes(step, localChanges[index]!.before, remoteApplied.document, attributes);
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
		mapped = mapReviewAnchor(mapped, change, localCreatedIds);
		if (mapped.kind === 'replaceText') {
			mapped = mapHistoryReplaceTextThroughRemote(mapped, [change], remoteDocument, insertionOrder, localCreatedIds);
			if (!mapped) return undefined;
			continue;
		}
		if (mapped.kind === 'insertNode') {
			if (!isNodeAvailable(remoteDocument, mapped.parentId, localCreatedIds)) return undefined;
			mapped = { ...mapped, index: mapHistoryChildIndex(mapped.parentId, mapped.index, change, insertionOrder) };
			continue;
		}
		if (mapped.kind === 'moveNode') {
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
		if (remote.kind !== 'replaceText' || remote.nodeId !== mapped.nodeId) continue;
		const textNode = findDocumentNode(remoteDocument, mapped.nodeId)?.node;
		if (!textNode || textNode.text === undefined) throw new DocumentRebaseError(`History text node '${mapped.nodeId}' no longer exists`);
		const fromBias = mapped.from === mapped.to ? insertionOrder === 'before' ? 'backward' : 'forward' : 'forward';
		const from = mapTextOffset(mapped.from, remote, fromBias);
		const to = mapTextOffset(mapped.to, remote, mapped.from === mapped.to ? fromBias : 'backward');
		mapped = { ...mapped, from: Math.max(0, Math.min(textNode.text.length, from)), to: Math.max(0, Math.min(textNode.text.length, Math.max(from, to))) };
		if (step.from !== step.to && mapped.from === mapped.to) return undefined;
	}
	return mapped;
}

function mapHistoryChildIndex(parentId: DocumentNodeId, index: number, change: RemoteChange, insertionOrder: HistoricalInsertionOrder): number {
	const step = change.step;
	if (step.kind === 'insertNode' && step.parentId === parentId) return step.index < index || (step.index === index && insertionOrder === 'after') ? index + 1 : index;
	if (step.kind === 'deleteNode') {
		const location = findDocumentNode(change.before, step.nodeId);
		return location?.parent?.id === parentId && location.index < index ? index - 1 : index;
	}
	if (step.kind !== 'moveNode') return index;
	const location = findDocumentNode(change.before, step.nodeId);
	let mapped = index;
	if (location?.parent?.id === parentId && location.index < mapped) mapped -= 1;
	if (step.parentId === parentId && (step.index < mapped || (step.index === mapped && insertionOrder === 'after'))) mapped += 1;
	return mapped;
}

function historicalInsertionOrder(document: DocumentNode, remote: DocumentTransaction, inverse: DocumentTransaction): HistoricalInsertionOrder {
	for (const inverseStep of inverse.steps) {
		for (const remoteStep of remote.steps) {
			if (inverseStep.kind === 'replaceText' && remoteStep.kind === 'replaceText' && remoteStep.nodeId === inverseStep.nodeId && remoteStep.from === remoteStep.to) {
				if (remoteStep.from === inverseStep.to) return 'before';
				if (remoteStep.from === inverseStep.from) return 'after';
			}
			if (inverseStep.kind === 'deleteNode' && remoteStep.kind === 'insertNode') {
				const location = findDocumentNode(document, inverseStep.nodeId);
				if (location?.parent?.id !== remoteStep.parentId) continue;
				if (remoteStep.index === location.index + 1) return 'before';
				if (remoteStep.index === location.index) return 'after';
			}
		}
	}
	return 'after';
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

/** Structural rewrites carry snapshots, so they cannot safely replay a peer's changed node. */
function assertReinsertedNodesUnchanged(base: DocumentNode, remote: DocumentNode, local: DocumentTransaction): void {
	const deleted = new Set<DocumentNodeId>();
	for (const step of local.steps) {
		if (step.kind === 'deleteNode') {
			const node = findDocumentNode(base, step.nodeId)?.node;
			if (node) for (const id of collectDocumentNodeIds(node)) deleted.add(id);
		} else if (step.kind === 'insertNode') {
			for (const id of collectDocumentNodeIds(step.node)) {
				if (!deleted.has(id)) continue;
				const previous = findDocumentNode(base, id)?.node;
				const current = findDocumentNode(remote, id)?.node;
				if (current && JSON.stringify(previous) !== JSON.stringify(current)) throw new DocumentRebaseError(localize('document.collaboration.structuralConflict', "Cannot merge a structural replacement because another collaborator changed node '{0}'. Your local edits have been retained.", id));
			}
		}
	}
}

function collectTransactionChanges(base: DocumentNode, schema: DocumentSchema, transaction: DocumentTransaction): readonly RemoteChange[] {
	const changes: RemoteChange[] = [];
	applyDocumentTransaction(base, schema, transaction).mapping.forEachStep((before, after, step) => changes.push({ before, after, step }));
	return changes;
}

/** Atomic marked-run replacement may delete and reinsert the same identity. */
function trackMappedNodeIds(step: DocumentStep, before: DocumentNode, remote: DocumentNode, created: Set<DocumentNodeId>, deleted: Set<DocumentNodeId>): void {
	if (step.kind === 'deleteNode') {
		const node = findDocumentNode(before, step.nodeId)?.node;
		if (node) {
			for (const id of collectDocumentNodeIds(node)) {
				deleted.add(id);
				created.delete(id);
			}
		}
	} else if (step.kind === 'insertNode') {
		for (const id of collectDocumentNodeIds(step.node)) {
			if (created.has(id) || (findDocumentNode(remote, id) && !deleted.has(id))) throw new DocumentRebaseError(`Local node id '${id}' collides with the remote document`);
			created.add(id);
			deleted.delete(id);
		}
	}
}

/** Merge only authored attribute changes, retaining unrelated remote formatting and definitions. */
function mergeMappedAttributes(step: DocumentStep, before: DocumentNode, remote: DocumentNode, attributes: Map<string, DocumentAttributes>): DocumentStep {
	if (step.kind !== 'setNodeAttributes' && step.kind !== 'setNodeType') return step;
	const previous = findDocumentNode(before, step.nodeId)?.node.attrs ?? {};
	const current = attributes.get(step.nodeId) ?? findDocumentNode(remote, step.nodeId)?.node.attrs ?? previous;
	const merged = { ...current };
	for (const key of new Set([...Object.keys(previous), ...Object.keys(step.attrs)])) {
		if (previous[key] === step.attrs[key]) continue;
		if (step.nodeId === before.id && key === 'paragraphStyles') {
			// Definitions have stable ids. Independent creations/updates can coexist,
			// while server order resolves edits to the same definition.
			const parse = (value: DocumentAttributes[string] | undefined): readonly { readonly id: string; }[] => value === undefined ? [] : JSON.parse(String(value));
			const oldStyles = new Map(parse(previous[key]).map(style => [style.id, style]));
			const localStyles = new Map(parse(step.attrs[key]).map(style => [style.id, style]));
			const result = new Map(parse(current[key]).map(style => [style.id, style]));
			for (const id of new Set([...oldStyles.keys(), ...localStyles.keys()])) {
				if (JSON.stringify(oldStyles.get(id)) === JSON.stringify(localStyles.get(id))) continue;
				const style = localStyles.get(id);
				if (style) result.set(id, style); else result.delete(id);
			}
			if (result.size || step.attrs[key] !== undefined) merged[key] = JSON.stringify([...result.values()]);
			else delete merged[key];
		} else if (step.attrs[key] === undefined) delete merged[key];
		else merged[key] = step.attrs[key]!;
	}
	attributes.set(step.nodeId, merged);
	return { ...step, attrs: merged };
}

function mapStepThroughRemote(step: DocumentStep, changes: readonly RemoteChange[], remoteDocument: DocumentNode, localCreatedIds: ReadonlySet<DocumentNodeId>): DocumentStep | undefined {
	let mapped: DocumentStep | undefined = step;
	for (const change of changes) {
		if (!mapped) return undefined;
		mapped = mapStepThroughChange(mapReviewAnchor(mapped, change, localCreatedIds), change, remoteDocument, localCreatedIds);
	}
	return mapped;
}

function mapStepThroughChange(step: DocumentStep, change: RemoteChange, remoteDocument: DocumentNode, localCreatedIds: ReadonlySet<DocumentNodeId>): DocumentStep | undefined {
	if (step.kind === 'replaceText') return mapReplaceTextStep(step, change, remoteDocument, localCreatedIds);
	if (step.kind === 'insertNode') {
		if (!isNodeAvailable(remoteDocument, step.parentId, localCreatedIds)) return undefined;
		return { ...step, index: mapChildIndex(step.parentId, step.index, change) };
	}
	if (step.kind === 'moveNode') {
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
	if (remoteStep.kind !== 'replaceText' || remoteStep.nodeId !== step.nodeId) return step;
	const textNode = findDocumentNode(remoteDocument, step.nodeId)?.node;
	if (!textNode || textNode.text === undefined) return undefined;
	const from = mapTextOffset(step.from, remoteStep, 'backward');
	const to = mapTextOffset(step.to, remoteStep, 'forward');
	return { ...step, from: Math.max(0, Math.min(textNode.text.length, from)), to: Math.max(0, Math.min(textNode.text.length, Math.max(from, to))) };
}

function mapTextOffset(offset: number, remote: ReplaceTextStep, bias: 'backward' | 'forward'): number {
	const insertedLength = normalizeText(remote.text).length;
	const change = insertedLength - (remote.to - remote.from);
	if (offset < remote.from || (offset === remote.from && bias === 'backward')) return offset;
	if (offset > remote.to || (offset === remote.to && bias === 'forward')) return offset + change;
	return bias === 'backward' ? remote.from : remote.from + insertedLength;
}

function mapChildIndex(parentId: DocumentNodeId, index: number, change: RemoteChange): number {
	const step = change.step;
	if (step.kind === 'insertNode' && step.parentId === parentId && step.index <= index) return index + 1;
	if (step.kind === 'deleteNode') {
		const location = findDocumentNode(change.before, step.nodeId);
		if (location?.parent?.id === parentId && location.index < index) return index - 1;
		return index;
	}
	if (step.kind !== 'moveNode') return index;
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
	if (original.kind === 'all') return original;
	if (original.kind === 'node') {
		if (findDocumentNode(document, original.nodeId)) return nodeSelection(original.nodeId);
		return mapped && isDocumentSelectionValid(document, mapped) ? mapped : undefined;
	}
	const mappedText = mapped?.kind === 'text' ? mapped : undefined;
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
	return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

/** A comment created before a peer edit must travel through the same position mapping as selections. */
function mapReviewAnchor(step: DocumentStep, change: RemoteChange, created: ReadonlySet<DocumentNodeId>): DocumentStep {
	const node = step.kind === 'insertNode' ? step.node : undefined;
	const attrs = node?.type === 'reviewComment' ? node.attrs : (step.kind === 'setNodeAttributes' && findDocumentNode(change.before, step.nodeId)?.node.type === 'reviewComment') ? step.attrs : undefined;
	if (!attrs?.anchor) return step;
	const selection = JSON.parse(String(attrs.anchor)) as Extract<DocumentSelection, { kind: 'text'; }>;
	if (created.has(selection.anchor.nodeId) || created.has(selection.head.nodeId)) return step;
	const mapped = new DocumentTransactionMapping([change]).mapSelection(selection);
	const { anchor: _anchor, ...rest } = attrs;
	const next = { ...rest, ...(mapped ? { anchor: JSON.stringify(mapped) } : {}) };
	return step.kind === 'insertNode' ? { ...step, node: { ...step.node, attrs: next } } : step.kind === 'setNodeAttributes' ? { ...step, attrs: next } : step;
}
