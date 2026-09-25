import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { normalizeLocale } from '../../../../platform/languagePacks/common/languagePackCatalog.js';
import type { ILanguagePackItem, ILanguagePackService } from '../../../../platform/languagePacks/common/languagePacksService.js';
import { LocalizationConfiguration, type ILocaleService, type LocaleId } from '../common/locale.js';

/** Owns the Workbench display-language selection stored in the local profile. */
export class WorkbenchLocaleService extends Disposable implements ILocaleService {
	private readonly localeChanged = this._register(new Emitter<LocaleId>());
	private currentLocale = 'en';
	public readonly whenReady: Promise<void>;

	constructor(
		private readonly configuration: IConfigurationService,
		private readonly languagePacks: ILanguagePackService,
	) {
		super();
		this.whenReady = this.initialize();
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(LocalizationConfiguration.locale)) {
				this.applyLocale(configuration.getValue(LocalizationConfiguration.locale));
			}
		}));
		this._register(languagePacks.onDidChange(() => {
			this.applyLocale(configuration.getValue(LocalizationConfiguration.locale));
		}));
	}

	public get locale(): LocaleId {
		return this.currentLocale;
	}

	public get onDidChangeLocale(): Event<LocaleId> {
		return this.localeChanged.event;
	}

	public async setLocale(languagePackItem: ILanguagePackItem): Promise<void> {
		await this.whenReady;
		const requested = normalizeLocale(languagePackItem.id);
		const installed = this.languagePacks.availableLocales.map(value => value.locale);
		const resolved = resolveInstalledLocale(requested, installed);
		if (!resolved) {
			throw new RangeError(`Locale '${languagePackItem.id}' is not installed`);
		}
		await this.configuration.updateValue(LocalizationConfiguration.locale, resolved);
		this.applyLocale(resolved);
	}

	public async clearLocalePreference(): Promise<void> {
		await this.whenReady;
		await this.configuration.updateValue(LocalizationConfiguration.locale, undefined);
		this.applyLocale(this.configuration.getValue(LocalizationConfiguration.locale));
	}

	private async initialize(): Promise<void> {
		await this.configuration.reloadConfiguration();
		await this.languagePacks.whenReady;
		this.applyLocale(this.configuration.getValue(LocalizationConfiguration.locale));
	}

	private applyLocale(requested: LocaleId): void {
		const installed = this.languagePacks.availableLocales.map(value => value.locale);
		const resolved = resolveInstalledLocale(normalizeLocale(requested), installed)
			?? installed.find(locale => locale === 'en')
			?? 'en';
		if (resolved === this.currentLocale) {
			return;
		}
		this.currentLocale = resolved;
		this.localeChanged.fire(resolved);
	}
}

function resolveInstalledLocale(requested: LocaleId, available: readonly LocaleId[]): LocaleId | undefined {
	return available.find(locale => locale === requested)
		?? available.find(locale => locale.toLowerCase() === requested.toLowerCase())
		?? (requested.includes('-') ? available.find(locale => locale === requested.split('-')[0]) : undefined);
}
