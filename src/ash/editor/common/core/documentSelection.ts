import { isNonNegativeSafeInteger } from "../../../base/common/numbers.js";
import { findDocumentNode, type DocumentNode, type DocumentNodeId } from "../model/document.js";

export interface DocumentPoint {
	readonly nodeId: DocumentNodeId;
	readonly offset: number;
}

export interface DocumentTextSelection {
	readonly kind: "text";
	readonly anchor: DocumentPoint;
	readonly head: DocumentPoint;
}

export interface NodeSelection {
	readonly kind: "node";
	readonly nodeId: DocumentNodeId;
}

export interface AllSelection {
	readonly kind: "all";
}

export type DocumentSelection = DocumentTextSelection | NodeSelection | AllSelection;

export function textSelection(anchor: DocumentPoint, head = anchor): DocumentTextSelection {
	validatePoint(anchor);
	validatePoint(head);
	return Object.freeze({ kind: "text", anchor: Object.freeze({ ...anchor }), head: Object.freeze({ ...head }) });
}

export function nodeSelection(nodeId: DocumentNodeId): NodeSelection {
	validateNodeId(nodeId);
	return Object.freeze({ kind: "node", nodeId });
}

export function allSelection(): AllSelection {
	return Object.freeze({ kind: "all" });
}

export function validateDocumentSelection(document: DocumentNode, selection: DocumentSelection): void {
	switch (selection.kind) {
		case "text":
			validatePointInDocument(document, selection.anchor);
			validatePointInDocument(document, selection.head);
			return;
		case "node": {
			const location = findDocumentNode(document, selection.nodeId);
			if (!location || !location.parent) throw new RangeError(`Node selection target '${selection.nodeId}' does not exist`);
			return;
		}
		case "all":
			return;
	}
}

export function selectionsEqual(left: DocumentSelection | undefined, right: DocumentSelection | undefined): boolean {
	if (left === right) return true;
	if (!left || !right || left.kind !== right.kind) return false;
	if (left.kind === "all" || right.kind === "all") return true;
	if (left.kind === "node" && right.kind === "node") return left.nodeId === right.nodeId;
	if (left.kind === "text" && right.kind === "text") return pointsEqual(left.anchor, right.anchor) && pointsEqual(left.head, right.head);
	return false;
}

export function isDocumentSelectionValid(document: DocumentNode, selection: DocumentSelection | undefined): boolean {
	if (!selection) return true;
	try {
		validateDocumentSelection(document, selection);
		return true;
	} catch {
		return false;
	}
}

function validatePointInDocument(document: DocumentNode, point: DocumentPoint): void {
	const node = findDocumentNode(document, point.nodeId)?.node;
	if (!node || node.text === undefined) throw new RangeError(`Text selection target '${point.nodeId}' is not a text node`);
	if (!isNonNegativeSafeInteger(point.offset) || point.offset > node.text.length) throw new RangeError(`Text selection offset must be between 0 and ${node.text.length}`);
}

function validatePoint(point: DocumentPoint): void {
	validateNodeId(point.nodeId);
	if (!isNonNegativeSafeInteger(point.offset)) throw new RangeError("Document point offset must be a non-negative safe integer");
}

function validateNodeId(id: string): void {
	if (typeof id !== "string" || id.trim().length === 0) throw new TypeError("Document selection requires a node id");
}

function pointsEqual(left: DocumentPoint, right: DocumentPoint): boolean {
	return left.nodeId === right.nodeId && left.offset === right.offset;
}
