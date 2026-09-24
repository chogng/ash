import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from "../../../../platform/configuration/common/configurationRegistry.js";
import type { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import type { ILanguagePackService } from "../../../../platform/languagePacks/common/languagePacksService.js";
import { Registry } from "../../../../platform/registry/common/platform.js";

export type LocaleId = string;

export interface ILocaleService {
	readonly locale: LocaleId;
	readonly onDidChangeLocale: Event<LocaleId>;
	readonly whenReady: Promise<void>;
	setLocale(locale: LocaleId): Promise<void>;
}

export const ILocaleService = createServiceIdentifier<ILocaleService>("localeService");

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

export const LocalizationConfiguration = Object.freeze({
	locale: configurationRegistry.registerConfiguration<LocaleId>({
		key: "workbench.locale",
		defaultValue: "en",
		parse(value: unknown): LocaleId {
			if (typeof value !== "string") throw new TypeError("workbench.locale must be a string");
			const normalized = normalizeLocale(value);
			if (!normalized) throw new TypeError("Invalid workbench.locale: " + value);
			return normalized;
		},
		serialize(value: LocaleId): string {
			return normalizeLocale(value);
		},
	}),
});

/** Owns the client/window display-language selection and its persistence. */
export class WorkbenchLocaleService extends Disposable implements ILocaleService {
	private readonly _onDidChangeLocale = this._register(new Emitter<LocaleId>());
	private currentLocale = "en";
	readonly whenReady: Promise<void>;

	constructor(
		private readonly configuration: IConfigurationService,
		private readonly languagePacks: ILanguagePackService,
	) {
		super();
		this.whenReady = this.initialize();
		this._register(configuration.onDidChangeConfiguration(event => {
			if (!event.affectsConfiguration(LocalizationConfiguration.locale)) return;
			this.applyLocale(configuration.getValue(LocalizationConfiguration.locale));
		}));
		this._register(languagePacks.onDidChange(() => {
			this.applyLocale(configuration.getValue(LocalizationConfiguration.locale));
		}));
	}

	get locale(): LocaleId {
		return this.currentLocale;
	}

	get onDidChangeLocale(): Event<LocaleId> {
		return this._onDidChangeLocale.event;
	}

	async setLocale(locale: LocaleId): Promise<void> {
		await this.whenReady;
		const resolved = resolveInstalledLocale(normalizeLocale(locale), this.languagePacks.availableLocales.map(value => value.locale));
		if (!resolved) throw new RangeError("Locale '" + locale + "' is not installed");
		await this.configuration.updateValue(LocalizationConfiguration.locale, resolved);
		this.applyLocale(resolved);
	}

	private async initialize(): Promise<void> {
		await this.configuration.reloadConfiguration();
		await this.languagePacks.whenReady;
		this.applyLocale(this.configuration.getValue(LocalizationConfiguration.locale));
	}

	private applyLocale(requested: LocaleId): void {
		const resolved = resolveLocale(requested, this.languagePacks.availableLocales.map(value => value.locale)) ?? "en";
		if (resolved === this.currentLocale) return;
		this.currentLocale = resolved;
		this._onDidChangeLocale.fire(resolved);
	}
}

export function normalizeLocale(value: string): LocaleId {
	const parts = value.trim().replaceAll("_", "-").split("-");
	if (parts.length === 0 || !parts[0] || parts.some((part) => !/^[A-Za-z0-9]+$/u.test(part))) return "";
	return parts.map((part, index) => index === 0 ? part.toLowerCase() : part.length === 2 || part.length === 3 ? part.toUpperCase() : part).join("-");
}

export function resolveLocale(requested: LocaleId, available: Iterable<string>): LocaleId | undefined {
	const normalized = normalizeLocale(requested);
	const candidates = [...available];
	return resolveInstalledLocale(normalized, candidates) ?? candidates.find(locale => locale === "en");
}

export function resolveInstalledLocale(requested: LocaleId, available: Iterable<string>): LocaleId | undefined {
	const normalized = normalizeLocale(requested);
	const candidates = [...available];
	return candidates.find(locale => locale === normalized)
		?? candidates.find(locale => locale.toLowerCase() === normalized.toLowerCase())
		?? (normalized.includes("-") ? candidates.find(locale => locale === normalized.split("-")[0]) : undefined);
}
