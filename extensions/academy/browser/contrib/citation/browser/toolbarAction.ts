import {
	createDeleteReferenceCommand,
	createInsertCitationCommand,
	createInsertReferenceCommand,
	createUpdateReferenceCommand,
} from '../common/citationCommands.js';
import { buildReferenceIndex, type ReferenceEntry } from '../common/references.js';
import type {
	EditorToolbarAction,
	EditorToolbarActionContext,
} from '../../../widget/richTextEditor/richTextEditorWidget.js';
import { localize } from 'ash:editor/nls.js';

/** Toolbar actions contributed by the citation capability. */
export const citationToolbarActions: readonly EditorToolbarAction[] = Object.freeze([
	{
		id: 'citation',
		get label() {
			return localize('document.citation.insert', 'Citation');
		},
		run: async context => {
			if (!context.selection) return undefined;
			const result = await context.dialogs.input({
				title: localize('document.citation.insert', 'Citation'),
				message: localize(
					'document.citation.input',
					'Enter a reference key. Leave the label empty for automatic numbering.',
				),
				inputs: [
					{ placeholder: localize('document.citation.key', 'Reference key') },
					{ placeholder: localize('document.citation.label', 'Citation label (optional)') },
				],
			});
			if (!result.confirmed) return undefined;
			const key = result.values?.[0]?.trim();
			if (!key) return undefined;
			const label = result.values?.[1] || undefined;
			return createInsertCitationCommand(
				context.model.schema,
				context.model.document,
				context.blockId,
				context.selection,
				key,
				label,
			);
		},
	},
	{
		id: 'reference',
		get label() {
			return localize('document.reference.insert', 'Reference');
		},
		run: async context => {
			const result = await context.dialogs.input({
				title: localize('document.reference.insert', 'Reference'),
				message: localize('document.reference.input', 'Enter a unique reference key and bibliography text.'),
				inputs: [
					{ placeholder: localize('document.citation.key', 'Reference key') },
					{ placeholder: localize('document.reference.text', 'Reference text') },
				],
			});
			if (!result.confirmed) return undefined;
			const key = result.values?.[0]?.trim();
			if (!key) return undefined;
			const command = createInsertReferenceCommand(
				context.model.schema,
				context.model.document,
				key,
				result.values?.[1] ?? '',
			);
			if (!command)
				await context.dialogs.error(
					localize('document.reference.duplicate', 'Enter a non-empty, unique reference key.'),
				);
			return command;
		},
	},
	{
		id: 'editReference',
		get label() {
			return localize('document.reference.edit', 'Edit reference');
		},
		run: async context => {
			const reference = await chooseReference(context, localize('document.reference.edit', 'Edit reference'));
			if (!reference) return undefined;
			const result = await context.dialogs.input({
				title: localize('document.reference.edit', 'Edit reference'),
				message: localize(
					'document.reference.editInput',
					'Change the key or bibliography text. All citations using this key update together; custom citation labels are preserved.',
				),
				inputs: [
					{ placeholder: localize('document.citation.key', 'Reference key'), value: reference.key },
					{ placeholder: localize('document.reference.text', 'Reference text'), value: reference.text },
				],
			});
			if (!result.confirmed) return undefined;
			const key = result.values?.[0]?.trim() ?? '';
			if (
				!key ||
				buildReferenceIndex(context.model.document).references.some(
					entry => entry.key.trim() === key && entry.nodeId !== reference.nodeId,
				)
			) {
				await context.dialogs.error(
					localize('document.reference.duplicate', 'Enter a non-empty, unique reference key.'),
				);
				return undefined;
			}
			return createUpdateReferenceCommand(
				context.model.schema,
				context.model.document,
				reference.key,
				key,
				result.values?.[1] ?? '',
			);
		},
	},
	{
		id: 'deleteReference',
		get label() {
			return localize('document.reference.delete', 'Delete reference');
		},
		run: async context => {
			const reference = await chooseReference(context, localize('document.reference.delete', 'Delete reference'));
			if (!reference) return undefined;
			const result = await context.dialogs.confirm({
				title: localize('document.reference.delete', 'Delete reference'),
				primaryButton: localize('document.reference.delete', 'Delete reference'),
				message: localize(
					'document.reference.deleteConfirm',
					'Delete reference {0}? Citations remain in the document and become unresolved. You can undo this action.',
					reference.key,
				),
			});
			return result.confirmed
				? createDeleteReferenceCommand(context.model.schema, context.model.document, reference.key)
				: undefined;
		},
	},
]);

async function chooseReference(
	context: EditorToolbarActionContext,
	title: string,
): Promise<ReferenceEntry | undefined> {
	const result = await context.dialogs.input({
		title,
		message: localize('document.reference.choose', 'Enter the key of the reference to edit or delete.'),
		inputs: [{ placeholder: localize('document.citation.key', 'Reference key') }],
	});
	if (!result.confirmed) return undefined;
	const matches = buildReferenceIndex(context.model.document).references.filter(
		entry => entry.key.trim() === result.values?.[0]?.trim(),
	);
	if (matches.length === 1) return matches[0];
	await context.dialogs.error(
		localize(
			'document.reference.notUnique',
			'No unique reference matches this key. Check the key and resolve any duplicate bibliography entries.',
		),
	);
	return undefined;
}
