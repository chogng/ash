import { Event } from '../../../../../base/common/event.js';
import { IExtensionManagementService } from '../../../../../platform/extensionManagement/common/extensionManagementService.js';
import { WebLanguagePacksService } from '../../../../../platform/languagePacks/browser/languagePacks.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILanguagePackService } from '../../../../../platform/languagePacks/common/languagePacks.js';
import { ILanguagePackStore } from '../../../../../platform/languagePacks/common/languagePackStore.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IHostService } from '../../../host/browser/host.js';
import { WorkbenchLocaleService } from '../../browser/localeService.js';
import type { LanguagePackCatalog } from '../../../../../platform/languagePacks/common/languagePackContract.js';
import { setNlsMessages } from '../../../../../nls.js';
import { builtinLanguagePackCatalogs, preinstalledLanguagePacks, productLanguagePackCatalogs } from '../../common/localizationCatalogs.js';
import type { LanguagePackIndexEntry } from '../../../../../platform/languagePacks/common/languagePackContract.js';
import { IMeteredConnectionService } from '../../../../../platform/meteredConnection/common/meteredConnection.js';

export function createTestLanguagePackStore(overrides: Partial<ILanguagePackStore> = {}): ILanguagePackStore {
	let entries: readonly LanguagePackIndexEntry[] = [];
	const catalogs = new Map<string, LanguagePackCatalog>();
	return {
		read: async locale => catalogs.get(locale),
		write: async catalog => { catalogs.set(catalog.locale, catalog); },
		readIndex: async () => entries,
		replace: async next => {
			for (const entry of next) { await overrides.write?.(entry.catalog); }
			entries = next;
			catalogs.clear();
			for (const entry of next) { catalogs.set(entry.locale, entry.catalog); }
		},
		...overrides,
	};
}

export function createEmptyTestLanguagePacks(): ILanguagePackService {
	return {
		onDidChange: Event.None, whenReady: Promise.resolve(), catalogs: productLanguagePackCatalogs,
		getInstalledLanguages: async () => [], refresh: async () => { },
		getBuiltInExtensionTranslationsUri: async () => undefined,
	};
}

export function initializeTestLocalization(locale: string): void {
	const catalog = productLanguagePackCatalogs.find(catalog => catalog.locale === locale)!;
	setNlsMessages(catalog.locale, catalog.bundles);
}

export function createTestLocaleService(configuration: IConfigurationService, languagePacks: ILanguagePackService, onRestart: () => Promise<void> = async () => { }, onConfirm: () => Promise<{ confirmed: boolean; }> = async () => ({ confirmed: false }), store?: Partial<ILanguagePackStore>): WorkbenchLocaleService {
	using services = new InstantiationService();
	const catalogs = new Map<string, LanguagePackCatalog>();
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(ILanguagePackService, languagePacks);
	services.registerInstance(ILanguagePackStore, createTestLanguagePackStore(store ?? { read: async locale => catalogs.get(locale), write: async catalog => { catalogs.set(catalog.locale, catalog); } }));
	services.registerInstance(IDialogService, { confirm: onConfirm } as unknown as IDialogService);
	services.registerInstance(IHostService, { reload: async () => { throw new Error('Unexpected reload in this fixture'); }, hasFocus: true, onDidChangeFocus: Event.None, restart: onRestart, openWindow: async () => { }, getScreenshot: async () => undefined });
	return services.createInstance(WorkbenchLocaleService);
}

export function createTestLanguagePacks(extensionManagement: IExtensionManagementService): WebLanguagePacksService {
	using services = new InstantiationService();
	services.registerInstance(IMeteredConnectionService, { _serviceBrand: undefined, isConnectionMetered: false, onDidChangeIsConnectionMetered: Event.None });
	services.registerInstance(IExtensionManagementService, extensionManagement);
	services.registerInstance(ILanguagePackStore, createTestLanguagePackStore());
	return services.createInstance(WebLanguagePacksService, builtinLanguagePackCatalogs, preinstalledLanguagePacks);
}
