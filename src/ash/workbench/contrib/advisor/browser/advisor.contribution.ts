import { AccessibleViewProviderId, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ChatContextKeys } from '../../chat/common/actions/chatContextKeys.js';
import { registerSettingsSection } from '../../../services/preferences/browser/settingsSections.js';
import { AdvisorConfigurationPicker } from './advisor.js';
import { AdvisorSettingsModel } from './advisorSettingsModel.js';

registerSettingsSection({
	id: 'chat.advisor', categoryId: 'agents', model: new SyncDescriptor(AdvisorSettingsModel),
	accessibleViewProviderId: AccessibleViewProviderId.ChatModelConfiguration,
	accessibilityVerbositySettingId: AccessibilityVerbositySettingId.ChatModelConfiguration,
});

registerAction2(class ConfigureAdvisorAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.configureAdvisor',
			title: localize2('advisor.configure', 'Configure Advisor'),
			precondition: ChatContextKeys.enabled.isEqualTo(true),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IInstantiationService).createInstance(AdvisorConfigurationPicker).show([]);
	}
});
