import { isRecord } from "../../../base/common/types.js";
import { isFiniteNumber, isSafeInteger } from "../../../base/common/numbers.js";
import type { DocumentAttributes, DocumentMark, DocumentNode } from "./document.js";
import { decodeDocumentNode, DocumentSerializationError, encodeDocumentNode, type SerializedDocumentNode } from "./documentSerialization.js";
import { type DocumentSchema } from "./documentSchema.js";
import { allSelection, nodeSelection, textSelection, type DocumentPoint, type DocumentSelection } from "../core/documentSelection.js";
import { DocumentTransaction, type DocumentStep, type DocumentTransactionMetaEntry, type DocumentTransactionOptions } from "./documentTransaction.js";

export const DOCUMENT_TRANSACTION_SERIALIZATION_FORMAT = "ash.document.transaction";
export const DOCUMENT_TRANSACTION_SERIALIZATION_VERSION = 1;

export type SerializedDocumentStep =
	| { readonly kind: "replaceText"; readonly nodeId: string; readonly from: number; readonly to: number; readonly text: string; readonly marks?: readonly DocumentMark[] }
	| { readonly kind: "insertNode"; readonly parentId: string; readonly index: number; readonly node: SerializedDocumentNode }
	| { readonly kind: "deleteNode"; readonly nodeId: string }
	| { readonly kind: "moveNode"; readonly nodeId: string; readonly parentId: string; readonly index: number }
	| { readonly kind: "setNodeAttributes"; readonly nodeId: string; readonly attrs: DocumentAttributes }
	| { readonly kind: "setNodeMarks"; readonly nodeId: string; readonly marks: readonly DocumentMark[] }
	| { readonly kind: "setNodeType"; readonly nodeId: string; readonly type: string; readonly attrs: DocumentAttributes };

export type SerializedDocumentSelection =
	| { readonly kind: "all" }
	| { readonly kind: "node"; readonly nodeId: string }
	| { readonly kind: "text"; readonly anchor: DocumentPoint; readonly head: DocumentPoint };

export interface SerializedDocumentTransaction {
	readonly format: typeof DOCUMENT_TRANSACTION_SERIALIZATION_FORMAT;
	readonly version: typeof DOCUMENT_TRANSACTION_SERIALIZATION_VERSION;
	readonly transaction: {
		readonly steps: readonly SerializedDocumentStep[];
		readonly addToHistory: boolean;
		readonly label?: string;
		readonly selection?: SerializedDocumentSelection;
		readonly selectionSet: boolean;
		readonly storedMarks?: readonly DocumentMark[];
		readonly storedMarksSet: boolean;
		readonly historyGroup?: string;
		readonly metadata: readonly { readonly key: string; readonly value: JsonValue }[];
	};
}

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Serializes a Stanza transaction into a versioned, JSON-safe transport envelope. */
export function serializeDocumentTransaction(transaction: DocumentTransaction, schema: DocumentSchema): string {
	const metadata = transaction.metadata.map(entry => {
		if (typeof entry.key !== "string") throw new DocumentSerializationError("Document transaction metadata symbols cannot be serialized");
		return { key: entry.key, value: normalizeJsonValue(entry.value) };
	});
	const payload: SerializedDocumentTransaction = {
		format: DOCUMENT_TRANSACTION_SERIALIZATION_FORMAT,
		version: DOCUMENT_TRANSACTION_SERIALIZATION_VERSION,
		transaction: {
			steps: transaction.steps.map(step => encodeStep(step, schema)),
			addToHistory: transaction.addToHistory,
			selectionSet: transaction.selectionSet,
			storedMarksSet: transaction.storedMarksSet,
			metadata,
			...(transaction.label === undefined ? {} : { label: transaction.label }),
			...(transaction.selection === undefined ? {} : { selection: encodeSelection(transaction.selection) }),
			...(transaction.storedMarks === undefined ? {} : { storedMarks: cloneMarks(transaction.storedMarks) }),
			...(transaction.historyGroup === undefined ? {} : { historyGroup: transaction.historyGroup }),
		},
	};
	return JSON.stringify(payload);
}

