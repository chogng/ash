import { getKeybindingLabel } from '../../../../base/common/keybindingLabels.js';
import type { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import type { IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import type { IEditorAction } from '../../../common/editorCommon.js';

interface StandaloneHelpPick extends IQuickPickItem {
	readonly action: IEditorAction;
}

const helpActions = [
	'editor.action.quickCommand',
	'editor.action.quickOutline',
	'editor.action.gotoLine',
	'editor.action.gotoOffset',
] as const;

export function getStandaloneHelpPicks(editor: ICodeEditor, keybindings: IKeybindingService): readonly StandaloneHelpPick[] {
	return helpActions.flatMap(id => {
		const action = editor.getAction(id);
		if (!action?.isSupported()) {
			return [];
		}
		const keybinding = keybindings.lookupKeybinding(id);
		return [{
			action,
			label: `? ${action.label}`,
			keybinding: keybinding ? getKeybindingLabel(keybinding) : undefined,
		}];
	});
}
