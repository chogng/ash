import { localize } from 'ash:editor/nls.js';
import type { EditorExtensionOperationContext } from '../../../widget/richTextEditor/richTextEditorWidget.js';
import { DocumentTransaction, applyDocumentTransaction, type DocumentStep } from '../../../../common/model/documentTransaction.js';
import { findDocumentNode, type DocumentNode } from '../../../../common/model/document.js';
import { createInsertCitationCommand, createInsertReferenceCommand, createUpdateReferenceCommand } from './citationCommands.js';
import { buildReferenceIndex } from './references.js';
import { textSelection } from '../../../../common/core/documentSelection.js';

interface LibraryReference { readonly id: string; readonly key: string; readonly text: string; }
interface Request { readonly version: 1; readonly operation: 'insert' | 'update'; readonly libraryId: string; readonly references: readonly LibraryReference[]; }

/** Public Academy citation API v1. Build against a private value and commit all resulting steps once. */
export function runLibraryCitationOperation(context: EditorExtensionOperationContext, payload: unknown) {
	const request = parseRequest(payload);
	const { model } = context;
	let document = model.document;
	const steps: DocumentStep[] = [];
	let selection = context.selection;
	let changed = 0;
	const add = (command: ReturnType<typeof createInsertReferenceCommand>) => {
		if (!command) return;
		// This is a value-only preparation pass; no second TextModel or history is created.
		document = applyDocumentTransaction(document, model.schema, command.transaction).document;
		steps.push(...command.transaction.steps);
	};
	// Release moving keys in the preparation value before assigning final keys. This
	// permits swaps and rename chains without touching unrelated bibliography entries.
	const initial = buildReferenceIndex(document).references;
	const linkedEntries = new Map(request.references.map(value => {
		const matches = initial.filter(reference => {
			const node = findDocumentNode(document, reference.nodeId)?.node;
			return node?.attrs.libraryId === request.libraryId && node.attrs.libraryEntryId === value.id;
		});
		if (matches.length > 1 || matches[0] && initial.filter(reference => reference.key === matches[0].key).length > 1) throw new Error(localize('document.library.ambiguous', 'Resolve duplicate linked bibliography entries before updating citations.'));
		return [value.id, matches[0]];
	}));
	const moving = new Set(request.references.filter(value => { const entry = linkedEntries.get(value.id); return entry && entry.key !== value.key; }).map(value => linkedEntries.get(value.id)!.nodeId));
	const reserved = new Set([...initial.map(value => value.key), ...request.references.map(value => value.key)]);
	let temporary = 0;
	for (const value of request.references) {
		const linked = linkedEntries.get(value.id);
		if (initial.some(reference => reference.key === value.key && reference.nodeId !== linked?.nodeId && !moving.has(reference.nodeId))) throw new Error(localize('document.library.keyConflict', 'Reference key {0} already belongs to another entry.', value.key));
		if (linked && moving.has(linked.nodeId)) {
			let key: string;
			do { key = `library-rename-${++temporary}`; } while (reserved.has(key));
			reserved.add(key);
			add(createUpdateReferenceCommand(model.schema, document, linked.key, key, linked.text));
		}
	}
	for (const value of request.references) {
		const matches = buildReferenceIndex(document).references.filter(reference => {
			const node = findDocumentNode(document, reference.nodeId)?.node;
			return node?.attrs.libraryId === request.libraryId && node.attrs.libraryEntryId === value.id;
		});
		if (matches.length > 1) throw new Error(localize('document.library.ambiguous', 'Resolve duplicate linked bibliography entries before updating citations.'));
		const linked = matches[0];
		if (buildReferenceIndex(document).references.some(reference => reference.key === value.key && reference.nodeId !== linked?.nodeId)) throw new Error(localize('document.library.keyConflict', 'Reference key {0} already belongs to another entry.', value.key));
		if (linked) {
			const command = createUpdateReferenceCommand(model.schema, document, linked.key, value.key, value.text);
			if (command) { add(command); changed++; }
		} else if (request.operation === 'insert') {
			const command = createInsertReferenceCommand(model.schema, document, value.key, value.text);
			if (!command) throw new Error(localize('document.library.unsupported', 'This document cannot accept a bibliography entry.'));
			add(command);
			const entry = buildReferenceIndex(document).references.find(reference => reference.key === value.key)!;
			const node = findDocumentNode(document, entry.nodeId)!.node;
			add({ transaction: new DocumentTransaction().setNodeAttributes(node.id, { ...node.attrs, libraryId: request.libraryId, libraryEntryId: value.id }), focus: { blockId: context.blockId } });
			changed++;
		}
	}
	if (request.operation === 'insert') {
		const value = request.references[0];
		const block = findDocumentNode(document, context.blockId)?.node;
		// An empty editable block has a DOM caret but no text node for the model's
		// text selection. Use its boundary only while preparing this insertion.
		if (!selection && block?.content.length === 0) selection = textSelection({ nodeId: block.id, offset: 0 });
		if (!selection) throw new Error(localize('document.library.noSelection', 'Place the caret in the Academy document before inserting a citation.'));
		const command = createInsertCitationCommand(model.schema, document, context.blockId, selection, value.key);
		if (!command) throw new Error(localize('document.library.noSelection', 'Place the caret in the Academy document before inserting a citation.'));
		add(command); selection = command.transaction.selection;
	}
	const known = new Set(request.references.map(value => value.id));
	const missing = buildReferenceIndex(document).references.filter(reference => {
		const node = findDocumentNode(document, reference.nodeId)?.node;
		return node?.attrs.libraryId === request.libraryId && !known.has(String(node.attrs.libraryEntryId));
	}).map(reference => reference.key);
	const focus = { blockId: context.blockId };
	return { command: steps.length ? { transaction: new DocumentTransaction(steps, { ...(request.operation === 'insert' ? { selection } : {}), label: localize('document.library.history', 'Update library citations') }), focus } : undefined, result: { version: 1, changed, missing: request.operation === 'update' ? missing : [] } };
}
function parseRequest(value: unknown): Request {
	const invalid = () => new TypeError(localize('document.library.invalid', 'The citation request is invalid or incompatible.'));
	if (!record(value) || value.version !== 1 || !['insert', 'update'].includes(value.operation as string) || Object.keys(value).some(key => !['version', 'operation', 'libraryId', 'references'].includes(key)) || !text(value.libraryId, 128) || !Array.isArray(value.references) || value.references.length > 10000 || value.operation === 'insert' && value.references.length !== 1) throw invalid();
	const ids = new Set<string>(); const keys = new Set<string>();
	let size = 0;
	for (const reference of value.references) {
		if (!record(reference) || Object.keys(reference).sort().join(',') !== 'id,key,text' || !text(reference.id, 128) || !text(reference.key, 128) || typeof reference.text !== 'string' || reference.text.length > 131072 || ids.has(reference.id) || keys.has(reference.key)) throw invalid();
		ids.add(reference.id); keys.add(reference.key);
		size += reference.id.length + reference.key.length + reference.text.length;
		if (size > 8 * 1024 * 1024) throw invalid();
	}
	return value as unknown as Request;
}
function record(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value); }
