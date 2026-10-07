import { type DocumentSelection } from "../core/documentSelection.js";
import { isRecord } from "../../../base/common/types.js";
import { isFiniteNumber } from "../../../base/common/numbers.js";
import { createDocumentNode, findDocumentNode, type DocumentNodeId, type DocumentAttributeValue, type DocumentAttributes, type DocumentMark, type DocumentNode } from "./document.js";
import { type DocumentSchema, type DocumentValidationOptions } from "./documentSchema.js";

export const DOCUMENT_SERIALIZATION_FORMAT = "ash.document";
export const DOCUMENT_SERIALIZATION_VERSION = 1;
export const DOCUMENT_FRAGMENT_SERIALIZATION_FORMAT = "ash.document.fragment";
export const DOCUMENT_FRAGMENT_SERIALIZATION_VERSION = 1;
export const DOCUMENT_FRAGMENT_CLIPBOARD_MIME = "application/vnd.ash.document.fragment+json";

/** JSON-safe representation of one Stanza node, including incomplete transaction fragments. */
export interface SerializedDocumentNode {
	readonly id: string;
	readonly type: string;
	readonly attrs: DocumentAttributes;
	readonly content: readonly SerializedDocumentNode[];
	readonly marks: readonly DocumentMark[];
	readonly text?: string;
}

export interface DocumentFragment {
	readonly content: readonly DocumentNode[];
}

export class DocumentSerializationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "DocumentSerializationError";
	}
}

/** Encodes a schema-valid node for transport inside a transaction or fragment. */
export function encodeDocumentNode(node: DocumentNode, schema: DocumentSchema, options: DocumentValidationOptions = {}): SerializedDocumentNode {
	try {
		schema.validateFragment(node, options);
	} catch (error) {
		throw new DocumentSerializationError("Document node failed schema validation", { cause: error });
	}
	return encodeNode(node);
}

/** Decodes and validates one untrusted node value from a Stanza transport payload. */
export function decodeDocumentNode(value: unknown, schema: DocumentSchema, options: DocumentValidationOptions = {}): DocumentNode {
	try {
		const node = decodeNode(value);
		schema.validateFragment(node, options);
		return node;
	} catch (error) {
		if (error instanceof DocumentSerializationError) throw error;
		throw new DocumentSerializationError("Document node failed schema validation", { cause: error });
	}
}

/** Serializes a validated document in a versioned envelope for persistence. */
export function serializeDocument(document: DocumentNode, schema: DocumentSchema, pretty = false): string {
	schema.validate(document);
	return JSON.stringify({ format: DOCUMENT_SERIALIZATION_FORMAT, version: DOCUMENT_SERIALIZATION_VERSION, document }, undefined, pretty ? 2 : undefined);
}

/** Parses, validates, and freezes a persisted document without trusting its JSON shape. */
export function deserializeDocument(value: string | unknown, schema: DocumentSchema): DocumentNode {
	let parsed: unknown = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value) as unknown;
		} catch (error) {
			throw new DocumentSerializationError("Structured document JSON is invalid", { cause: error });
		}
	}
	if (!isRecord(parsed) || parsed.format !== DOCUMENT_SERIALIZATION_FORMAT || parsed.version !== DOCUMENT_SERIALIZATION_VERSION) throw new DocumentSerializationError("Unsupported structured document format or version");
	try {
		const document = decodeNode(parsed.document);
		schema.validate(document);
		return document;
	} catch (error) {
		if (error instanceof DocumentSerializationError) throw error;
		throw new DocumentSerializationError("Structured document failed schema validation", { cause: error });
	}
}

/** Serializes a validated selection fragment for Stanza-aware clipboard transport. */
export function serializeDocumentFragment(fragment: DocumentFragment, schema: DocumentSchema, pretty = false): string {
	validateFragmentContent(fragment.content, schema);
	return JSON.stringify({ format: DOCUMENT_FRAGMENT_SERIALIZATION_FORMAT, version: DOCUMENT_FRAGMENT_SERIALIZATION_VERSION, content: fragment.content }, undefined, pretty ? 2 : undefined);
}

