import { findDocumentNode, type DocumentNode, type DocumentNodeId } from '../../../../common/model/document.js';
import {
	createInsertInlineNodeAtSelectionCommand,
	type DocumentCommand,
} from '../../../../common/commands/documentCommands.js';
import type { DocumentSchema } from '../../../../common/model/documentSchema.js';
import { BIBLIOGRAPHY_NODE_TYPE, CITATION_NODE_TYPE, REFERENCE_NODE_TYPE } from './schema.js';
import { DocumentTransaction } from '../../../../common/model/documentTransaction.js';
import { textSelection, type DocumentSelection } from '../../../../common/core/documentSelection.js';
import { buildReferenceIndex } from './references.js';

/** Creates a command that inserts one citation atom at the active inline selection. */
export function createInsertCitationCommand(
	schema: DocumentSchema,
	document: DocumentNode,
	blockId: DocumentNodeId,
	selection: DocumentSelection,
	key: string,
	label?: string,
): DocumentCommand | undefined {
	const normalizedKey = normalizeKey(key);
	if (normalizedKey.length === 0 || schema.getNodeSpec(CITATION_NODE_TYPE)?.kind !== 'inline') return undefined;
	const citation = schema.createNode(CITATION_NODE_TYPE, {
		attrs: { key: normalizedKey, ...(label === undefined ? {} : { label }) },
	});
	const block = findDocumentNode(document, blockId)?.node;
	if (
		block &&
		block.content.length === 0 &&
		schema.canContainChild(block.type, CITATION_NODE_TYPE) &&
		selection.kind === 'text' &&
		selection.anchor.nodeId === blockId &&
		selection.head.nodeId === blockId &&
		selection.anchor.offset === 0 &&
		selection.head.offset === 0
	) {
		return { transaction: new DocumentTransaction().insertNode(blockId, 0, citation), focus: { blockId } };
	}
	return createInsertInlineNodeAtSelectionCommand(schema, document, blockId, selection, citation);
}

/** Creates a command that appends a reference to the bibliography, creating it when needed. */
export function createInsertReferenceCommand(
	schema: DocumentSchema,
	document: DocumentNode,
	key: string,
	label: string,
): DocumentCommand | undefined {
	const normalizedKey = normalizeKey(key);
	const normalizedLabel = typeof label === 'string' ? label.trim() : '';
	if (
		normalizedKey.length === 0 ||
		findNodesByKey(document, REFERENCE_NODE_TYPE, normalizedKey).length > 0 ||
		schema.getNodeSpec(REFERENCE_NODE_TYPE)?.kind !== 'block' ||
		!schema.canContainChild(document.type, BIBLIOGRAPHY_NODE_TYPE)
	)
		return undefined;
	const paragraph =
		normalizedLabel.length > 0
			? schema.createNode('paragraph', { content: [schema.createText(normalizedLabel)] })
			: schema.createNode('paragraph');
	const reference = schema.createNode(REFERENCE_NODE_TYPE, { attrs: { key: normalizedKey }, content: [paragraph] });
	const findBibliography = (node: DocumentNode): DocumentNode | undefined =>
		node.type === BIBLIOGRAPHY_NODE_TYPE ? node : node.content.map(findBibliography).find(Boolean);
	const bibliography = findBibliography(document);
	let transaction: DocumentTransaction;
	if (bibliography) {
		transaction = new DocumentTransaction().insertNode(bibliography.id, bibliography.content.length, reference);
	} else {
		const container = schema.createNode(BIBLIOGRAPHY_NODE_TYPE, { content: [reference] });
		const insertionIndex = findBibliographyInsertionIndex(schema, document);
		transaction = new DocumentTransaction().insertNode(document.id, insertionIndex, container);
	}
	const point =
		paragraph.content[0]?.text === undefined
			? undefined
			: { nodeId: paragraph.content[0].id, offset: paragraph.content[0].text.length };
	if (point) transaction = transaction.withSelection(textSelection(point));
	return { transaction, focus: { blockId: paragraph.id, ...(point ? { point } : {}) } };
}

