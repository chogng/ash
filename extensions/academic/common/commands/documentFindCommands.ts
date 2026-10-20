import { findDocumentNode, type DocumentNode } from '../model/document.js';
import type { DocumentPoint, DocumentSelection, DocumentTextSelection } from '../core/documentSelection.js';
import { selectionsEqual, textSelection } from '../core/documentSelection.js';
import type { DocumentSchema } from '../model/documentSchema.js';
import { applyDocumentTransaction, DocumentTransaction } from '../model/documentTransaction.js';
import { createReplaceTextCommand, type DocumentCommand } from './documentCommands.js';

export interface DocumentFindOptions {
	readonly matchCase: boolean;
	readonly wholeWord: boolean;
}

export interface DocumentFindMatch {
	readonly blockId: string;
	readonly selection: DocumentTextSelection;
}

/** Search contiguous text across marks, but never through an image, citation or block boundary. */
export function findDocumentText(document: DocumentNode, query: string, options: DocumentFindOptions): readonly DocumentFindMatch[] {
	if (!query || query.length > 10_000) return [];
	const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options.matchCase ? 'gu' : 'giu');
	const matches: DocumentFindMatch[] = [];
	const searchRuns = (block: DocumentNode, runs: readonly DocumentNode[]): void => {
		const text = runs.map(run => run.text!).join('');
		pattern.lastIndex = 0;
		for (const match of text.matchAll(pattern)) {
			const start = match.index;
			const end = start + match[0].length;
			if (options.wholeWord && (/[\p{L}\p{N}\p{M}_]$/u.test(text.slice(0, start)) || /^[\p{L}\p{N}\p{M}_]/u.test(text.slice(end)))) continue;
			const point = (offset: number, endBoundary: boolean) => {
				let consumed = 0;
				for (const run of runs) {
					const length = run.text!.length;
					if (offset < consumed + length || (endBoundary && offset === consumed + length)) return { nodeId: run.id, offset: offset - consumed };
					consumed += length;
				}
				return { nodeId: runs[runs.length - 1]!.id, offset: runs[runs.length - 1]!.text!.length };
			};
			matches.push({ blockId: block.id, selection: textSelection(point(start, false), point(end, true)) });
		}
	};
	const visit = (node: DocumentNode): void => {
		if (node.content.some(child => child.text !== undefined)) {
			let runs: DocumentNode[] = [];
			for (const child of node.content) {
				if (child.text !== undefined) runs.push(child);
				else {
					if (runs.length) searchRuns(node, runs);
					runs = [];
				}
			}
			if (runs.length) searchRuns(node, runs);
		}
		for (const child of node.content) if (child.text === undefined) visit(child);
	};
	visit(document);
	return matches;
}

/** Navigation uses semantic text identities, independent of the current DOM surface or marks. */
export function getDocumentFindMatchIndex(document: DocumentNode, matches: readonly DocumentFindMatch[], selection: DocumentSelection | undefined, direction: 1 | -1, includeCurrent = false): number {
	if (!matches.length) return -1;
	const exact = matches.findIndex(match => selectionsEqual(match.selection, selection));
	if (exact >= 0) return includeCurrent ? exact : (exact + direction + matches.length) % matches.length;
	if (selection?.kind === 'text') {
		const order = new Map<string, number>();
		const visit = (node: DocumentNode): void => {
			if (node.text !== undefined) order.set(node.id, order.size);
			for (const child of node.content) visit(child);
		};
		visit(document);
		const compare = (left: DocumentPoint, right: DocumentPoint): number => left.nodeId === right.nodeId
			? left.offset - right.offset : order.get(left.nodeId)! - order.get(right.nodeId)!;
		const forward = compare(selection.anchor, selection.head) <= 0;
		const boundary = direction > 0
			? forward ? selection.head : selection.anchor
			: forward ? selection.anchor : selection.head;
		if (direction > 0) {
			const next = matches.findIndex(match => compare(match.selection.anchor, boundary) >= 0);
			if (next >= 0) return next;
		} else {
			for (let index = matches.length - 1; index >= 0; index--) {
				if (compare(matches[index]!.selection.head, boundary) <= 0) return index;
			}
		}
	}
	return direction > 0 ? 0 : matches.length - 1;
}

/** Reverse document order keeps earlier identities/offsets valid; the model commits one history entry. */
export function createReplaceDocumentMatchesCommand(schema: DocumentSchema, document: DocumentNode, matches: readonly DocumentFindMatch[], replacement: string): DocumentCommand | undefined {
	const text = replacement.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
	let current = document;
	let transaction = new DocumentTransaction();
	let focus: DocumentCommand['focus'] | undefined;
	let selection: DocumentTextSelection | undefined;
	for (const match of [...matches].reverse()) {
		const { anchor, head } = match.selection;
		const point = { nodeId: anchor.nodeId, offset: anchor.offset + text.length };
		const remaining = (findDocumentNode(current, anchor.nodeId)?.node.text?.length ?? 0) - (head.offset - anchor.offset) + text.length;
		const command = anchor.nodeId === head.nodeId
			? {
				transaction: new DocumentTransaction().replaceText(anchor.nodeId, anchor.offset, head.offset, text).withSelection(remaining ? textSelection(point) : undefined),
				focus: { blockId: match.blockId, ...(remaining ? { point } : {}) },
			}
			: createReplaceTextCommand(schema, current, match.blockId, match.selection, text);
		if (!command) return undefined;
		current = applyDocumentTransaction(current, schema, command.transaction).document;
		transaction = new DocumentTransaction([...transaction.steps, ...command.transaction.steps]);
		focus = command.focus;
		selection = command.transaction.selection?.kind === 'text' ? command.transaction.selection : undefined;
	}
	return focus ? { transaction: transaction.withSelection(selection), focus } : undefined;
}
