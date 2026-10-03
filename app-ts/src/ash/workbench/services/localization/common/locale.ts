import { ConfigurationScope, Extensions as ConfigurationExtensions, type IConfigurationRegistry } from "../../../../platform/configuration/common/configurationRegistry.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import { normalizeLocale } from "../../../../platform/languagePacks/common/languagePackCatalog.js";
import type { ILanguagePackItem } from "../../../../platform/languagePacks/common/languagePacksService.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import { localize } from "../../../../nls.js";
import { builtinLanguagePackCatalogs } from "./localizationCatalogs.js";

export type LocaleId = string;

export interface ILocaleService {
	readonly locale: LocaleId;
	readonly whenReady: Promise<void>;
	setLocale(languagePackItem: ILanguagePackItem): Promise<void>;
	clearLocalePreference(): Promise<void>;
}

export const ILocaleService = createServiceIdentifier<ILocaleService>("localeService");

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

export const LocalizationConfiguration = Object.freeze({
	locale: configurationRegistry.registerConfiguration<LocaleId>({
		key: "workbench.locale",
		defaultValue: "en",
		scope: ConfigurationScope.APPLICATION,
		setting: {
			valueType: "select",
			get title() { return localize({ bundle: "ash.settings", key: "displayLanguage.select" }, "Interface language"); },
			get description() { return localize({ bundle: "ash.settings", key: "displayLanguage.description" }, "Choose the language used by the Ash interface."); },
			keywords: ["language", "locale", "display language", "语言"],
			options: builtinLanguagePackCatalogs.map(catalog => ({ value: catalog.locale, label: catalog.localizedLanguageName })),
		},
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
