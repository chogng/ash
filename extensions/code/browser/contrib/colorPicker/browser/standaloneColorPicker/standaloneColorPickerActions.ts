import { localize2 } from '../../../../../../../src/ash/nls.js';
import { MenuId } from '../../../../../../../src/ash/platform/actions/common/actions.js';
import { type ICodeEditor } from '../../../../../../../src/ash/editor/browser/editorBrowser.js';
import { EditorAction, registerEditorAction, type ServicesAccessor } from '../../../../registration.js';
import { EditorContextKeys } from '../../../../../../../src/ash/editor/common/editorContextKeys.js';
import { ColorPickerController } from '../colorPickerController.js';
import { KeyCode } from '../../../../../../../src/ash/base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../../../../src/ash/platform/keybinding/common/keybindingsRegistry.js';

export class ShowOrFocusStandaloneColorPicker extends EditorAction {
	constructor() {
		const label = localize2('colorPicker.show', 'Show or focus color picker');
		super({
			id: 'editor.action.showOrFocusStandaloneColorPicker',
			label,
			precondition: undefined,
			menuOpts: { menuId: MenuId.CommandPalette, group: 'editor', order: 0, title: label.value },
		});
	}

	public async run(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		await editor.getContribution<ColorPickerController>('editor.contrib.colorPicker')?.showOrFocus();
	}
}

export class HideStandaloneColorPicker extends EditorAction {
	constructor() {
		super({ id: 'editor.action.hideColorPicker', label: localize2('colorPicker.hide', 'Hide color picker'), precondition: EditorContextKeys.standaloneColorPickerVisible.isEqualTo(true), kbOpts: { primary: KeyCode.Escape, weight: KeybindingWeight.EditorContrib } });
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		editor.getContribution<ColorPickerController>('editor.contrib.colorPicker')?.hide();
	}
}

export class InsertColorWithStandaloneColorPicker extends EditorAction {
	constructor() {
		super({ id: 'editor.action.insertColorWithStandaloneColorPicker', label: localize2('colorPicker.insert', 'Insert color with color picker'), precondition: EditorContextKeys.standaloneColorPickerFocused.isEqualTo(true), kbOpts: { primary: KeyCode.Enter, weight: KeybindingWeight.EditorContrib, kbExpr: EditorContextKeys.textInputFocus.isEqualTo(false) } });
	}

	public async run(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		await editor.getContribution<ColorPickerController>('editor.contrib.colorPicker')?.insertColor();
	}
}

registerEditorAction(ShowOrFocusStandaloneColorPicker);
registerEditorAction(HideStandaloneColorPicker);
registerEditorAction(InsertColorWithStandaloneColorPicker);
