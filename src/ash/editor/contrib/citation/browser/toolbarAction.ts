import { createInsertCitationCommand, createInsertReferenceCommand } from "../common/citationCommands.js";
import type { EditorToolbarAction } from "../../../browser/widget/richTextEditor/richTextEditorWidget.js";

/** Toolbar actions contributed by the citation capability. */
export const citationToolbarActions: readonly EditorToolbarAction[] = Object.freeze([
	{
		id: "citation",
		label: "Citation",
		run: async context => {
			if (!context.selection) return undefined;
			const result = await context.dialogs.input({
				title: 'Citation',
				message: 'Enter a citation key and label.',
				inputs: [{ placeholder: 'Citation key' }, { placeholder: 'Citation label' }],
			});
			if (!result.confirmed) return undefined;
			const key = result.values?.[0]?.trim();
			if (!key) return undefined;
			const label = result.values?.[1] || `[${key}]`;
			return createInsertCitationCommand(context.model.schema, context.model.document, context.blockId, context.selection, key, label);
		},
	},
	{
		id: "reference",
		label: "Reference",
		run: async context => {
			const result = await context.dialogs.input({
				title: 'Reference',
				message: 'Enter a reference key and text.',
				inputs: [{ placeholder: 'Reference key' }, { placeholder: 'Reference text' }],
			});
			if (!result.confirmed) return undefined;
			const key = result.values?.[0]?.trim();
			if (!key) return undefined;
			return createInsertReferenceCommand(context.model.schema, context.model.document, key, result.values?.[1] ?? '');
		},
	},
]);