/** Parses and validates a versioned Stanza transaction transport envelope. */
export function deserializeDocumentTransaction(value: string | unknown, schema: DocumentSchema): DocumentTransaction {
	let parsed: unknown = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value) as unknown;
		} catch (error) {
			throw new DocumentSerializationError("Document transaction JSON is invalid", { cause: error });
		}
	}
	try {
		if (!isRecord(parsed) || parsed.format !== DOCUMENT_TRANSACTION_SERIALIZATION_FORMAT || parsed.version !== DOCUMENT_TRANSACTION_SERIALIZATION_VERSION || !isRecord(parsed.transaction)) throw new DocumentSerializationError("Unsupported document transaction format or version");
		const body = parsed.transaction;
		if (!Array.isArray(body.steps)) throw new DocumentSerializationError("Document transaction steps must be an array");
		const selection = body.selection === undefined ? undefined : decodeSelection(body.selection);
		const options: DocumentTransactionOptions = {
			addToHistory: requireBoolean(body.addToHistory, "addToHistory"),
			selectionSet: requireBoolean(body.selectionSet, "selectionSet"),
			storedMarksSet: requireBoolean(body.storedMarksSet, "storedMarksSet"),
			metadata: decodeMetadata(body.metadata),
			...(body.label === undefined ? {} : { label: requireString(body.label, "label") }),
			...(selection === undefined ? {} : { selection }),
			...(body.storedMarks === undefined ? {} : { storedMarks: decodeMarks(body.storedMarks) }),
			...(body.historyGroup === undefined ? {} : { historyGroup: requireString(body.historyGroup, "historyGroup") }),
		};
		return new DocumentTransaction(body.steps.map(step => decodeStep(step, schema)), options);
	} catch (error) {
		if (error instanceof DocumentSerializationError) throw error;
		throw new DocumentSerializationError("Document transaction failed validation", { cause: error });
	}
}

function encodeStep(step: DocumentStep, schema: DocumentSchema): SerializedDocumentStep {
	switch (step.kind) {
		case "replaceText": return { kind: step.kind, nodeId: step.nodeId, from: step.from, to: step.to, text: step.text, ...(step.marks === undefined ? {} : { marks: cloneMarks(step.marks) }) };
		case "insertNode": return { kind: step.kind, parentId: step.parentId, index: step.index, node: encodeDocumentNode(step.node, schema, { allowIncompleteContent: true }) };
		case "deleteNode": return { kind: step.kind, nodeId: step.nodeId };
		case "moveNode": return { kind: step.kind, nodeId: step.nodeId, parentId: step.parentId, index: step.index };
		case "setNodeAttributes": return { kind: step.kind, nodeId: step.nodeId, attrs: { ...step.attrs } };
		case "setNodeMarks": return { kind: step.kind, nodeId: step.nodeId, marks: cloneMarks(step.marks) };
		case "setNodeType": return { kind: step.kind, nodeId: step.nodeId, type: step.type, attrs: { ...step.attrs } };
	}
}

function decodeStep(value: unknown, schema: DocumentSchema): DocumentStep {
	if (!isRecord(value)) throw new DocumentSerializationError("Document transaction step is invalid");
	const kind = requireString(value.kind, "step.kind");
	switch (kind) {
		case "replaceText": return { kind, nodeId: requireString(value.nodeId, "step.nodeId"), from: requireInteger(value.from, "step.from"), to: requireInteger(value.to, "step.to"), text: requireString(value.text, "step.text"), ...(value.marks === undefined ? {} : { marks: decodeMarks(value.marks) }) };
		case "insertNode": return { kind, parentId: requireString(value.parentId, "step.parentId"), index: requireInteger(value.index, "step.index"), node: decodeDocumentNode(value.node, schema, { allowIncompleteContent: true }) };
		case "deleteNode": return { kind, nodeId: requireString(value.nodeId, "step.nodeId") };
		case "moveNode": return { kind, nodeId: requireString(value.nodeId, "step.nodeId"), parentId: requireString(value.parentId, "step.parentId"), index: requireInteger(value.index, "step.index") };
		case "setNodeAttributes": return { kind, nodeId: requireString(value.nodeId, "step.nodeId"), attrs: decodeAttributes(value.attrs, "step.attrs") };
		case "setNodeMarks": return { kind, nodeId: requireString(value.nodeId, "step.nodeId"), marks: decodeMarks(value.marks) };
		case "setNodeType": return { kind, nodeId: requireString(value.nodeId, "step.nodeId"), type: requireString(value.type, "step.type"), attrs: decodeAttributes(value.attrs, "step.attrs") };
		default: throw new DocumentSerializationError(`Unknown document transaction step '${kind}'`);
	}
}

