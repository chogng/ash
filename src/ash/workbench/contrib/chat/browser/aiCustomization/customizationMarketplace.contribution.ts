import { localize } from '../../../../../nls.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { ICustomizationMarketplaceService } from '../../../../../platform/customizationMarketplace/common/customizationMarketplaceService.js';
import { CustomizationMarketplaceConfiguration } from '../../../../../platform/customizationMarketplace/common/customizationMarketplaceSources.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { CustomizationMarketplaceWorkbenchService } from './customizationMarketplaceWorkbenchService.js';

registerSingleton(ICustomizationMarketplaceService, CustomizationMarketplaceWorkbenchService, InstantiationType.Delayed);

// This profile preference controls discovery in this UI; registry enablement and trust stay with Rust.
Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: CustomizationMarketplaceConfiguration.MarketplaceEnabled,
	defaultValue: true,
	scope: ConfigurationScope.APPLICATION,
	parse: value => {
		if (typeof value !== 'boolean') {
			throw new TypeError(localize({ bundle: 'ash.extensions', key: 'marketplaceInvalidVisibility' }, 'Discovery visibility must be true or false.'));
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize({ bundle: 'ash.extensions', key: 'marketplaceEnabledTitle' }, 'Discover skills and MCP servers'),
		description: localize({ bundle: 'ash.extensions', key: 'marketplaceEnabledDescription' }, 'Show catalog results in Skills and MCP Servers. Installed resources remain available.'),
	},
});
