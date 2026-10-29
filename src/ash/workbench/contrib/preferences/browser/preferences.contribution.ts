import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { isSettingsEditorInput } from '../../../services/preferences/common/settingsEditorInput.js';
import { SettingsEditor, SettingsEditorId } from './settingsEditor.js';
import { isKeybindingsEditorInput } from '../../../services/preferences/browser/keybindingsEditorInput.js';
import { KeybindingsEditor } from './keybindingsEditor.js';
import { PreferencesContribution } from '../common/preferencesContribution.js';
import '../common/settingsEditorColorRegistry.js';
import './keyboardLayoutPicker.js';
import './keyboardShortcutsTroubleshooting.contribution.js';
import './preferencesActions.js';

registerEditorPane({
	id: SettingsEditorId,
	name: 'Settings',
	canOpen: input => isSettingsEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => {
		if (!options.instantiationService) throw new Error('Settings editor requires the Instantiation Service');
		return options.instantiationService.createInstance(SettingsEditor);
	},
});

registerWorkbenchContribution(PreferencesContribution.ID, WorkbenchPhase.BlockStartup, accessor => PreferencesContribution.create(accessor));

registerEditorPane({
	id: KeybindingsEditor.ID,
	name: 'Keyboard Shortcuts',
	canOpen: input => isKeybindingsEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => {
		if (!options.instantiationService) throw new Error('Keyboard Shortcuts requires the editor service scope');
		return options.instantiationService.createInstance(KeybindingsEditor);
	},
});
