import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter } from "../../../../../base/common/event.js";
import { InMemoryConfigurationService } from "../../../../../platform/configuration/common/inMemoryConfigurationService.js";
import type { IMarketplaceService } from "../../../../../platform/marketplace/common/marketplaceService.js";
import { MarketplaceLanguagePackService } from "../../../../../platform/languagePacks/browser/marketplaceLanguagePackService.js";
import { builtinLanguagePackCatalogs } from "../../common/localizationCatalogs.js";
import { LocalizationConfiguration, WorkbenchLocaleService, normalizeLocale, resolveLocale } from "../../common/locale.js";
import { WorkbenchLocalizationService } from "../../browser/workbenchLocalizationService.js";

test("locale resolution prefers exact, base-language, and English fallback matches", () => {
	assert.equal(normalizeLocale("ZH_cn"), "zh-CN");
	assert.equal(resolveLocale("zh-cn", ["en", "zh-CN", "fr"]), "zh-CN");
	assert.equal(resolveLocale("fr-CA", ["en", "fr"]), "fr");
	assert.equal(resolveLocale("de", ["en", "zh-CN"]), "en");
});

test("locale selection is client-local and only accepts installed packs", async () => {
	using configuration = new InMemoryConfigurationService();
	using languagePacks = new MarketplaceLanguagePackService(createMarketplace(), builtinLanguagePackCatalogs);
	using localeService = new WorkbenchLocaleService(configuration, languagePacks);

	await localeService.whenReady;
	await assert.rejects(localeService.setLocale("fr"), /not installed/);
	await localeService.setLocale("zh_cn");
	assert.equal(localeService.locale, "zh-CN");
	assert.equal(configuration.getValue(LocalizationConfiguration.locale), "zh-CN");
});

test("localization lookup falls back to English and formats parameters", async () => {
	using configuration = new InMemoryConfigurationService();
	const languagePacks = new MarketplaceLanguagePackService(createMarketplace(), builtinLanguagePackCatalogs);
	using localeService = new WorkbenchLocaleService(configuration, languagePacks);
	using localization = new WorkbenchLocalizationService(localeService, languagePacks);

	await localization.whenReady;
	assert.equal(localization.translate("ash.settings", "displayLanguage.title", "Fallback"), "Display Language");
	assert.equal(localization.translate("ash.missing", "missing", "Hello {name}", { name: "Ada" }), "Hello Ada");
});

function createMarketplace(): IMarketplaceService {
	const changes = new Emitter<void>();
	return {
		onDidChangeInstalled: changes.event,
		cachedBrowse: () => undefined,
		browse: () => Promise.reject(new Error("unused")),
		refreshBrowse: () => Promise.reject(new Error("unused")),
		search: async () => [],
		get: () => Promise.reject(new Error("unused")),
		download: () => Promise.reject(new Error("unused")),
		install: () => Promise.reject(new Error("unused")),
		update: () => Promise.reject(new Error("unused")),
		uninstall: () => Promise.reject(new Error("unused")),
		listInstalled: async () => [],
		acquireCapability: () => Promise.reject(new Error("unused")),
		releaseCapability: async () => {},
		openResource: () => Promise.reject(new Error("unused")),
	};
}
