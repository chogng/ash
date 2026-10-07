import type { DocumentNode, DocumentNodeId } from "../../../common/model/document.js";
import { createInsertInlineNodeAtSelectionCommand, type DocumentCommand } from "../../../common/commands/documentCommands.js";
import type { DocumentSchema } from "../../../common/model/documentSchema.js";
import { BIBLIOGRAPHY_NODE_TYPE, CITATION_NODE_TYPE, REFERENCE_NODE_TYPE } from "./schema.js";
import { DocumentTransaction } from "../../../common/model/documentTransaction.js";
import { textSelection, type DocumentSelection } from "../../../common/core/documentSelection.js";

/** Creates a command that inserts one citation atom at the active inline selection. */
export function createInsertCitationCommand(schema: DocumentSchema, document: DocumentNode, blockId: DocumentNodeId, selection: DocumentSelection, key: string, label?: string): DocumentCommand | undefined {
	if (typeof key !== "string" || key.length === 0 || schema.getNodeSpec(CITATION_NODE_TYPE)?.kind !== "inline") return undefined;
	const citation = schema.createNode(CITATION_NODE_TYPE, { attrs: { key, ...(label === undefined ? {} : { label }) } });
	return createInsertInlineNodeAtSelectionCommand(schema, document, blockId, selection, citation);
}

/** Creates a command that appends a reference to the bibliography, creating it when needed. */
export function createInsertReferenceCommand(schema: DocumentSchema, document: DocumentNode, key: string, label: string): DocumentCommand | undefined {
	const normalizedKey = typeof key === "string" ? key.trim() : "";
	const normalizedLabel = typeof label === "string" ? label.trim() : "";
	if (normalizedKey.length === 0 || schema.getNodeSpec(REFERENCE_NODE_TYPE)?.kind !== "block" || !schema.canContainChild(document.type, BIBLIOGRAPHY_NODE_TYPE)) return undefined;
	const paragraph = normalizedLabel.length > 0 ? schema.createNode("paragraph", { content: [schema.createText(normalizedLabel)] }) : schema.createNode("paragraph");
	const reference = schema.createNode(REFERENCE_NODE_TYPE, { attrs: { key: normalizedKey }, content: [paragraph] });
	const bibliography = document.content.find(node => node.type === BIBLIOGRAPHY_NODE_TYPE);
	let transaction: DocumentTransaction;
	if (bibliography) {
		transaction = new DocumentTransaction().insertNode(bibliography.id, bibliography.content.length, reference);
	} else {
		const container = schema.createNode(BIBLIOGRAPHY_NODE_TYPE, { content: [reference] });
		const insertionIndex = findBibliographyInsertionIndex(schema, document);
		transaction = new DocumentTransaction().insertNode(document.id, insertionIndex, container);
	}
	const point = paragraph.content[0]?.text === undefined ? undefined : { nodeId: paragraph.content[0].id, offset: paragraph.content[0].text.length };
	if (point) transaction = transaction.withSelection(textSelection(point));
	return { transaction, focus: { blockId: reference.id, ...(point ? { point } : {}) } };
}

function findBibliographyInsertionIndex(schema: DocumentSchema, document: DocumentNode): number {
	const firstFallbackBlock = document.content.findIndex(node => schema.getNodeSpec(node.type)?.groups?.includes("block") === true);
	return firstFallbackBlock < 0 ? document.content.length : firstFallbackBlock;
}
