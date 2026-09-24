import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { ServiceConstructionDescriptor } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { registerEditorPane } from '../../../browser/parts/editor/editorRegistry.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { ILocalizationService } from '../../../services/localization/common/localizationService.js';
import { IGitService } from '../../../services/git/common/gitService.js';
import { isPreferencesEditorInput } from '../../../services/preferences/common/preferencesEditorInput.js';
import { PreferencesEditor, PreferencesEditorId } from './preferencesEditor.js';
import { registerPreferencesEditorPane } from './preferencesEditorRegistry.js';
import { SettingsEditorPane, SettingsEditorPaneId } from './settingsEditor.js';
import { PreferencesContribution } from '../common/preferencesContribution.js';
import '../common/settingsEditorColorRegistry.js';
import './keyboardLayoutPicker.js';
import './keyboardShortcutsEditor.contribution.js';
import './preferencesActions.js';

registerPreferencesEditorPane({
	id: SettingsEditorPaneId,
	title: 'Settings',
	order: 1,
	ctorDescriptor: new ServiceConstructionDescriptor(SettingsEditorPane, {
		serviceDependencies: [
			IClipboardService,
			IConfigurationService,
			IContextMenuService,
			IContextViewService,
			ILocalizationService,
			IGitService,
		],
	}),
});

registerEditorPane({
	id: PreferencesEditorId,
	name: 'Preferences',
	canOpen: input => isPreferencesEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => {
		if (!options.instantiationService) throw new Error('Preferences editor requires the Instantiation Service');
		return new PreferencesEditor(options.instantiationService, options.instantiationService.get(ILocalizationService));
	},
});

registerWorkbenchContribution(PreferencesContribution.ID, WorkbenchPhase.BlockStartup, accessor => PreferencesContribution.create(accessor));
