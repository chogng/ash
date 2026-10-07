import { Event } from '../../../../../base/common/event.js';
import { IMarketplaceService } from '../../../../../platform/marketplace/common/marketplaceService.js';
import { MarketplaceLanguagePackService } from '../../../../../platform/languagePacks/browser/marketplaceLanguagePackService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILanguagePackService } from '../../../../../platform/languagePacks/common/languagePacksService.js';
import { ILanguagePackStore } from '../../../../../platform/languagePacks/common/languagePackStore.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IHostService } from '../../../host/browser/host.js';
import { WorkbenchLocaleService } from '../../browser/localeService.js';
import type { LanguagePackCatalog } from '../../../../../platform/languagePacks/common/languagePacksService.js';
import { setNlsMessages } from '../../../../../nls.js';
import { builtinLanguagePackCatalogs } from '../../common/localizationCatalogs.js';

export function initializeTestLocalization(locale: string): void {
	const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === locale)!;
	setNlsMessages(catalog.locale, catalog.bundles);
}

export function createTestLocaleService(configuration: IConfigurationService, languagePacks: ILanguagePackService, onRestart: () => Promise<void> = async () => { }, onConfirm: () => Promise<{ confirmed: boolean; }> = async () => ({ confirmed: false }), store?: ILanguagePackStore): WorkbenchLocaleService {
	using services = new InstantiationService();
	const catalogs = new Map<string, LanguagePackCatalog>();
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(ILanguagePackService, languagePacks);
	services.registerInstance(ILanguagePackStore, store ?? { read: async locale => catalogs.get(locale), write: async catalog => { catalogs.set(catalog.locale, catalog); } });
	services.registerInstance(IDialogService, { confirm: onConfirm } as unknown as IDialogService);
	services.registerInstance(IHostService, { hasFocus: true, onDidChangeFocus: Event.None, restart: onRestart, openWindow: async () => { }, getScreenshot: async () => undefined });
	return services.createInstance(WorkbenchLocaleService);
}

export function createTestLanguagePacks(marketplace: IMarketplaceService): MarketplaceLanguagePackService {
	using services = new InstantiationService();
	services.registerInstance(IMarketplaceService, marketplace);
	services.registerInstance(ILanguagePackStore, { read: async () => undefined, write: async () => { } });
	return services.createInstance(MarketplaceLanguagePackService, builtinLanguagePackCatalogs);
}