/** Parses and validates a Stanza clipboard fragment without trusting its JSON shape. */
export function deserializeDocumentFragment(value: string | unknown, schema: DocumentSchema): DocumentFragment {
	let parsed: unknown = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value) as unknown;
		} catch (error) {
			throw new DocumentSerializationError("Structured document fragment JSON is invalid", { cause: error });
		}
	}
	if (!isRecord(parsed) || parsed.format !== DOCUMENT_FRAGMENT_SERIALIZATION_FORMAT || parsed.version !== DOCUMENT_FRAGMENT_SERIALIZATION_VERSION || !Array.isArray(parsed.content)) throw new DocumentSerializationError("Unsupported structured document fragment format or version");
	try {
		const content = Object.freeze(parsed.content.map(decodeNode));
		validateFragmentContent(content, schema);
		return Object.freeze({ content });
	} catch (error) {
		if (error instanceof DocumentSerializationError) throw error;
		throw new DocumentSerializationError("Structured document fragment failed schema validation", { cause: error });
	}
}

/** Converts plain text into a schema-valid paragraph document. */
export function documentFromPlainText(schema: DocumentSchema, text: string, documentId = "document-1"): DocumentNode {
	if (typeof text !== "string") throw new TypeError("Plain document text must be a string");
	const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
	const paragraphs = lines.map((line, index) => schema.createNode("paragraph", {
		id: `${documentId}-paragraph-${index + 1}`,
		content: line.length > 0 ? [schema.createText(line, { id: `${documentId}-text-${index + 1}` })] : [],
	}));
	return schema.createDocument(paragraphs, documentId);
}

/** Converts a supported text selection into clipboard-friendly plain text. */
export function documentSelectionToText(document: DocumentNode, selection: DocumentSelection): string | undefined {
	if (selection.kind === "all") return documentToPlainText(document);
	if (selection.kind !== "text") return undefined;
	const anchor = findTextBearingBlockLocation(document, selection.anchor.nodeId);
	const head = findTextBearingBlockLocation(document, selection.head.nodeId);
	if (!anchor || !head) return undefined;
	if (anchor.block.id === head.block.id) {
		const forward = anchor.index < head.index || (anchor.index === head.index && selection.anchor.offset <= selection.head.offset);
		const start = forward ? { location: anchor, point: selection.anchor } : { location: head, point: selection.head };
		const end = forward ? { location: head, point: selection.head } : { location: anchor, point: selection.anchor };
		return textFromBlockRange(start.location.block, start.location.index, start.point.offset, end.location.index, end.point.offset);
	}
	if (anchor.parent.id !== head.parent.id) return undefined;
	const forward = anchor.parentIndex < head.parentIndex;
	const start = forward ? { location: anchor, point: selection.anchor } : { location: head, point: selection.head };
	const end = forward ? { location: head, point: selection.head } : { location: anchor, point: selection.anchor };
	for (let index = start.location.parentIndex; index <= end.location.parentIndex; index += 1) {
		if (!isTextBearingBlock(start.location.parent.content[index]!)) return undefined;
	}
	const parts: string[] = [textFromBlockRange(start.location.block, start.location.index, start.point.offset, start.location.block.content.length - 1, Number.MAX_SAFE_INTEGER)];
	for (let index = start.location.parentIndex + 1; index < end.location.parentIndex; index += 1) parts.push(textFromBlock(start.location.parent.content[index]!));
	parts.push(textFromBlockRange(end.location.block, 0, 0, end.location.index, end.point.offset));
	return parts.join("\n");
}

/** Converts the complete structured document to interoperable plain text. */
export function documentToPlainText(document: DocumentNode, schema?: DocumentSchema): string {
	const blocks: string[] = [];
	collectTextBearingBlocks(document, blocks, schema);
	return blocks.join("\n");
}

