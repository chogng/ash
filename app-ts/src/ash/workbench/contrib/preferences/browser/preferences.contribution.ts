import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { isSettingsEditorInput } from '../../../services/preferences/common/settingsEditorInput.js';
import { SettingsEditor, SettingsEditorId } from './settingsEditor.js';
import { PreferencesContribution } from '../common/preferencesContribution.js';
import '../common/settingsEditorColorRegistry.js';
import './keyboardLayoutPicker.js';
import './keyboardShortcutsEditor.contribution.js';
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

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.HooksSettings,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError('Hooks accessibility verbosity must be boolean');
		return value;
	},
});
