import { Emitter } from "../../../../base/common/event.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { formatNlsMessage, setNlsResolver } from "../../../../nls.js";
import type { ILanguagePackService } from "../../../../platform/languagePacks/common/languagePacksService.js";
import type { ILocaleService } from "../common/locale.js";
import type { ILocalizationService, LocalizationParameters } from "../common/localizationService.js";

/** Resolves catalogs for one Workbench and projects them into the low-level NLS API. */
export class WorkbenchLocalizationService extends Disposable implements ILocalizationService {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly whenReady: Promise<void>;

	readonly onDidChange = this._onDidChange.event;

	constructor(
		private readonly localeService: ILocaleService,
		private readonly languagePacks: ILanguagePackService,
	) {
		super();
		setNlsResolver((bundle, key, fallback, parameters) => this.translate(bundle, key, fallback, parameters));
		this.whenReady = this.initialize();
		this._register(localeService.onDidChangeLocale(() => {
			this._onDidChange.fire();
			setNlsResolver((bundle, key, fallback, parameters) => this.translate(bundle, key, fallback, parameters));
		}));
		this._register(languagePacks.onDidChange(() => {
			this._onDidChange.fire();
			setNlsResolver((bundle, key, fallback, parameters) => this.translate(bundle, key, fallback, parameters));
		}));
	}

	translate(bundle: string, key: string, fallback: string, parameters?: LocalizationParameters): string {
		const current = this.languagePacks.catalogs.find(catalog => catalog.locale === this.localeService.locale)?.bundles[bundle]?.[key];
		const english = this.languagePacks.catalogs.find(catalog => catalog.locale === "en")?.bundles[bundle]?.[key];
		return formatNlsMessage(current ?? english ?? fallback, parameters);
	}

	private async initialize(): Promise<void> {
		await this.languagePacks.whenReady;
		await this.localeService.whenReady;
	}
}
