import { collectDocumentNodeIds, containsDocumentNode, createDocumentNode, findDocumentNode, freezeDocumentNode, insertDocumentNode, removeDocumentNode, replaceDocumentNode, type DocumentAttributes, type DocumentMark, type DocumentNode, type DocumentNodeId } from "./document.js";
import { type DocumentSchema } from "./documentSchema.js";
import { nodeSelection, textSelection, type DocumentPoint, type DocumentSelection } from "../core/documentSelection.js";

export type DocumentStep = ReplaceTextStep | InsertNodeStep | DeleteNodeStep | MoveNodeStep | SetNodeAttributesStep | SetNodeMarksStep | SetNodeTypeStep;

export interface ReplaceTextStep {
	readonly kind: "replaceText";
	readonly nodeId: DocumentNodeId;
	readonly from: number;
	readonly to: number;
	readonly text: string;
	readonly marks?: readonly DocumentMark[];
}

export interface InsertNodeStep {
	readonly kind: "insertNode";
	readonly parentId: DocumentNodeId;
	readonly index: number;
	readonly node: DocumentNode;
}

export interface DeleteNodeStep {
	readonly kind: "deleteNode";
	readonly nodeId: DocumentNodeId;
}

export interface MoveNodeStep {
	readonly kind: "moveNode";
	readonly nodeId: DocumentNodeId;
	readonly parentId: DocumentNodeId;
	readonly index: number;
}

export interface SetNodeAttributesStep {
	readonly kind: "setNodeAttributes";
	readonly nodeId: DocumentNodeId;
	readonly attrs: DocumentAttributes;
}

export interface SetNodeMarksStep {
	readonly kind: "setNodeMarks";
	readonly nodeId: DocumentNodeId;
	readonly marks: readonly DocumentMark[];
}

export interface SetNodeTypeStep {
	readonly kind: "setNodeType";
	readonly nodeId: DocumentNodeId;
	readonly type: string;
	readonly attrs: DocumentAttributes;
}

export type DocumentTransactionMetaKey = string | symbol;

export interface DocumentTransactionMetaEntry {
	readonly key: DocumentTransactionMetaKey;
	readonly value: unknown;
}

export interface DocumentTransactionOptions {
	readonly addToHistory?: boolean;
	readonly label?: string;
	readonly selection?: DocumentSelection;
	readonly selectionSet?: boolean;
	readonly storedMarks?: readonly DocumentMark[];
	readonly storedMarksSet?: boolean;
	readonly historyGroup?: string;
	readonly metadata?: readonly DocumentTransactionMetaEntry[];
}

/** Immutable batch of schema-backed Block steps applied atomically by TextModel. */
export class DocumentTransaction {
	readonly steps: readonly DocumentStep[];
	readonly addToHistory: boolean;
	readonly label: string | undefined;
	readonly selection: DocumentSelection | undefined;
	readonly selectionSet: boolean;
	readonly storedMarks: readonly DocumentMark[] | undefined;
	readonly storedMarksSet: boolean;
	readonly historyGroup: string | undefined;
	readonly metadata: readonly DocumentTransactionMetaEntry[];

	constructor(steps: readonly DocumentStep[] = [], options: DocumentTransactionOptions = {}) {
		this.steps = Object.freeze(steps.map(cloneStep));
		this.addToHistory = options.addToHistory ?? true;
		this.label = options.label;
		this.selection = options.selection;
		this.selectionSet = options.selectionSet ?? options.selection !== undefined;
		this.storedMarks = options.storedMarks === undefined ? undefined : cloneMarks(options.storedMarks);
		this.storedMarksSet = options.storedMarksSet ?? options.storedMarks !== undefined;
		if (options.historyGroup !== undefined && (typeof options.historyGroup !== "string" || options.historyGroup.length === 0)) throw new TypeError("Document history group must be a non-empty string");
		this.historyGroup = options.historyGroup;
		this.metadata = Object.freeze(normalizeMetadata(options.metadata));
	}

	replaceText(nodeId: DocumentNodeId, from: number, to: number, text: string, marks?: readonly DocumentMark[]): DocumentTransaction {
		return this.append({ kind: "replaceText", nodeId, from, to, text, ...(marks === undefined ? {} : { marks }) });
	}

