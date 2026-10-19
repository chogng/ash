import { KeyCode, KeyMod, KeyChord } from '../../../../../../src/ash/base/common/keyCodes.js';
import { localize2 } from '../../../../../../src/ash/nls.js';
import { MenuId } from '../../../../../../src/ash/platform/actions/common/actions.js';
import { KeybindingWeight } from '../../../../../../src/ash/platform/keybinding/common/keybindingsRegistry.js';
import type { ICodeEditor } from '../../../../../../src/ash/editor/browser/editorBrowser.js';
import { EditorAction, registerEditorAction, type ServicesAccessor } from '../../../registration.js';
import { EditorContextKeys } from '../../../../../../src/ash/editor/common/editorContextKeys.js';
import { ContentHoverController } from './contentHoverController.js';

class ShowOrFocusHoverAction extends EditorAction {
	constructor() {
		const label = localize2('hover.show', 'Show or focus hover');
		super({
			id: 'editor.action.showHover', label, precondition: EditorContextKeys.focus.isEqualTo(true),
			menuOpts: { menuId: MenuId.CommandPalette, group: 'editor', order: 0, title: label.value },
			kbOpts: { primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyI), weight: KeybindingWeight.EditorContrib }
		});
	}
	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		const position = editor.getPosition();
		if (position) { editor.getContribution<ContentHoverController>('editor.contrib.hover')!.showContentHover(position); }
	}
}

registerEditorAction(ShowOrFocusHoverAction);
