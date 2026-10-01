import { URI } from "../../../../base/common/uri.js";
import type { EditorInput } from "./editorInput.js";
import type { IEditorGroup, IEditorGroupsService } from "../../../services/editor/common/editorGroupsService.js";
import { getActiveDocument } from "../../../../base/browser/dom.js";
import { extUri } from "../../../../base/common/resources.js";

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
export function resolveCommandsContext(commandArgs: readonly unknown[], editorGroups: IEditorGroupsService): IResolvedEditorCommandsContext {
	const grouped = new Map<IEditorGroup, EditorInput[]>();
	let preserveFocus = false;
	let args = commandArgs;
	if (args.length === 0) {
		// Keyboard navigation can focus an inactive tab; the command belongs to that tab.
		const tab = getActiveDocument().activeElement?.closest<HTMLElement>('.ash-editor-tabs-control .ash-tab');
		const focused = tab?.dataset.actionId;
		const group = editorGroups.groups.find(candidate => candidate.editors.some(editor => editor.instanceId === focused)) ?? editorGroups.activeGroup;
		const editorIndex = focused ? group.editors.findIndex(editor => editor.instanceId === focused) : undefined;
		args = [{ groupId: group.id, ...(editorIndex === undefined ? {} : { editorIndex }) }];
	}
	for (const argument of args) {
		const target = resolveTarget(argument, editorGroups);
		if (!target) {
			continue;
		}
		preserveFocus ||= target.preserveFocus;
		const editors = grouped.get(target.group) ?? [];
		const selected = target.group.selectedInputs.includes(target.editor) ? target.group.selectedInputs : [target.editor];
		for (const editor of selected) {
			if (!editors.some(candidate => extUri.isEqual(candidate.resource, editor.resource))) {
				editors.push(editor);
			}
		}
		grouped.set(target.group, editors);
	}
	return {
		groupedEditors: [...grouped].map(([group, editors]) => ({ group, editors })),
		preserveFocus,
	};
}

function resolveTarget(argument: unknown, editorGroups: IEditorGroupsService): { group: IEditorGroup; editor: EditorInput; preserveFocus: boolean } | undefined {
	if (argument instanceof URI) {
		for (const group of editorGroups.groups) {
			const editor = group.inputs.find(input => extUri.isEqual(input.resource, argument));
			if (editor) {
				return { group, editor, preserveFocus: false };
			}
		}
		return undefined;
	}
	if (!isEditorCommandsContext(argument)) {
		return undefined;
	}
	const group = editorGroups.getGroup(argument.groupId);
	if (!group) {
		return undefined;
	}
	const editor = argument.editorIndex === undefined ? group.activeInput : group.editors[argument.editorIndex]?.input;
	return editor ? { group, editor, preserveFocus: argument.preserveFocus === true } : undefined;
}

function isEditorCommandsContext(value: unknown): value is IEditorCommandsContext {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const context = value as Partial<IEditorCommandsContext>;
	return typeof context.groupId === "string"
		&& (context.editorIndex === undefined || Number.isInteger(context.editorIndex) && context.editorIndex >= 0)
		&& (context.preserveFocus === undefined || typeof context.preserveFocus === "boolean");
}