/** Updates one unambiguous reference and its citation uses as a single history unit. */
export function createUpdateReferenceCommand(
	schema: DocumentSchema,
	document: DocumentNode,
	key: string,
	newKey: string,
	label: string,
): DocumentCommand | undefined {
	const normalizedKey = normalizeKey(key);
	const normalizedNewKey = normalizeKey(newKey);
	if (!normalizedKey || !normalizedNewKey || typeof label !== 'string') return undefined;
	const references = findNodesByKey(document, REFERENCE_NODE_TYPE, normalizedKey);
	if (references.length !== 1) return undefined;
	const reference = references[0];
	if (findNodesByKey(document, REFERENCE_NODE_TYPE, normalizedNewKey).some(node => node.id !== reference.id))
		return undefined;
	const paragraph = reference.content[0];
	if (paragraph?.type !== 'paragraph') return undefined;

	let transaction = new DocumentTransaction();
	if (reference.attrs.key !== normalizedNewKey)
		transaction = transaction.setNodeAttributes(reference.id, { ...reference.attrs, key: normalizedNewKey });
	for (const citation of findNodesByKey(document, CITATION_NODE_TYPE, normalizedKey)) {
		if (citation.attrs.key !== normalizedNewKey)
			transaction = transaction.setNodeAttributes(citation.id, { ...citation.attrs, key: normalizedNewKey });
	}
	// Replace only the label's inline content, retaining the paragraph's identity and attributes.
	const normalizedLabel = label.trim();
	const currentLabel = buildReferenceIndex(document)
		.references.find(entry => entry.nodeId === reference.id)!
		.text.trim();
	if (normalizedLabel !== currentLabel) {
		for (const child of paragraph.content) transaction = transaction.deleteNode(child.id);
		if (normalizedLabel.length > 0)
			transaction = transaction.insertNode(paragraph.id, 0, schema.createText(normalizedLabel));
	}
	return transaction.steps.length === 0 ? undefined : { transaction, focus: { blockId: paragraph.id } };
}

/** Deletes a definition without cascading to citation atoms that can still be resolved later. */
export function createDeleteReferenceCommand(
	schema: DocumentSchema,
	document: DocumentNode,
	key: string,
): DocumentCommand | undefined {
	const normalizedKey = normalizeKey(key);
	if (!normalizedKey) return undefined;
	const references = findNodesByKey(document, REFERENCE_NODE_TYPE, normalizedKey);
	if (references.length !== 1) return undefined;
	const reference = references[0];
	const parent = findDocumentNode(document, reference.id)?.parent;
	if (!parent || parent.type !== BIBLIOGRAPHY_NODE_TYPE) return undefined;
	// Bibliographies require at least one reference; remove the container with its last entry.
	const removed = parent.content.length === 1 ? parent : reference;
	const location = findDocumentNode(document, removed.id)!;
	const firstTextBlock = (node: DocumentNode): DocumentNode | undefined =>
		node.id === removed.id
			? undefined
			: node.type === 'paragraph' || node.type === 'heading' || node.type === 'codeBlock'
				? node
				: node.content.map(firstTextBlock).find(Boolean);
	let focus = firstTextBlock(document);
	let transaction = new DocumentTransaction().deleteNode(removed.id);
	// Keep an emptied section valid, and keep a bibliography-only document editable.
	if (!focus || (location.parent?.type === 'documentSection' && location.parent.content.length === 1)) {
		focus = schema.createNode('paragraph');
		transaction = transaction.insertNode(location.parent!.id, location.index, focus);
	}
	return { transaction, focus: { blockId: focus.id } };
}

function normalizeKey(key: unknown): string {
	return typeof key === 'string' ? key.trim() : '';
}

function findNodesByKey(document: DocumentNode, type: string, key: string): DocumentNode[] {
	const matches: DocumentNode[] = [];
	const visit = (node: DocumentNode): void => {
		if (node.type === type && normalizeKey(node.attrs.key) === key) matches.push(node);
		for (const child of node.content) visit(child);
	};
	visit(document);
	return matches;
}

function findBibliographyInsertionIndex(schema: DocumentSchema, document: DocumentNode): number {
	const firstFallbackBlock = document.content.findIndex(
		node => schema.getNodeSpec(node.type)?.groups?.includes('block') === true,
	);
	return firstFallbackBlock < 0 ? document.content.length : firstFallbackBlock;
}
