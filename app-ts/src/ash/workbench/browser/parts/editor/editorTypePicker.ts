import { DisposableStore } from "../../../../base/common/lifecycle.js";
import { localize } from "../../../../nls.js";
import type { IQuickInputService, IQuickPickItem } from "../../../../platform/quickinput/common/quickInput.js";
import type { IEditorPaneDescriptor } from "./editorPane.js";
import type { IEditorPart } from "./editorPart.js";

interface EditorTypeItem extends IQuickPickItem {
	readonly descriptor: IEditorPaneDescriptor;
}

/** Offers the editor implementations that can open the active resource. */
export function showEditorTypePicker(editorPart: IEditorPart, quickInputService: IQuickInputService): void {
	const choices = editorPart.getEditorPaneChoices();
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
		void editorPart.reopenActiveEditorWith(item.descriptor.id).catch(error => {
			console.error("Could not reopen editor", error);
		});
	}));
	disposables.add(picker.onDidHide(() => disposables.dispose()));
	picker.show();
}
