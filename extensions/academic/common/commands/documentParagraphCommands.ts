import { containsDocumentNode, createDocumentNode, findDocumentNode, type DocumentNode } from '../model/document.js';
import type { DocumentSelection } from '../core/documentSelection.js';
import type { DocumentSchema } from '../model/documentSchema.js';
import type { DocumentParagraphAttributes } from '../model/documentParagraph.js';
import { DocumentTransaction } from '../model/documentTransaction.js';
import type { DocumentCommand } from './documentCommands.js';

/**
 * Resolve the same target set for toolbar state and commands, in document order.
 * A range ending at the next paragraph's start excludes that paragraph; reversing
 * the selection keeps the same targets. Structural containers never become targets.
 */
export function getSelectedDocumentParagraphs(document: DocumentNode, blockId: string, selection: DocumentSelection | undefined): readonly DocumentNode[] {
	const paragraphs: DocumentNode[] = [];
	const visit = (node: DocumentNode): void => {
		if (node.type === 'paragraph' || node.type === 'heading') paragraphs.push(node);
		else for (const child of node.content) visit(child);
	};
	visit(document);
	if (selection?.kind === 'all') return paragraphs;
	if (selection?.kind !== 'text') return paragraphs.filter(node => node.id === (selection?.kind === 'node' ? selection.nodeId : blockId));
	const anchor = paragraphs.findIndex(node => containsDocumentNode(node, selection.anchor.nodeId));
	const head = paragraphs.findIndex(node => containsDocumentNode(node, selection.head.nodeId));
	if (anchor < 0 || head < 0) return [];
	const start = Math.min(anchor, head);
	let end = Math.max(anchor, head);
	const endPoint = anchor > head ? selection.anchor : selection.head;
	if (start !== end && endPoint.offset === 0 && paragraphs[end]?.content[0]?.id === endPoint.nodeId) end--;
	return paragraphs.slice(start, end + 1);
}

/** A single transaction formats all selected paragraphs while retaining inline marks and selection. */
export function createSetParagraphFormatCommand(document: DocumentNode, blockId: string, selection: DocumentSelection | undefined, attrs: DocumentParagraphAttributes): DocumentCommand | undefined {
	const paragraphs = getSelectedDocumentParagraphs(document, blockId, selection);
	let transaction = new DocumentTransaction();
	let changed = false;
	for (const node of paragraphs) {
		if (Object.entries(attrs).every(([key, value]) => node.attrs[key] === value)) continue;
		transaction = transaction.setNodeType(node.id, node.type, { ...node.attrs, ...attrs });
		changed = true;
	}
	return changed ? { transaction, focus: { blockId: paragraphs[0]!.id } } : undefined;
}

/**
 * Built-in styles use the existing paragraph/heading semantics as their identity.
 * This deliberately adds no competing style registry. Local paragraph formatting
 * and inline marks survive a style change; user-defined style definitions are later work.
 */
export function createSetParagraphStyleCommand(schema: DocumentSchema, document: DocumentNode, blockId: string, selection: DocumentSelection | undefined, level: number): DocumentCommand | undefined {
	if (!Number.isInteger(level) || level < 0 || level > 6) return undefined;
	const paragraphs = getSelectedDocumentParagraphs(document, blockId, selection);
	const type = level === 0 ? 'paragraph' : 'heading';
	let transaction = new DocumentTransaction();
	let changed = false;
	for (const node of paragraphs) {
		const { level: oldLevel, ...paragraphAttrs } = node.attrs;
		const attrs = level === 0 ? paragraphAttrs : { ...paragraphAttrs, level };
		if (node.type === type && (level === 0 ? oldLevel === undefined : oldLevel === level)) continue;
		// A title or section can require a heading in a particular child position.
		// Check the proposed parent composition before offering a structural edit;
		// rejecting one target rejects the entire multi-paragraph command.
		const parent = findDocumentNode(document, node.id)?.parent;
		if (!parent) return undefined;
		try {
			const proposedParent = createDocumentNode({ ...parent, content: parent.content.map(child => child.id === node.id ? createDocumentNode({ ...node, type, attrs }) : child) });
			if (parent.type === schema.topNodeType) schema.validate(proposedParent);
			else schema.validateFragment(proposedParent);
		} catch {
			return undefined;
		}
		transaction = transaction.setNodeType(node.id, type, attrs);
		changed = true;
	}
	return changed ? { transaction, focus: { blockId: paragraphs[0]!.id } } : undefined;
}
