import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import type { EditorOpenOptions } from '../common/editorService.js';

interface EditorPickItem extends IQuickPickItem {
	readonly id: string;
}

/** Selects an editor implementation; the caller owns opening it in the captured group. */
export class OpenWithEditorPicker {
	constructor(
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IEditorPart private readonly editorPart: IEditorPart,
	) { }

	/** Returns Ash's editor opening options, or undefined when selection is unnecessary or cancelled. */
	async pick(editor: IResourceEditorInput): Promise<EditorOpenOptions | undefined> {
		const choices = this.editorPart.getEditorPaneChoices(editor);
		if (choices.length <= 1) return undefined;

		using lifetime = new DisposableStore();
		const picker = lifetime.add(this.quickInputService.createQuickPick<EditorPickItem>());
		picker.placeholder = localize('workbench.editorTypePickerPlaceholder', 'Select an editor');
		picker.ariaLabel = picker.placeholder;
		picker.canAcceptInBackground = true;
		picker.items = choices.map(choice => ({ id: choice.id, label: choice.name, description: choice.id }));

		return await new Promise<EditorOpenOptions | undefined>(resolve => {
			lifetime.add(picker.onDidHide(() => resolve(undefined)));
			lifetime.add(picker.onDidAccept(event => {
				const selected = picker.selectedItems[0];
				if (!selected) return;
				// Settle before hiding: onDidHide also settles cancellation synchronously.
				resolve({ preferredEditorId: selected.id, preserveFocus: event.inBackground });
				picker.hide();
			}));
			picker.show();
		});
	}
}
