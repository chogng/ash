import { URI } from "../../../../base/common/uri.js";
import type { EditorInput } from "./editorInput.js";
import type { IEditorGroup } from "./editorGroup.js";
import type { IEditorPart } from "./editorPart.js";

export interface IEditorCommandsContext {
	readonly groupId: string;
	readonly editorIndex?: number;
	readonly preserveFocus?: boolean;
}

export interface IResolvedEditorCommandsContext {
	readonly groupedEditors: readonly { readonly group: IEditorGroup; readonly editors: readonly EditorInput[] }[];
	readonly preserveFocus: boolean;
}

/** Resolves explicit editor command arguments against the currently open groups. */
export function resolveCommandsContext(commandArgs: readonly unknown[], editorPart: IEditorPart): IResolvedEditorCommandsContext {
	const grouped = new Map<IEditorGroup, EditorInput[]>();
	let preserveFocus = false;
	for (const argument of commandArgs) {
		const target = resolveTarget(argument, editorPart);
		if (!target) continue;
		preserveFocus ||= target.preserveFocus;
		const editors = grouped.get(target.group) ?? [];
		const selected = target.group.selectedInputs.includes(target.editor) ? target.group.selectedInputs : [target.editor];
		for (const editor of selected) {
			if (!editors.some(candidate => candidate.resource.toString() === editor.resource.toString())) editors.push(editor);
		}
		grouped.set(target.group, editors);
	}
	return {
		groupedEditors: [...grouped].map(([group, editors]) => ({ group, editors })),
		preserveFocus,
	};
}

function resolveTarget(argument: unknown, editorPart: IEditorPart): { group: IEditorGroup; editor: EditorInput; preserveFocus: boolean } | undefined {
	if (argument instanceof URI) {
		for (const group of editorPart.groups) {
			const editor = group.inputs.find(input => input.resource.toString() === argument.toString());
			if (editor) return { group, editor, preserveFocus: false };
		}
		return undefined;
	}
	if (!isEditorCommandsContext(argument)) return undefined;
	const group = editorPart.groups.find(candidate => candidate.id === argument.groupId);
	if (!group) return undefined;
	const editor = argument.editorIndex === undefined ? group.activeInput : group.editors[argument.editorIndex]?.input;
	return editor ? { group, editor, preserveFocus: argument.preserveFocus === true } : undefined;
}

function isEditorCommandsContext(value: unknown): value is IEditorCommandsContext {
	if (typeof value !== "object" || value === null) return false;
	const context = value as Partial<IEditorCommandsContext>;
	return typeof context.groupId === "string"
		&& (context.editorIndex === undefined || Number.isInteger(context.editorIndex) && context.editorIndex >= 0)
		&& (context.preserveFocus === undefined || typeof context.preserveFocus === "boolean");
}