	insertNode(parentId: DocumentNodeId, index: number, node: DocumentNode): DocumentTransaction {
		return this.append({ kind: "insertNode", parentId, index, node });
	}

	deleteNode(nodeId: DocumentNodeId): DocumentTransaction {
		return this.append({ kind: "deleteNode", nodeId });
	}

	moveNode(nodeId: DocumentNodeId, parentId: DocumentNodeId, index: number): DocumentTransaction {
		return this.append({ kind: "moveNode", nodeId, parentId, index });
	}

	setNodeAttributes(nodeId: DocumentNodeId, attrs: DocumentAttributes): DocumentTransaction {
		return this.append({ kind: "setNodeAttributes", nodeId, attrs });
	}

	setNodeMarks(nodeId: DocumentNodeId, marks: readonly DocumentMark[]): DocumentTransaction {
		return this.append({ kind: "setNodeMarks", nodeId, marks });
	}

	setNodeType(nodeId: DocumentNodeId, type: string, attrs: DocumentAttributes = {}): DocumentTransaction {
		return this.append({ kind: "setNodeType", nodeId, type, attrs });
	}

	withSelection(selection: DocumentSelection | undefined): DocumentTransaction {
		return new DocumentTransaction(this.steps, { addToHistory: this.addToHistory, label: this.label, selection, selectionSet: true, storedMarks: this.storedMarks, storedMarksSet: this.storedMarksSet, historyGroup: this.historyGroup, metadata: this.metadata });
	}

	/** Sets or clears the marks that should be used for the next text insertion. */
	withStoredMarks(storedMarks: readonly DocumentMark[] | undefined): DocumentTransaction {
		return new DocumentTransaction(this.steps, { addToHistory: this.addToHistory, label: this.label, selection: this.selection, selectionSet: this.selectionSet, storedMarks, storedMarksSet: true, historyGroup: this.historyGroup, metadata: this.metadata });
	}

	withHistoryGroup(historyGroup: string): DocumentTransaction {
		return new DocumentTransaction(this.steps, { addToHistory: this.addToHistory, label: this.label, selection: this.selection, selectionSet: this.selectionSet, storedMarks: this.storedMarks, storedMarksSet: this.storedMarksSet, historyGroup, metadata: this.metadata });
	}

	withoutHistory(): DocumentTransaction {
		return new DocumentTransaction(this.steps, { addToHistory: false, label: this.label, selection: this.selection, selectionSet: this.selectionSet, storedMarks: this.storedMarks, storedMarksSet: this.storedMarksSet, metadata: this.metadata });
	}

	/** Returns one semantic value attached by a command or input adapter. */
	getMeta<T>(key: DocumentTransactionMetaKey): T | undefined {
		return this.metadata.find(entry => entry.key === key)?.value as T | undefined;
	}

	/** Returns a new transaction with one semantic value attached or replaced. */
	withMeta<T>(key: DocumentTransactionMetaKey, value: T): DocumentTransaction {
		validateMetaKey(key);
		return new DocumentTransaction(this.steps, { addToHistory: this.addToHistory, label: this.label, selection: this.selection, selectionSet: this.selectionSet, storedMarks: this.storedMarks, storedMarksSet: this.storedMarksSet, historyGroup: this.historyGroup, metadata: [...this.metadata.filter(entry => entry.key !== key), { key, value }] });
	}

	private append(step: DocumentStep): DocumentTransaction {
		return new DocumentTransaction([...this.steps, step], { addToHistory: this.addToHistory, label: this.label, selection: this.selection, selectionSet: this.selectionSet, storedMarks: this.storedMarks, storedMarksSet: this.storedMarksSet, historyGroup: this.historyGroup, metadata: this.metadata });
	}
}

export interface AppliedDocumentTransaction {
	readonly document: DocumentNode;
	readonly inverse: DocumentTransaction;
	/** Selection mapped through every step when one was supplied to the apply call. */
	readonly selection: DocumentSelection | undefined;
	/** Reusable identity-based mapping for selections and decoration ranges. */
	readonly mapping: DocumentTransactionMapping;
}

