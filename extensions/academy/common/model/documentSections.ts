import { containsDocumentNode, findDocumentNode, type DocumentNode } from './document.js';
import { DocumentTransaction } from './documentTransaction.js';
import type { DocumentSchema } from './documentSchema.js';
import type { DocumentCommand } from '../commands/documentCommands.js';

/** Sections own page intent; their descendants keep the existing text identities. */
export function getDocumentPageOwner(document: DocumentNode, blockId: string | undefined): DocumentNode {
	return document.content.find(node => node.type === 'documentSection' && blockId && containsDocumentNode(node, blockId)) ?? document;
}

export function createDocumentSectionCommand(schema: DocumentSchema, document: DocumentNode, blockId: string): DocumentCommand | undefined {
	const owner = getDocumentPageOwner(document, blockId);
	const child = owner.content.find(node => containsDocumentNode(node, blockId));
	if (!child || child.type === 'reviewComment') return undefined;
	const start = owner.content.indexOf(child);
	if (owner !== document && start === 0) return undefined;
	const section = schema.createNode('documentSection', { attrs: { ...(owner === document ? {} : owner.attrs), pageSize: owner.attrs.pageSize === 'letter' ? 'letter' : 'a4' } });
	const index = owner === document ? start : findDocumentNode(document, owner.id)!.index + 1;
	let transaction = new DocumentTransaction().insertNode(document.id, index, section);
	let at = 0;
	for (const node of owner.content.slice(start)) {
		if (node.type === 'documentSection') break;
		if (node.type !== 'reviewComment' && node.type !== 'reviewChange') transaction = transaction.moveNode(node.id, section.id, at++);
	}
	if (!at) return undefined;
	if (document.attrs.pageSize !== 'a4' && document.attrs.pageSize !== 'letter') transaction = transaction.setNodeAttributes(document.id, { ...document.attrs, pageSize: 'a4' });
	return { transaction, focus: { blockId } };
}

export function createRemoveSectionCommand(document: DocumentNode, blockId: string): DocumentCommand | undefined {
	const section = getDocumentPageOwner(document, blockId);
	if (section === document) return undefined;
	const index = document.content.indexOf(section);
	const previous = document.content[index - 1];
	const target = previous?.type === 'documentSection' ? previous : document;
	let transaction = new DocumentTransaction();
	for (const [offset, node] of section.content.entries()) transaction = transaction.moveNode(node.id, target.id, target === document ? index + offset : target.content.length + offset);
	transaction = transaction.deleteNode(section.id);
	return { transaction, focus: { blockId } };
}
