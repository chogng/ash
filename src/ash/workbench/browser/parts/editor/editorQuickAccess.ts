import './media/editorquickaccess.css';
import { basename } from "../../../../base/common/resources.js";
import { localize } from "../../../../nls.js";
import { PickerQuickAccessProvider, TriggerAction, type IPickerQuickAccessItem, type Picks } from "../../../../platform/quickinput/browser/pickerQuickAccess.js";
import { filterQuickPickItems } from "../../../../platform/quickinput/browser/quickInputList.js";
import type { EditorIdentifier } from "../../../services/editor/common/editorState.js";
import { IEditorPart } from "./editorPart.js";

interface EditorQuickPickItem extends IPickerQuickAccessItem {
	readonly editor: EditorIdentifier;
}

/** Searches open editors in the order they were last used. */
export class AllEditorsByMostRecentlyUsedQuickAccess extends PickerQuickAccessProvider<EditorQuickPickItem> {
	static readonly PREFIX = "edt mru ";

	constructor(@IEditorPart private readonly editorPart: IEditorPart) {
		super(AllEditorsByMostRecentlyUsedQuickAccess.PREFIX);
		this._register(editorPart.onDidChangeEditors(() => this.refresh()));
	}

	protected override _getPicks(filter: string): Picks<EditorQuickPickItem> {
		const editorState = new Map(this.editorPart.groups.flatMap(group => group.editors.map(editor => [editor.instanceId, editor] as const)));
		return filterQuickPickItems(this.editorPart.editorsMru.map(editor => ({
			editor,
			accept: () => { this.editorPart.activateEditorIdentifier(editor); this.editorPart.focus(); },
			trigger: async () => {
				try { await this.editorPart.closeEditorIdentifier(editor); }
				catch (error) { console.error('Could not close editor from Quick Pick', error); }
				return TriggerAction.REFRESH_PICKER;
			},
			className: editorState.get(editor.instanceId)?.isDirty
				? 'ash-editor-quick-pick-item dirty'
				: 'ash-editor-quick-pick-item',
			buttons: [{ id: 'close', label: localize('workbench.closeEditor', 'Close') }],
			label: editorInputLabel(editor.input),
			description: localize(
				"workbench.editorGroupNumber",
				"Group {0}",
				this.editorPart.groups.findIndex(group => group.id === editor.groupId) + 1,
			),
			detail: editor.input.resource.toString(),
		})), filter);
	}

}

function editorInputLabel(input: EditorIdentifier["input"]): string {
	if (input.label?.trim()) return input.label;
	return basename(input.resource) || input.resource.toString();
}