/** Extracts a validated block fragment from a text selection. */
export function extractDocumentFragment(schema: DocumentSchema, document: DocumentNode, selection: DocumentSelection): DocumentFragment | undefined {
	if (selection.kind === "all") return Object.freeze({ content: Object.freeze([...document.content]) });
	if (selection.kind !== "text") return undefined;
	const anchor = findTextBearingBlockLocation(document, selection.anchor.nodeId);
	const head = findTextBearingBlockLocation(document, selection.head.nodeId);
	if (!anchor || !head) return undefined;
	if (anchor.block.id === head.block.id) {
		const forward = anchor.index < head.index || (anchor.index === head.index && selection.anchor.offset <= selection.head.offset);
		const start = forward ? { location: anchor, point: selection.anchor } : { location: head, point: selection.head };
		const end = forward ? { location: head, point: selection.head } : { location: anchor, point: selection.anchor };
		const content = sliceInlineContent(schema, start.location.block, start.location.index, start.point.offset, end.location.index, end.point.offset);
		if (content.length === 0) return undefined;
		return Object.freeze({ content: Object.freeze([createBlock(schema, start.location.block, content)]) });
	}
	if (anchor.parent.id !== head.parent.id) return undefined;
	const forward = anchor.parentIndex < head.parentIndex;
	const start = forward ? { location: anchor, point: selection.anchor } : { location: head, point: selection.head };
	const end = forward ? { location: head, point: selection.head } : { location: anchor, point: selection.anchor };
	const blocks: DocumentNode[] = [];
	for (let index = start.location.parentIndex; index <= end.location.parentIndex; index += 1) {
		const block = start.location.parent.content[index];
		if (!block || !isTextBearingBlock(block)) return undefined;
		if (index === start.location.parentIndex) {
			const content = sliceInlineContent(schema, block, start.location.index, start.point.offset, block.content.length - 1, Number.MAX_SAFE_INTEGER);
			blocks.push(createBlock(schema, block, content));
		} else if (index === end.location.parentIndex) {
			const content = sliceInlineContent(schema, block, 0, 0, end.location.index, end.point.offset);
			blocks.push(createBlock(schema, block, content));
		} else {
			blocks.push(createBlock(schema, block, block.content));
		}
	}
	return Object.freeze({ content: Object.freeze(blocks) });
}

function decodeNode(value: unknown): DocumentNode {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.type !== "string") throw new DocumentSerializationError("Serialized document node is invalid");
	if (!Array.isArray(value.content)) throw new DocumentSerializationError(`Serialized node '${value.id}' must contain an array`);
	const attrs = decodeAttributes(value.attrs, `node:${value.id}`);
	const marks = value.marks === undefined ? [] : decodeMarks(value.marks, value.id);
	if (value.text !== undefined && typeof value.text !== "string") throw new DocumentSerializationError(`Serialized text for '${value.id}' is invalid`);
	return createDocumentNode({ id: value.id, type: value.type, attrs, content: value.content.map(decodeNode), marks, ...(value.text === undefined ? {} : { text: value.text }) });
}

function encodeNode(node: DocumentNode): SerializedDocumentNode {
	return {
		id: node.id,
		type: node.type,
		attrs: { ...node.attrs },
		content: node.content.map(encodeNode),
		marks: node.marks.map(mark => ({ type: mark.type, attrs: { ...mark.attrs } })),
		...(node.text === undefined ? {} : { text: node.text }),
	};
}

function validateFragmentContent(content: readonly DocumentNode[], schema: DocumentSchema): void {
	let rootId = "__ash_document_fragment_root__";
	while (content.some(node => node.id === rootId)) rootId += "_";
	schema.createDocument(content, rootId);
}

function decodeMarks(value: unknown, nodeId: string): readonly DocumentMark[] {
	if (!Array.isArray(value)) throw new DocumentSerializationError(`Serialized marks for '${nodeId}' must be an array`);
	return value.map(mark => {
		if (!isRecord(mark) || typeof mark.type !== "string") throw new DocumentSerializationError(`Serialized mark on '${nodeId}' is invalid`);
		return Object.freeze({ type: mark.type, attrs: decodeAttributes(mark.attrs, `mark:${mark.type}`) });
	});
}

function decodeAttributes(value: unknown, owner: string): DocumentAttributes {
	if (!isRecord(value)) throw new DocumentSerializationError(`Serialized attributes for '${owner}' are invalid`);
	const attrs: Record<string, DocumentAttributeValue> = {};
	for (const [key, attribute] of Object.entries(value)) {
		if (!isAttributeValue(attribute)) throw new DocumentSerializationError(`Serialized attribute '${key}' on '${owner}' is invalid`);
		attrs[key] = attribute;
	}
	return Object.freeze(attrs);
}

