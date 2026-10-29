import { generateUuid } from 'ash:editor/base/common/uuid.js';
import { containsDocumentNode, createDocumentNode, findDocumentNode, type DocumentNode } from '../model/document.js';
import type { DocumentSelection } from '../core/documentSelection.js';
import type { DocumentSchema } from '../model/documentSchema.js';
import {
	documentParagraphFormatKeys,
	getDocumentParagraphStyles,
	resolveDocumentParagraphAttributes,
	type DocumentParagraphStyle,
	type DocumentParagraphAttributes,
} from '../model/documentParagraph.js';
import { DocumentTransaction } from '../model/documentTransaction.js';
import type { DocumentCommand } from './documentCommands.js';

/**
 * Resolve the same target set for toolbar state and commands, in document order.
 * A range ending at the next paragraph's start excludes that paragraph; reversing
 * the selection keeps the same targets. Structural containers never become targets.
 */
export function getSelectedDocumentParagraphs(
	document: DocumentNode,
	blockId: string,
	selection: DocumentSelection | undefined,
): readonly DocumentNode[] {
	const paragraphs: DocumentNode[] = [];
	const visit = (node: DocumentNode): void => {
		if (node.type === 'paragraph' || node.type === 'heading') paragraphs.push(node);
		else for (const child of node.content) visit(child);
	};
	visit(document);
	if (selection?.kind === 'all') return paragraphs;
	if (selection?.kind !== 'text')
		return paragraphs.filter(node => node.id === (selection?.kind === 'node' ? selection.nodeId : blockId));
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
export function createSetParagraphFormatCommand(
	document: DocumentNode,
	blockId: string,
	selection: DocumentSelection | undefined,
	attrs: DocumentParagraphAttributes,
): DocumentCommand | undefined {
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
 * and inline marks survive a style change; named definitions are stored on the document.
 */
export function createSetParagraphStyleCommand(
	schema: DocumentSchema,
	document: DocumentNode,
	blockId: string,
	selection: DocumentSelection | undefined,
	level: number,
): DocumentCommand | undefined {
	if (!Number.isInteger(level) || level < 0 || level > 6) return undefined;
	const paragraphs = getSelectedDocumentParagraphs(document, blockId, selection);
	const type = level === 0 ? 'paragraph' : 'heading';
	let transaction = new DocumentTransaction();
	let changed = false;
	for (const node of paragraphs) {
		const { level: oldLevel, styleId: _styleId, ...paragraphAttrs } = node.attrs;
		const attrs = level === 0 ? paragraphAttrs : { ...paragraphAttrs, level };
		if (
			node.attrs.styleId === undefined &&
			node.type === type &&
			(level === 0 ? oldLevel === undefined : oldLevel === level)
		)
			continue;
		// A title or section can require a heading in a particular child position.
		// Check the proposed parent composition before offering a structural edit;
		// rejecting one target rejects the entire multi-paragraph command.
		const parent = findDocumentNode(document, node.id)?.parent;
		if (!parent) return undefined;
		try {
			const proposedParent = createDocumentNode({
				...parent,
				content: parent.content.map(child =>
					child.id === node.id ? createDocumentNode({ ...node, type, attrs }) : child,
				),
			});
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

/** Applies a reference while preserving local paragraph and character overrides. */
export function createApplyParagraphStyleCommand(
	schema: DocumentSchema,
	document: DocumentNode,
	blockId: string,
	selection: DocumentSelection | undefined,
	styleId: string,
): DocumentCommand | undefined {
	const style = getDocumentParagraphStyles(document).find(style => style.id === styleId);
	if (!style) return undefined;
	const structural = createSetParagraphStyleCommand(schema, document, blockId, selection, style.level);
	const paragraphs = getSelectedDocumentParagraphs(document, blockId, selection);
	if (!paragraphs.length) return undefined;
	// Reuse the built-in structural check, including Academy title/abstract constraints.
	if (
		!structural &&
		paragraphs.some(
			node =>
				node.type !== (style.level ? 'heading' : 'paragraph') ||
				(style.level && node.attrs.level !== style.level),
		)
	)
		return undefined;
	let transaction = structural?.transaction ?? new DocumentTransaction();
	for (const node of paragraphs) {
		const { level: _level, ...attrs } = node.attrs;
		transaction = transaction.setNodeType(node.id, style.level ? 'heading' : 'paragraph', {
			...attrs,
			styleId,
			...(style.level ? { level: style.level } : {}),
		});
	}
	return { transaction, focus: { blockId: paragraphs[0]!.id } };
}

export function createClearParagraphOverridesCommand(
	document: DocumentNode,
	blockId: string,
	selection: DocumentSelection | undefined,
): DocumentCommand | undefined {
	let transaction = new DocumentTransaction();
	for (const node of getSelectedDocumentParagraphs(document, blockId, selection)) {
		const attrs = Object.fromEntries(
			Object.entries(node.attrs).filter(
				([key]) => !documentParagraphFormatKeys.includes(key as (typeof documentParagraphFormatKeys)[number]),
			),
		);
		if (Object.keys(attrs).length !== Object.keys(node.attrs).length)
			transaction = transaction.setNodeAttributes(node.id, attrs);
	}
	return transaction.steps.length ? { transaction, focus: { blockId } } : undefined;
}

/** Create/update from the current paragraph; all references update in the same model version. */
export function createDefineParagraphStyleCommand(
	document: DocumentNode,
	blockId: string,
	name: string,
	styleId?: string,
): DocumentCommand | undefined {
	const node = findDocumentNode(document, blockId)?.node;
	if (!node || (node.type !== 'paragraph' && node.type !== 'heading') || !name.trim() || name.length > 80)
		return undefined;
	const styles = getDocumentParagraphStyles(document);
	if (styleId ? !styles.some(style => style.id === styleId) : styles.length >= 100) return undefined;
	const id = styleId ?? generateUuid();
	const resolved = resolveDocumentParagraphAttributes(document, node);
	const style: DocumentParagraphStyle = {
		id,
		name: name.trim(),
		level: node.type === 'heading' ? Number(node.attrs.level) : 0,
		attrs: Object.fromEntries(
			documentParagraphFormatKeys.filter(key => resolved[key] !== undefined).map(key => [key, resolved[key]]),
		),
	};
	const previous = styles.find(style => style.id === id);
	// Updating a style retains its structural role; change that role by applying a built-in style first.
	if (previous && previous.level !== style.level) return undefined;
	const definitions = previous
		? styles.map(candidate => (candidate.id === id ? style : candidate))
		: [...styles, style];
	let transaction = new DocumentTransaction().setNodeAttributes(document.id, {
		...document.attrs,
		paragraphStyles: JSON.stringify(definitions),
	});
	const attrs = Object.fromEntries(
		Object.entries(node.attrs).filter(
			([key]) => !documentParagraphFormatKeys.includes(key as (typeof documentParagraphFormatKeys)[number]),
		),
	);
	transaction = transaction.setNodeAttributes(node.id, { ...attrs, styleId: id });
	return { transaction, focus: { blockId } };
}

/** Removing a definition materializes inherited formatting, preserving every paragraph's appearance. */
export function createDeleteParagraphStyleCommand(
	document: DocumentNode,
	blockId: string,
	styleId: string,
): DocumentCommand | undefined {
	const styles = getDocumentParagraphStyles(document);
	if (!styles.some(style => style.id === styleId)) return undefined;
	let transaction = new DocumentTransaction().setNodeAttributes(document.id, {
		...document.attrs,
		paragraphStyles: JSON.stringify(styles.filter(style => style.id !== styleId)),
	});
	const visit = (node: DocumentNode): void => {
		if ((node.type === 'paragraph' || node.type === 'heading') && node.attrs.styleId === styleId) {
			const { styleId: _styleId, ...attrs } = resolveDocumentParagraphAttributes(document, node);
			transaction = transaction.setNodeAttributes(node.id, attrs);
		}
		for (const child of node.content) visit(child);
	};
	visit(document);
	return { transaction, focus: { blockId } };
}

/** Select the innermost list containing the active block. */
export function getDocumentList(document: DocumentNode, blockId: string): DocumentNode | undefined {
	let location = findDocumentNode(document, blockId);
	while (location?.parent) {
		if (location.parent.type === 'orderedList' || location.parent.type === 'bulletList') return location.parent;
		location = findDocumentNode(document, location.parent.id);
	}
	return undefined;
}

export function createSetListNumberingCommand(
	document: DocumentNode,
	blockId: string,
	attrs: { readonly order?: number; readonly numbering?: string },
): DocumentCommand | undefined {
	const list = getDocumentList(document, blockId);
	if (list?.type !== 'orderedList') return undefined;
	return {
		transaction: new DocumentTransaction().setNodeAttributes(list.id, { ...list.attrs, ...attrs }),
		focus: { blockId },
	};
}
