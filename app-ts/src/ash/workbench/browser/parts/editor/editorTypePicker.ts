import type { IEditorPaneDescriptor } from '../../editor.js';
import { DisposableStore } from "../../../../base/common/lifecycle.js";
import { localize } from "../../../../nls.js";
import type { IQuickInputService, IQuickPickItem } from "../../../../platform/quickinput/common/quickInput.js";
import type { IEditorPart } from "./editorPart.js";
import type { IAction } from '../../../../base/common/actions.js';

/** Both title entry points operate on the input and group captured when their menu opens. */
export function createEditorTypeActions(choices: readonly IEditorPaneDescriptor[], currentId: string, select: (id: string) => Promise<unknown>): readonly IAction[] {
	return choices.map(choice => ({
		id: choice.id, label: choice.name, tooltip: choice.name, enabled: true,
		checked: choice.id === currentId,
		run: () => select(choice.id),
	}));
}

interface EditorTypeItem extends IQuickPickItem {
	readonly descriptor: IEditorPaneDescriptor;
}

/** Offers the editor implementations that can open the active resource. */
export function showEditorTypePicker(editorPart: IEditorPart, quickInputService: IQuickInputService, groupId?: string, editorIndex?: number): void {
	const group = groupId ? editorPart.groups.find(group => group.id === groupId) : editorPart.activeGroup;
	const input = editorIndex === undefined ? group?.activeInput : group?.inputs[editorIndex];
	const choices = editorPart.getEditorPaneChoices(input);
	if (choices.length <= 1) return;

	const picker = quickInputService.createQuickPick<EditorTypeItem>();
	const disposables = new DisposableStore();
	disposables.add(picker);
	picker.placeholder = localize("workbench.editorTypePickerPlaceholder", "Select an editor");
	picker.items = choices.map(descriptor => ({
		descriptor,
		label: descriptor.name,
		description: descriptor.id,
	}));
	disposables.add(picker.onDidAccept(item => {
		picker.hide();
		if (!input || !group?.inputs.includes(input)) return;
		void group.openEditor(input, { preferredEditorId: item.descriptor.id, pinned: true }).catch(error => {
			console.error("Could not reopen editor", error);
		});
	}));
	disposables.add(picker.onDidHide(() => disposables.dispose()));
	picker.show();
}
