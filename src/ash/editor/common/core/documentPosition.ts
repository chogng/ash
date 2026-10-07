import { isNonNegativeSafeInteger } from "../../../base/common/numbers.js";
import type { DocumentNode } from "../model/document.js";
import type { DocumentPoint } from "./documentSelection.js";
import type { DocumentSchema } from "../model/documentSchema.js";

/** Returns the ProseMirror-style node size used by Stanza's absolute positions. */
export function documentNodeSize(node: DocumentNode, schema: DocumentSchema): number {
	if (node.text !== undefined) return node.text.length;
	if (schema.isLeafNode(node)) return 1;
	return 2 + documentContentSize(node, schema);
}

/** Returns the size occupied by a node's content, excluding its boundaries. */
export function documentContentSize(node: DocumentNode, schema: DocumentSchema): number {
	if (node.text !== undefined) return node.text.length;
	if (schema.isLeafNode(node)) return 0;
	return node.content.reduce((size, child) => size + documentNodeSize(child, schema), 0);
}

/** Converts an identity-based text point into an absolute position in the root. */
export function documentPointToPosition(document: DocumentNode, schema: DocumentSchema, point: DocumentPoint): number {
	const position = findPointPosition(document, schema, point, -1);
	if (position === undefined) throw new RangeError(`Text point '${point.nodeId}' does not exist in the document`);
	return position;
}

function findPointPosition(node: DocumentNode, schema: DocumentSchema, point: DocumentPoint, start: number): number | undefined {
	if (node.id === point.nodeId) {
		if (node.text === undefined) throw new RangeError(`Document point '${point.nodeId}' must target a text node`);
		if (!isNonNegativeSafeInteger(point.offset) || point.offset > node.text.length) throw new RangeError(`Document point offset must be between 0 and ${node.text.length}`);
		return start + point.offset;
	}
	if (node.text !== undefined || schema.isLeafNode(node)) return undefined;
	let childStart = start + 1;
	for (const child of node.content) {
		const position = findPointPosition(child, schema, point, childStart);
		if (position !== undefined) return position;
		childStart += documentNodeSize(child, schema);
	}
	return undefined;
}