interface DocumentStepMapping {
	readonly before: DocumentNode;
	readonly after: DocumentNode;
	readonly step: DocumentStep;
}

/** Maps identity-based ranges through one applied transaction without reapplying its steps. */
export class DocumentTransactionMapping {
	private readonly entries: readonly DocumentStepMapping[];

	constructor(entries: readonly DocumentStepMapping[] = []) {
		this.entries = Object.freeze(entries.map(entry => Object.freeze(entry)));
	}

	mapSelection(selection: DocumentSelection | undefined): DocumentSelection | undefined {
		let mapped = selection;
		for (const entry of this.entries) mapped = mapDocumentSelectionThroughStep(mapped, entry.before, entry.after, entry.step);
		return mapped;
	}
}

/** Applies a transaction immutably and calculates an inverse for undo. */
export function applyDocumentTransaction(
	document: DocumentNode,
	schema: DocumentSchema,
	transaction: DocumentTransaction,
	selection?: DocumentSelection,
): AppliedDocumentTransaction {
	schema.validate(document);
	let current = document;
	let mappedSelection = selection;
	const inverse: DocumentStep[] = [];
	const mapping: DocumentStepMapping[] = [];
	for (const step of transaction.steps) {
		const previous = current;
		switch (step.kind) {
			case "replaceText":
				applyReplaceText(step, schema, current, result => {
					current = result.document;
					inverse.unshift(result.inverse);
				});
				break;
			case "insertNode":
				{
					const node = freezeDocumentNode(step.node);
					schema.validateFragment(node, { allowIncompleteContent: true });
					if (hasAnyNodeId(current, node)) throw new Error(`Inserted node '${node.id}' duplicates an existing node id`);
					current = insertDocumentNode(current, step.parentId, step.index, node);
					inverse.unshift({ kind: "deleteNode", nodeId: node.id });
				}
				break;
			case "deleteNode": {
				const removed = removeDocumentNode(current, step.nodeId);
				current = removed.document;
				inverse.unshift({ kind: "insertNode", parentId: removed.parentId, index: removed.index, node: removed.removed });
				break;
			}
			case "moveNode": {
				const location = findDocumentNode(current, step.nodeId);
				if (!location || !location.parent) throw new RangeError(`Document node '${step.nodeId}' does not exist or is the root`);
				if (containsDocumentNode(location.node, step.parentId)) throw new RangeError("A document node cannot be moved into its own subtree");
				const removed = removeDocumentNode(current, step.nodeId);
				current = insertDocumentNode(removed.document, step.parentId, step.index, removed.removed);
				inverse.unshift({ kind: "moveNode", nodeId: step.nodeId, parentId: removed.parentId, index: removed.index });
				break;
			}
			case "setNodeAttributes": {
				const location = findDocumentNode(current, step.nodeId);
				if (!location) throw new RangeError(`Document node '${step.nodeId}' does not exist`);
				const replacement = createDocumentNode({ id: location.node.id, type: location.node.type, attrs: step.attrs, content: location.node.content, marks: location.node.marks, ...(location.node.text === undefined ? {} : { text: location.node.text }) });
				current = replaceDocumentNode(current, step.nodeId, replacement);
				inverse.unshift({ kind: "setNodeAttributes", nodeId: step.nodeId, attrs: location.node.attrs });
				break;
			}
			case "setNodeMarks": {
				const location = findDocumentNode(current, step.nodeId);
				if (!location || location.node.text === undefined) throw new RangeError(`Document node '${step.nodeId}' is not a text node`);
				const replacement = createDocumentNode({ id: location.node.id, type: location.node.type, attrs: location.node.attrs, content: location.node.content, marks: step.marks, text: location.node.text });
				current = replaceDocumentNode(current, step.nodeId, replacement);
				inverse.unshift({ kind: "setNodeMarks", nodeId: step.nodeId, marks: location.node.marks });
				break;
			}
			case "setNodeType": {
				const location = findDocumentNode(current, step.nodeId);
				if (!location) throw new RangeError(`Document node '${step.nodeId}' does not exist`);
				const replacement = createDocumentNode({ id: location.node.id, type: step.type, attrs: step.attrs, content: location.node.content, marks: location.node.marks, ...(location.node.text === undefined ? {} : { text: location.node.text }) });
				current = replaceDocumentNode(current, step.nodeId, replacement);
				inverse.unshift({ kind: "setNodeType", nodeId: step.nodeId, type: location.node.type, attrs: location.node.attrs });
				break;
			}
		}
		mappedSelection = mapDocumentSelectionThroughStep(mappedSelection, previous, current, step);
		mapping.push({ before: previous, after: current, step });
	}
	schema.validate(current);
	return Object.freeze({ document: current, inverse: new DocumentTransaction(inverse, { addToHistory: false, label: transaction.label }), selection: mappedSelection, mapping: new DocumentTransactionMapping(mapping) });
}