function encodeSelection(selection: DocumentSelection): SerializedDocumentSelection {
	switch (selection.kind) {
		case "all": return { kind: "all" };
		case "node": return { kind: "node", nodeId: selection.nodeId };
		case "text": return { kind: "text", anchor: { ...selection.anchor }, head: { ...selection.head } };
	}
}

function decodeSelection(value: unknown): DocumentSelection {
	if (!isRecord(value)) throw new DocumentSerializationError("Document transaction selection is invalid");
	const kind = requireString(value.kind, "selection.kind");
	switch (kind) {
		case "all": return allSelection();
		case "node": return nodeSelection(requireString(value.nodeId, "selection.nodeId"));
		case "text": return textSelection(decodePoint(value.anchor, "selection.anchor"), decodePoint(value.head, "selection.head"));
		default: throw new DocumentSerializationError(`Unknown document selection '${kind}'`);
	}
}

function decodePoint(value: unknown, name: string): DocumentPoint {
	if (!isRecord(value)) throw new DocumentSerializationError(`${name} must be an object`);
	return { nodeId: requireString(value.nodeId, `${name}.nodeId`), offset: requireInteger(value.offset, `${name}.offset`) };
}

function decodeMetadata(value: unknown): readonly DocumentTransactionMetaEntry[] {
	if (!Array.isArray(value)) throw new DocumentSerializationError("Document transaction metadata must be an array");
	return value.map((entry, index) => {
		if (!isRecord(entry)) throw new DocumentSerializationError(`Document transaction metadata entry ${index} is invalid`);
		return { key: requireString(entry.key, `metadata[${index}].key`), value: entry.value };
	});
}

function decodeMarks(value: unknown): readonly DocumentMark[] {
	if (!Array.isArray(value)) throw new DocumentSerializationError("Document marks must be an array");
	return value.map((mark, index) => {
		if (!isRecord(mark)) throw new DocumentSerializationError(`Document mark ${index} is invalid`);
		return { type: requireString(mark.type, `mark[${index}].type`), attrs: decodeAttributes(mark.attrs, `mark[${index}].attrs`) };
	});
}

function cloneMarks(marks: readonly DocumentMark[]): readonly DocumentMark[] {
	return marks.map(mark => ({ type: mark.type, attrs: { ...mark.attrs } }));
}

function decodeAttributes(value: unknown, name: string): DocumentAttributes {
	if (!isRecord(value)) throw new DocumentSerializationError(`${name} must be an object`);
	const attrs: Record<string, string | number | boolean | null> = {};
	for (const [key, attribute] of Object.entries(value)) {
		if (!/^[a-z][a-zA-Z0-9_-]*$/.test(key)) throw new DocumentSerializationError(`${name} contains an invalid attribute '${key}'`);
		if (attribute !== null && typeof attribute !== "string" && typeof attribute !== "boolean" && !isFiniteNumber(attribute)) throw new DocumentSerializationError(`${name}.${key} is not a document attribute value`);
		attrs[key] = attribute;
	}
	return attrs;
}

function normalizeJsonValue(value: unknown, seen = new Set<object>()): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (isFiniteNumber(value)) return value;
	if (Array.isArray(value)) {
		if (seen.has(value)) throw new DocumentSerializationError("Document transaction metadata cannot contain cycles");
		seen.add(value);
		const result = value.map(item => normalizeJsonValue(item, seen));
		seen.delete(value);
		return result;
	}
	if (typeof value === "object") {
		if (seen.has(value)) throw new DocumentSerializationError("Document transaction metadata cannot contain cycles");
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new DocumentSerializationError("Document transaction metadata must contain JSON objects");
		seen.add(value);
		const result: Record<string, JsonValue> = {};
		for (const [key, item] of Object.entries(value)) result[key] = normalizeJsonValue(item, seen);
		seen.delete(value);
		return result;
	}
	throw new DocumentSerializationError("Document transaction metadata must contain JSON values");
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) throw new DocumentSerializationError(`${name} must be a non-empty string`);
	return value;
}

function requireInteger(value: unknown, name: string): number {
	if (!isSafeInteger(value)) throw new DocumentSerializationError(`${name} must be a safe integer`);
	return value as number;
}

function requireBoolean(value: unknown, name: string): boolean {
	if (typeof value !== "boolean") throw new DocumentSerializationError(`${name} must be a boolean`);
	return value;
}
