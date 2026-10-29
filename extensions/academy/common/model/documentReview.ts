import { generateUuid } from 'ash:editor/base/common/uuid.js';
import { createDocumentNode, findDocumentNode, type DocumentAttributes, type DocumentNode } from './document.js';
import { DocumentTransaction, applyDocumentTransaction } from './documentTransaction.js';
import type { DocumentSchema } from './documentSchema.js';
import type { DocumentSelection } from '../core/documentSelection.js';
import type { DocumentCommand } from '../commands/documentCommands.js';

/** Pending revisions retain immutable evidence, never another mutable document. Review units are blocks. */
export function trackDocumentTransaction(schema: DocumentSchema, before: DocumentNode, transaction: DocumentTransaction, selection: DocumentSelection | undefined): DocumentTransaction {
	if (before.attrs.trackChanges !== true || transaction.getMeta('review.control') || !transaction.steps.length) return transaction;
	if (before.content.some(node => node.type === 'reviewChange' && node.attrs.scope === 'structure')) return transaction;
	const after = applyDocumentTransaction(before, schema, transaction, selection).document;
	const body = (document: DocumentNode) => document.content.filter(node => !isReviewNode(node));
	if (JSON.stringify(before.attrs) !== JSON.stringify(after.attrs) || JSON.stringify(body(before).map(node => node.id)) !== JSON.stringify(body(after).map(node => node.id))) {
		// Moving identities between root blocks makes their inverses interdependent.
		// Promote the pending baselines to one explicit document-structure review unit.
		let baseline = before;
		for (const record of [...before.content].reverse().filter(node => node.type === 'reviewChange')) {
			const reject = createResolveRevisionCommand(schema, baseline, record.id, false, before.id);
			if (reject) baseline = applyDocumentTransaction(baseline, schema, reject.transaction).document;
		}
		let result = transaction;
		for (const record of after.content.filter(node => node.type === 'reviewChange')) result = result.deleteNode(record.id);
		return result.insertNode(
			before.id,
			body(after).length + after.content.filter(node => node.type === 'reviewComment').length,
			schema.createNode('reviewChange', {
				id: generateUuid(),
				attrs: {
					target: before.id,
					scope: 'structure',
					before: JSON.stringify({ ...baseline, content: body(baseline) }),
					index: 0,
					author: String(transaction.getMeta('review.author') ?? 'Author'),
					createdAt: new Date().toISOString(),
				},
			}),
		);
	}
	const ids = new Set([...before.content, ...after.content].filter(node => !isReviewNode(node)).map(node => node.id));
	let result = transaction;
	for (const id of ids) {
		const old = before.content.find(node => node.id === id);
		const current = after.content.find(node => node.id === id);
		if (JSON.stringify(old) === JSON.stringify(current)) continue;
		const existing = before.content.find(node => node.type === 'reviewChange' && node.attrs.target === id);
		if (existing) continue;
		const record = schema.createNode('reviewChange', {
			id: generateUuid(),
			attrs: {
				target: id,
				before: old ? JSON.stringify(old) : '',
				index: Math.max(
					0,
					before.content.findIndex(node => node.id === id),
				),
				author: String(transaction.getMeta('review.author') ?? 'Author'),
				createdAt: new Date().toISOString(),
			},
		});
		result = result.insertNode(before.id, after.content.length, record);
	}
	return result;
}

export function isReviewNode(node: DocumentNode): boolean {
	return node.type === 'reviewComment' || node.type === 'reviewChange';
}