/** Maps an identity-based selection through one already-applied document step. */
function mapDocumentSelectionThroughStep(selection: DocumentSelection | undefined, before: DocumentNode, after: DocumentNode, step: DocumentStep): DocumentSelection | undefined {
	if (!selection) return undefined;
	if (selection.kind === "all") return selection;
	if (selection.kind === "node") return findDocumentNode(after, selection.nodeId) ? nodeSelection(selection.nodeId) : undefined;
	const anchor = mapDocumentPoint(selection.anchor, before, after, step);
	const head = mapDocumentPoint(selection.head, before, after, step);
	return anchor && head ? textSelection(anchor, head) : undefined;
}

function mapDocumentPoint(point: DocumentPoint, before: DocumentNode, after: DocumentNode, step: DocumentStep): DocumentPoint | undefined {
	if (step.kind === "replaceText" && point.nodeId === step.nodeId) {
		const replacement = findDocumentNode(after, step.nodeId)?.node;
		if (replacement?.text !== undefined) {
			const insertedLength = normalizeText(step.text).length;
			const offset = step.from === step.to
				? point.offset < step.from ? point.offset : point.offset + insertedLength
				: point.offset <= step.from
					? point.offset
					: point.offset >= step.to
						? point.offset + insertedLength - (step.to - step.from)
						: step.from + insertedLength;
			return { nodeId: replacement.id, offset: Math.max(0, Math.min(replacement.text.length, offset)) };
		}
		return findFallbackTextPoint(before, after, step.nodeId);
	}
	if (step.kind === "deleteNode") {
		const deleted = findDocumentNode(before, step.nodeId);
		if (deleted && containsDocumentNode(deleted.node, point.nodeId)) return findFallbackTextPoint(before, after, step.nodeId);
	}
	const current = findDocumentNode(after, point.nodeId)?.node;
	if (current?.text !== undefined) return { nodeId: current.id, offset: Math.max(0, Math.min(current.text.length, point.offset)) };
	return findFallbackTextPoint(before, after, point.nodeId);
}

function findFallbackTextPoint(before: DocumentNode, after: DocumentNode, removedNodeId: DocumentNodeId): DocumentPoint | undefined {
	let location = findDocumentNode(before, removedNodeId);
	while (location?.parent) {
		const parent = findDocumentNode(after, location.parent.id)?.node;
		if (parent) {
			if (parent.content.length > 0) {
				for (let index = Math.min(location.index, parent.content.length - 1); index < parent.content.length; index += 1) {
					const point = firstTextPoint(parent.content[index]!);
					if (point) return point;
				}
				for (let index = Math.min(location.index - 1, parent.content.length - 1); index >= 0; index -= 1) {
					const point = lastTextPoint(parent.content[index]!);
					if (point) return point;
				}
			}
		}
		location = findDocumentNode(before, location.parent.id);
	}
	return firstTextPoint(after);
}

function firstTextPoint(node: DocumentNode): DocumentPoint | undefined {
	if (node.text !== undefined) return { nodeId: node.id, offset: 0 };
	for (const child of node.content) {
		const point = firstTextPoint(child);
		if (point) return point;
	}
	return undefined;
}

function lastTextPoint(node: DocumentNode): DocumentPoint | undefined {
	if (node.text !== undefined) return { nodeId: node.id, offset: node.text.length };
	for (let index = node.content.length - 1; index >= 0; index -= 1) {
		const point = lastTextPoint(node.content[index]!);
		if (point) return point;
	}
	return undefined;
}

