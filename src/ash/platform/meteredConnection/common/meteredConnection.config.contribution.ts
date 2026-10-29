import { localize } from '../../../nls.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../configuration/common/configurationRegistry.js';
import { Registry } from '../../registry/common/platform.js';
import { METERED_CONNECTION_SETTING_KEY, type MeteredConnectionSettingValue } from './meteredConnection.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<MeteredConnectionSettingValue>({
	key: METERED_CONNECTION_SETTING_KEY,
	defaultValue: 'auto',
	scope: ConfigurationScope.APPLICATION,
	schema: { type: 'string', enum: ['auto', 'on', 'off'] },
	parse: value => {
		if (value === 'auto' || value === 'on' || value === 'off') return value;
		throw new TypeError('Invalid metered connection setting');
	},
	setting: {
		valueType: 'select',
		title: localize('network.meteredConnection.title', 'Metered connection'),
		description: localize(
			'network.meteredConnection.description',
			'Pause automatic Ash Desktop update checks and startup language-pack cache synchronization on metered connections. Manual checks, downloads, and language-pack refreshes remain available. Automatic detection uses browser data-saving and metered signals; connection speed alone does not determine billing status.',
		),
		options: [
			{ value: 'auto', label: localize('network.meteredConnection.auto', 'Detect automatically') },
			{ value: 'on', label: localize('network.meteredConnection.on', 'Always treat as metered') },
			{ value: 'off', label: localize('network.meteredConnection.off', 'Never treat as metered') },
		],
	},
});