function isAttributeValue(value: unknown): value is DocumentAttributeValue {
	return value === null || typeof value === "string" || typeof value === "boolean" || isFiniteNumber(value);
}

function collectTextBearingBlocks(node: DocumentNode, blocks: string[], schema: DocumentSchema | undefined): void {
	if (isTextBearingBlock(node) || schema?.getNodeSpec(node.type)?.kind === "line") {
		blocks.push(textFromBlock(node));
		return;
	}
	for (const child of node.content) collectTextBearingBlocks(child, blocks, schema);
}

interface TextBearingBlockLocation {
	readonly block: DocumentNode;
	readonly parent: DocumentNode;
	readonly parentIndex: number;
	readonly index: number;
}

function findTextBearingBlockLocation(root: DocumentNode, textNodeId: DocumentNodeId): TextBearingBlockLocation | undefined {
	const textLocation = findDocumentNode(root, textNodeId);
	const block = textLocation?.parent;
	if (!block || !isTextBearingBlock(block)) return undefined;
	const blockLocation = findDocumentNode(root, block.id);
	const index = block.content.findIndex(child => child.id === textNodeId && child.text !== undefined);
	if (!blockLocation?.parent || index < 0) return undefined;
	return { block, parent: blockLocation.parent, parentIndex: blockLocation.index, index };
}

function textFromBlock(block: DocumentNode): string {
	return textFromBlockRange(block, 0, 0, block.content.length - 1, Number.MAX_SAFE_INTEGER);
}

function textFromBlockRange(block: DocumentNode, startIndex: number, startOffset: number, endIndex: number, endOffset: number): string {
	if (block.content.length === 0 || startIndex > endIndex) return "";
	const parts: string[] = [];
	for (let index = startIndex; index <= endIndex; index += 1) {
		const child = block.content[index]!;
		if (child.text !== undefined) {
			const from = index === startIndex ? Math.min(startOffset, child.text.length) : 0;
			const to = index === endIndex ? Math.min(endOffset, child.text.length) : child.text.length;
			if (to > from) parts.push(child.text.slice(from, to));
		} else if (child.type === "hardBreak") {
			parts.push("\n");
		} else if (child.type === "image") {
			parts.push(typeof child.attrs.alt === "string" ? child.attrs.alt : "\uFFFC");
		} else {
			parts.push(typeof child.attrs.label === "string" ? child.attrs.label : "\uFFFC");
		}
	}
	return parts.join("");
}

function isTextBearingBlock(node: DocumentNode): boolean {
	return node.type === "paragraph" || node.type === "heading" || node.type === "codeBlock";
}

function sliceInlineContent(schema: DocumentSchema, block: DocumentNode, startIndex: number, startOffset: number, endIndex: number, endOffset: number): readonly DocumentNode[] {
	if (block.content.length === 0 || startIndex < 0 || endIndex < startIndex) return [];
	const content: DocumentNode[] = [];
	for (let index = startIndex; index <= endIndex; index += 1) {
		const child = block.content[index];
		if (!child) continue;
		if (child.text !== undefined) {
			const from = index === startIndex ? Math.max(0, Math.min(startOffset, child.text.length)) : 0;
			const to = index === endIndex ? Math.max(from, Math.min(endOffset, child.text.length)) : child.text.length;
			if (to > from) content.push(schema.createText(child.text.slice(from, to), { id: child.id, marks: child.marks }));
		} else if (index > startIndex || startOffset === 0) {
			content.push(schema.createNode(child.type, { id: child.id, attrs: child.attrs, content: child.content, marks: child.marks, ...(child.text === undefined ? {} : { text: child.text }) }));
		}
	}
	return content;
}

function createBlock(schema: DocumentSchema, source: DocumentNode, content: readonly DocumentNode[]): DocumentNode {
	return schema.createNode(source.type, { id: source.id, attrs: source.attrs, content });
}