interface AppliedReplaceText {
	readonly document: DocumentNode;
	readonly inverse: DocumentStep;
}

function applyReplaceText(
	step: ReplaceTextStep,
	schema: DocumentSchema,
	document: DocumentNode,
	callback: (result: AppliedReplaceText) => void,
): void {
	const location = findDocumentNode(document, step.nodeId);
	if (!location || location.node.text === undefined) throw new RangeError(`Document node '${step.nodeId}' is not a text node`);
	if (!Number.isSafeInteger(step.from) || !Number.isSafeInteger(step.to) || step.from < 0 || step.to < step.from || step.to > location.node.text.length) throw new RangeError(`Text replacement range must satisfy 0 <= from <= to <= ${location.node.text.length}`);
	if (typeof step.text !== "string") throw new TypeError("Text replacement must contain a string");
	const text = normalizeText(step.text);
	const replacedText = location.node.text.slice(step.from, step.to);
	const nextText = location.node.text.slice(0, step.from) + text + location.node.text.slice(step.to);
	if (nextText.length === 0) {
		if (!location.parent) throw new RangeError("The document root cannot be a text node");
		const removed = removeDocumentNode(document, step.nodeId);
		callback({ document: removed.document, inverse: { kind: "insertNode", parentId: removed.parentId, index: removed.index, node: location.node } });
		return;
	}
	const replacementMarks = step.marks ?? location.node.marks;
	const replacement = createDocumentNode({ id: location.node.id, type: location.node.type, attrs: location.node.attrs, content: location.node.content, marks: replacementMarks, text: nextText });
	callback({ document: replaceDocumentNode(document, step.nodeId, replacement), inverse: { kind: "replaceText", nodeId: step.nodeId, from: step.from, to: step.from + text.length, text: replacedText, marks: location.node.marks } });
	schema.validateFragment(replacement);
}

function hasAnyNodeId(document: DocumentNode, node: DocumentNode): boolean {
	const existing = collectDocumentNodeIds(document);
	for (const id of collectDocumentNodeIds(node)) if (existing.has(id)) return true;
	return false;
}

function cloneStep(step: DocumentStep): DocumentStep {
	switch (step.kind) {
		case "replaceText": return Object.freeze({ ...step, ...(step.marks === undefined ? {} : { marks: Object.freeze(step.marks.map(mark => Object.freeze({ type: mark.type, attrs: Object.freeze({ ...(mark.attrs ?? {}) }) }))) }) });
		case "insertNode": return Object.freeze({ ...step });
		case "deleteNode": return Object.freeze({ ...step });
		case "moveNode": return Object.freeze({ ...step });
		case "setNodeAttributes": return Object.freeze({ ...step, attrs: Object.freeze({ ...step.attrs }) });
		case "setNodeMarks": return Object.freeze({ ...step, marks: Object.freeze(step.marks.map(mark => Object.freeze({ type: mark.type, attrs: Object.freeze({ ...(mark.attrs ?? {}) }) }))) });
		case "setNodeType": return Object.freeze({ ...step, attrs: Object.freeze({ ...step.attrs }) });
	}
}

function normalizeText(text: string): string {
	return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function cloneMarks(marks: readonly DocumentMark[]): readonly DocumentMark[] {
	return Object.freeze(marks.map(mark => Object.freeze({ type: mark.type, attrs: Object.freeze({ ...(mark.attrs ?? {}) }) })));
}

function normalizeMetadata(metadata: readonly DocumentTransactionMetaEntry[] | undefined): DocumentTransactionMetaEntry[] {
	const normalized: DocumentTransactionMetaEntry[] = [];
	for (const entry of metadata ?? []) {
		validateMetaKey(entry.key);
		const index = normalized.findIndex(existing => existing.key === entry.key);
		if (index >= 0) normalized.splice(index, 1);
		normalized.push(Object.freeze({ key: entry.key, value: entry.value }));
	}
	return normalized;
}

function validateMetaKey(key: DocumentTransactionMetaKey): void {
	if ((typeof key !== "string" && typeof key !== "symbol") || (typeof key === "string" && key.length === 0)) throw new TypeError("Document transaction metadata keys require a non-empty string or symbol");
}
