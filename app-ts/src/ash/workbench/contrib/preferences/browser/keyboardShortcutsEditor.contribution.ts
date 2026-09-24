import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { registerEditorPane } from '../../../browser/parts/editor/editorRegistry.js';
import { isKeyboardShortcutsEditorInput } from '../../../services/preferences/browser/keybindingsEditorInput.js';
import { KeyboardShortcutsEditor, KeyboardShortcutsEditorId } from './keyboardShortcutsEditor.js';

registerEditorPane({
	id: KeyboardShortcutsEditorId,
	name: 'Keyboard Shortcuts',
	canOpen: input => isKeyboardShortcutsEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => {
		if (!options.contextKeyService) throw new Error('Keyboard Shortcuts requires the Workbench context key service');
		if (!options.keybindingService) throw new Error('Keyboard Shortcuts requires the Workbench keybinding service');
		if (!options.keybindingsResourceService) throw new Error('Keyboard Shortcuts requires the keybindings resource service');
		if (!options.keyboardLayoutService) throw new Error('Keyboard Shortcuts requires the keyboard layout service');
		return new KeyboardShortcutsEditor({
			contextKeyService: options.contextKeyService,
			keybindingService: options.keybindingService,
			keybindingsResourceService: options.keybindingsResourceService,
			keyboardLayoutService: options.keyboardLayoutService,
		});
	},
});
