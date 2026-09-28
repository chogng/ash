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
import { IChatService } from '../../../services/chat/common/chatService.js';
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
		return options.instantiationService.createInstance(new ServiceConstructionDescriptor(SettingsEditor, {
			serviceDependencies: [
				IClipboardService,
				IConfigurationService,
				IContextMenuService,
				IContextViewService,
				ILocalizationService,
				IGitService,
				IChatService,
			],
		}));
	},
});

registerWorkbenchContribution(PreferencesContribution.ID, WorkbenchPhase.BlockStartup, accessor => PreferencesContribution.create(accessor));
