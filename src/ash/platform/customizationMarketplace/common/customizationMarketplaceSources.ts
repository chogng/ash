import type { IConfigurationService } from '../../configuration/common/configuration.js';
import type { ICustomizationMarketplaceSourceInfo } from './customizationMarketplaceService.js';

export const enum CustomizationMarketplaceConfiguration {
	MarketplaceEnabled = 'chat.customizations.marketplace.enabled',
}

/** UI visibility and backend registry enablement remain separate authorities. */
export function getEnabledCustomizationMarketplaceSources(configuration: IConfigurationService, sources: readonly ICustomizationMarketplaceSourceInfo[]): readonly ICustomizationMarketplaceSourceInfo[] {
	return configuration.getValue<boolean>(CustomizationMarketplaceConfiguration.MarketplaceEnabled)
		? sources.filter(source => source.enabled !== false) : [];
}
