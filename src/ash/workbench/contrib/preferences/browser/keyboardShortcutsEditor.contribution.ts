import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { isKeyboardShortcutsEditorInput } from '../../../services/preferences/browser/keybindingsEditorInput.js';
import { KeyboardShortcutsEditor, KeyboardShortcutsEditorId } from './keyboardShortcutsEditor.js';

registerEditorPane({
	id: KeyboardShortcutsEditorId,
	name: 'Keyboard Shortcuts',
	canOpen: input => isKeyboardShortcutsEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => {
		if (!options.instantiationService) throw new Error('Keyboard Shortcuts requires the editor service scope');
		return options.instantiationService.createInstance(KeyboardShortcutsEditor);
	},
});
