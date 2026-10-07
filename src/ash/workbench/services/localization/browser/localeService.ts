import { Disposable } from '../../../../base/common/lifecycle.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { normalizeLocale } from '../../../../platform/languagePacks/common/languagePackCatalog.js';
import { ILanguagePackStore } from '../../../../platform/languagePacks/common/languagePackStore.js';
import { ILanguagePackService, type ILanguagePackItem } from '../../../../platform/languagePacks/common/languagePacksService.js';
import { IHostService } from '../../host/browser/host.js';
import { LocalizationConfiguration, type ILocaleService } from '../common/locale.js';

/** Saves the next startup's language without changing the running UI. */
export class WorkbenchLocaleService extends Disposable implements ILocaleService {
	public readonly whenReady: Promise<void>;

	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@ILanguagePackService private readonly languagePacks: ILanguagePackService,
		@ILanguagePackStore private readonly store: ILanguagePackStore,
		@IDialogService private readonly dialogs: IDialogService,
		@IHostService private readonly host: IHostService,
	) {
		super();
		this.whenReady = languagePacks.whenReady;
	}

	public get locale(): string { return getNLSLanguage(); }

	public async setLocale(item: ILanguagePackItem): Promise<void> {
		await this.whenReady;
		const requested = normalizeLocale(item.id);
		const catalog = this.languagePacks.catalogs.find(catalog => catalog.locale.toLowerCase() === requested.toLowerCase());
		if (!catalog) { throw new RangeError(`Locale '${item.id}' is not installed`); }
		// The resource must be durable before settings can select it at the next startup.
		await this.store.write(catalog);
		await this.configuration.updateValue(LocalizationConfiguration.locale, catalog.locale);
		if (catalog.locale !== this.locale) { await this.promptRestart(catalog.localizedLanguageName); }
	}

	public async clearLocalePreference(): Promise<void> {
		await this.configuration.updateValue(LocalizationConfiguration.locale, undefined);
		if (this.locale !== 'en') { await this.promptRestart('English'); }
	}

	private async promptRestart(languageName: string): Promise<void> {
		const { confirmed } = await this.dialogs.confirm({
			message: localize({ bundle: 'ash.settings', key: 'displayLanguage.restartMessage' }, 'Restart Ash to use {0}?', languageName),
			detail: localize({ bundle: 'ash.settings', key: 'displayLanguage.restartDetail' }, 'Your display language preference is saved. It will take effect after restarting the app or refreshing the page.'),
			primaryButton: localize({ bundle: 'ash.settings', key: 'displayLanguage.restartNow' }, 'Restart now'),
			cancelButton: localize({ bundle: 'ash.settings', key: 'displayLanguage.restartLater' }, 'Later'),
		});
		if (confirmed) { await this.host.restart(); }
	}
}
