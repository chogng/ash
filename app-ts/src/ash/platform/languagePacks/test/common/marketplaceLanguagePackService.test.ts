import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { ILanguagePackStore } from '../../common/languagePackStore.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter } from "../../../../base/common/event.js";
import { IMarketplaceService } from "../../../../platform/marketplace/common/marketplaceService.js";
import { MarketplaceLanguagePackService } from "../../browser/marketplaceLanguagePackService.js";
import { parseLanguagePackCatalog } from "../../common/languagePackCatalog.js";
import type { LanguagePackCatalog } from "../../common/languagePacksService.js";
import { builtinLanguagePackCatalogs } from "../../../../workbench/services/localization/common/localizationCatalogs.js";

test("language packs keep built-ins available without Marketplace", async () => {
	const marketplace = createMarketplace([]);
	using service = createService(marketplace);

	await service.whenReady;
	assert.deepEqual(service.availableLocales.map(locale => locale.locale), ["en", "zh-CN"]);
	assert.deepEqual(service.installedPackages, []);
});

test("language pack catalogs are validated before projection", () => {
	const valid = {
		schemaVersion: 1,
		locale: "fr-CA",
		languageName: "French",
		localizedLanguageName: "Français",
		catalogVersion: "ash-1",
		bundles: { "ash.test": { greeting: "Bonjour" } },
	};
	assert.equal(parseLanguagePackCatalog(valid)?.locale, "fr-CA");
	assert.equal(parseLanguagePackCatalog({ ...valid, catalogVersion: "other-product-1" }), undefined);
	assert.equal(parseLanguagePackCatalog({ ...valid, bundles: {} }), undefined);
});

test("Marketplace localization capability resources become installed language packs", async () => {
	const catalog: LanguagePackCatalog = {
		schemaVersion: 1,
		locale: "fr",
		languageName: "French",
		localizedLanguageName: "Français",
		catalogVersion: "ash-1",
		bundles: { "ash.test": { greeting: "Bonjour" } },
	};
	const marketplace = createMarketplace([catalog]);
	using service = createService(marketplace);

	await service.whenReady;
	assert.equal(service.availableLocales.some(locale => locale.locale === "fr" && locale.source === "marketplace"), true);
	assert.equal(service.installedPackages[0]?.installed, true);
	assert.equal((await service.search("", 10))[0]?.installed, true);
});

function createMarketplace(catalogs: readonly LanguagePackCatalog[]): IMarketplaceService {
	const changes = new Emitter<void>();
	const installed = catalogs.length > 0 ? [{
		installationId: "installation.localization.fr",
		package: { id: "example.localization.fr", version: "1.0.0", digest: `sha256:${"a".repeat(64)}` },
		state: "installed" as const,
		capabilities: [{
			reference: { id: "capability.localization.fr" },
			kind: "localization" as const,
			id: "localization.fr",
			contractVersion: "ash-localization-1",
			permissions: [],
			authenticationProvider: null,
		}],
	}] : [];
	return {
		onDidChangeInstalled: changes.event,
		cachedBrowse: () => undefined,
		browse: () => Promise.reject(new Error("unused")),
		refreshBrowse: () => Promise.reject(new Error("unused")),
		search: async () => [{ id: "example.localization.fr", version: "1.0.0", packageType: "localization", displayName: "Français", description: "French" }],
		get: () => Promise.reject(new Error("unused")),
		download: () => Promise.reject(new Error("unused")),
		install: async () => installed[0]!,
		update: () => Promise.reject(new Error("unused")),
		uninstall: () => Promise.reject(new Error("unused")),
		listInstalled: async () => installed,
		listEditorExtensions: () => Promise.reject(new Error('Execution policy is outside this language-pack fixture')),
		setEditorExtensionPolicy: () => Promise.reject(new Error('Execution policy is outside this language-pack fixture')),
		acquireCapability: async () => ({
			lease: { id: "lease.localization.fr", capability: { id: "capability.localization.fr" }, installationId: "installation.localization.fr" },
			spec: { kind: "localization" as const, contractVersion: "ash-localization-1", catalog: { id: "catalog.json" } },
		}),
		releaseCapability: async () => { },
		openResource: async () => ({ mediaType: "application/json", dataBase64: Buffer.from(JSON.stringify(catalogs[0]), "utf8").toString("base64") }),
	};
}

function createService(marketplace: IMarketplaceService, store: ILanguagePackStore = { read: async () => undefined, write: async () => { } }): MarketplaceLanguagePackService {
	using services = new InstantiationService();
	services.registerInstance(IMarketplaceService, marketplace);
	services.registerInstance(ILanguagePackStore, store);
	return services.createInstance(MarketplaceLanguagePackService, builtinLanguagePackCatalogs);
}

test('installed pack updates are saved for the next startup before they are advertised', async () => {
	const catalogs: LanguagePackCatalog[] = [{ schemaVersion: 1, locale: 'fr', languageName: 'French', localizedLanguageName: 'Français', catalogVersion: 'ash-1', bundles: { ash: { hello: 'Bonjour' } } }];
	const saved: LanguagePackCatalog[] = [];
	using service = createService(createMarketplace(catalogs), { read: async () => undefined, write: async catalog => { saved.push(catalog); } });
	await service.whenReady;
	catalogs[0] = { ...catalogs[0], bundles: { ash: { hello: 'Salut' } } };
	await service.refresh();
	assert.deepEqual(saved.map(catalog => catalog.bundles.ash.hello), ['Bonjour', 'Salut']);
	assert.deepEqual(service.catalogs.find(catalog => catalog.locale === 'fr'), catalogs[0]);
});

test('a failed resource save preserves the published installed language catalog', async () => {
	const catalogs: LanguagePackCatalog[] = [{ schemaVersion: 1, locale: 'fr', languageName: 'French', localizedLanguageName: 'Français', catalogVersion: 'ash-1', bundles: { ash: { hello: 'Bonjour' } } }];
	let failWrite = false;
	using service = createService(createMarketplace(catalogs), { read: async () => undefined, write: async () => { if (failWrite) throw new Error('storage full'); } });
	await service.whenReady;
	const published = service.catalogs.find(catalog => catalog.locale === 'fr');
	catalogs[0] = { ...catalogs[0], bundles: { ash: { hello: 'Salut' } } };
	failWrite = true;
	await assert.rejects(service.refresh(), /storage full/);
	assert.equal(service.catalogs.find(catalog => catalog.locale === 'fr'), published);
});
