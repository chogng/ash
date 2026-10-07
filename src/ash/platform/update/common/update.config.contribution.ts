import { localize } from '../../../nls.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../configuration/common/configurationRegistry.js';
import { Registry } from '../../registry/common/platform.js';
import { DESKTOP_UPDATE_POLICY_SETTING, type DesktopUpdatePolicy } from './updateService.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration<DesktopUpdatePolicy>({
	key: DESKTOP_UPDATE_POLICY_SETTING,
	defaultValue: 'latest',
	parse: value => {
		if (value === 'latest' || value === 'stable' || value === 'never') return value;
		throw new TypeError('Invalid Desktop update policy');
	},
	setting: {
		valueType: 'select',
		title: localize('update.policyTitle', 'Update channel'),
		description: localize('update.policyDescription', 'Choose automatic Ash Desktop updates. Never disables automatic checks; manual checks remain available.'),
		options: [
			{ value: 'latest', label: localize('update.policyLatest', 'Latest') },
			{ value: 'stable', label: localize('update.policyStable', 'Stable') },
			{ value: 'never', label: localize('update.policyNever', 'Never') },
		],
	},
});