export function validateReviewAttributes(type: 'reviewComment' | 'reviewChange', attrs: DocumentAttributes): void {
	for (const key of ['author', 'createdAt']) if (typeof attrs[key] !== 'string' || String(attrs[key]).length > 200) throw new TypeError('Invalid review identity');
	if (type === 'reviewComment') {
		if (typeof attrs.body !== 'string' || !attrs.body.trim() || attrs.body.length > 10_000 || typeof attrs.resolved !== 'boolean') throw new TypeError('Invalid comment');
		if (attrs.anchor !== undefined) {
			if (typeof attrs.anchor !== 'string' || attrs.anchor.length > 1000) throw new TypeError('Invalid comment anchor');
			const selection = JSON.parse(attrs.anchor);
			if (selection?.kind !== 'text' || ![selection.anchor, selection.head].every(point => point && typeof point.nodeId === 'string' && Number.isSafeInteger(point.offset) && point.offset >= 0))
				throw new TypeError('Invalid comment position');
		}
		if (typeof attrs.quote !== 'string' || attrs.quote.length > 10_000) throw new TypeError('Invalid comment quote');
	} else {
		if (attrs.scope !== undefined && attrs.scope !== 'structure') throw new TypeError('Invalid review scope');
		if (typeof attrs.target !== 'string' || !attrs.target || typeof attrs.before !== 'string' || attrs.before.length > 8_000_000 || !Number.isSafeInteger(attrs.index) || Number(attrs.index) < 0)
			throw new TypeError('Invalid revision');
		if (attrs.before) {
			const node = JSON.parse(attrs.before);
			if (!node || node.id !== attrs.target || typeof node.type !== 'string' || !Array.isArray(node.content)) throw new TypeError('Invalid revision evidence');
			const pending = [{ node, depth: 0 }];
			let count = 0;
			while (pending.length) {
				const { node: item, depth } = pending.pop()!;
				if (
					++count > 100_000 ||
					depth > 100 ||
					!item ||
					typeof item.id !== 'string' ||
					typeof item.type !== 'string' ||
					!Array.isArray(item.content) ||
					!item.attrs ||
					!Array.isArray(item.marks) ||
					(item.text !== undefined && typeof item.text !== 'string') ||
					item.type === 'reviewChange' ||
					item.type === 'reviewComment'
				)
					throw new TypeError('Invalid revision evidence tree');
				for (const child of item.content) pending.push({ node: child, depth: depth + 1 });
			}
		}
	}
}

/** Concurrent records for the same block form one review unit, so accepting never discards a peer edit. */
export function createResolveRevisionCommand(schema: DocumentSchema, document: DocumentNode, recordId: string, accept: boolean, blockId: string): DocumentCommand | undefined {
	const record =
		document.content.find(node => node.type === 'reviewChange' && node.attrs.scope === 'structure') ?? document.content.find(node => node.id === recordId && node.type === 'reviewChange');
	if (!record) return undefined;
	const records = document.content
		.filter(node => node.type === 'reviewChange' && (record.attrs.scope === 'structure' || node.attrs.target === record.attrs.target))
		.sort((a, b) => String(a.attrs.createdAt).localeCompare(String(b.attrs.createdAt)) || a.id.localeCompare(b.id));
	const baseline = (record.attrs.scope === 'structure' ? records.filter(node => node.attrs.scope === 'structure') : records)[0]!;
	let transaction = new DocumentTransaction().withMeta('review.control', true);
	const current = findDocumentNode(document, String(record.attrs.target));
	if (!accept) {
		const original: DocumentNode | undefined = baseline.attrs.before ? JSON.parse(String(baseline.attrs.before)) : undefined;
		if (original?.id === document.id) {
			transaction = transaction.setNodeAttributes(document.id, {
				...original.attrs,
				trackChanges: document.attrs.trackChanges ?? false,
			});
			if (baseline.attrs.scope === 'structure') {
				for (const node of document.content.filter(node => !isReviewNode(node))) transaction = transaction.deleteNode(node.id);
				for (const [index, node] of original.content.entries()) transaction = transaction.insertNode(document.id, index, node);
			}
		} else {
			if (original) schema.validateFragment(original);
			if (current?.parent) transaction = transaction.deleteNode(current.node.id);
			if (original) transaction = transaction.insertNode(current?.parent?.id ?? document.id, current?.index ?? Math.min(Number(baseline.attrs.index), document.content.length), original);
		}
	}
	for (const node of records) transaction = transaction.deleteNode(node.id);
	return { transaction, focus: { blockId: current?.node.type === 'paragraph' ? current.node.id : blockId } };
}

export function createCommentCommand(
	schema: DocumentSchema,
	document: DocumentNode,
	blockId: string,
	selection: DocumentSelection | undefined,
	body: string,
	author: string,
): DocumentCommand | undefined {
	if (!body.trim() || body.length > 10_000 || selection?.kind !== 'text') return undefined;
	const anchor = findDocumentNode(document, selection.anchor.nodeId)?.node;
	const head = findDocumentNode(document, selection.head.nodeId)?.node;
	const quote =
		anchor === head
			? (anchor?.text?.slice(Math.min(selection.anchor.offset, selection.head.offset), Math.max(selection.anchor.offset, selection.head.offset)) ?? '')
			: (anchor?.text ?? '').slice(selection.anchor.offset) + ' … ' + (head?.text ?? '').slice(0, selection.head.offset);
	const comment = schema.createNode('reviewComment', {
		id: generateUuid(),
		attrs: {
			body: body.trim(),
			author,
			createdAt: new Date().toISOString(),
			anchor: JSON.stringify(selection),
			quote: quote.slice(0, 10_000),
			resolved: false,
		},
	});
	return {
		transaction: new DocumentTransaction().withMeta('review.control', true).insertNode(document.id, document.content.length, comment),
		focus: { blockId },
	};
}
