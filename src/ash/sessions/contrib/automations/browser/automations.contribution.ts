import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IAutomationService } from '../../../../workbench/contrib/chat/common/automations/automationService.js';
import { IAutomationRunner } from '../../../../workbench/contrib/chat/common/automations/automationRunner.js';
import { IAutomationDialogService } from '../../../../workbench/contrib/chat/common/automations/automationDialogService.js';
import { ProviderAutomationService } from './providerAutomationService.js';
import { AutomationRunner } from './automationRunner.js';
import { AutomationDialogService } from './automationDialogService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	ConfigurationScope,
	Extensions,
	type IConfigurationRegistry,
} from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'sessions.automations.notifyOnSuccess',
	scope: ConfigurationScope.APPLICATION,
	defaultValue: false,
	parse: value => {
		if (typeof value !== 'boolean')
			throw new TypeError(
				localize('automations.notificationBoolean', 'Automation completion notifications must be a boolean.'),
			);
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('automations.notifySuccess', 'Notify when an automation completes'),
		description: localize(
			'automations.notifyDescription',
			'Show successful automation results in this window. Failures and requests for input are always notified while the window is open.',
		),
	},
});

registerSingleton(IAutomationService, ProviderAutomationService, InstantiationType.Delayed);

registerSingleton(IAutomationRunner, AutomationRunner, InstantiationType.Delayed);

registerSingleton(IAutomationDialogService, AutomationDialogService, InstantiationType.Delayed);
