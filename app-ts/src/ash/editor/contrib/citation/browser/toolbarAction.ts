import { createInsertCitationCommand, createInsertReferenceCommand } from "../common/citationCommands.js";
import type { EditorToolbarAction } from "../../../browser/widget/richTextEditor/richTextEditorWidget.js";

/** Toolbar actions contributed by the citation capability. */
export const citationToolbarActions: readonly EditorToolbarAction[] = Object.freeze([
	{
		id: "citation",
		label: "Citation",
		run: context => {
			if (!context.selection) return undefined;
			const key = context.ownerDocument.defaultView?.prompt("Citation key", "")?.trim();
			if (!key) return undefined;
			const label = context.ownerDocument.defaultView?.prompt("Citation label", "[" + key + "]");
			if (label === null) return undefined;
			return createInsertCitationCommand(context.model.schema, context.model.document, context.blockId, context.selection, key, label ?? undefined);
		},
	},
	{
		id: "reference",
		label: "Reference",
		run: context => {
			const key = context.ownerDocument.defaultView?.prompt("Reference key", "")?.trim();
			if (!key) return undefined;
			const label = context.ownerDocument.defaultView?.prompt("Reference text", "");
			if (label === null) return undefined;
			return createInsertReferenceCommand(context.model.schema, context.model.document, key, label ?? "");
		},
	},
]);
