import { createTestLanguagePackStore } from '../../../../workbench/services/localization/test/common/localizationTestUtils.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { ILanguagePackStore } from '../../common/languagePackStore.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Emitter } from "../../../../base/common/event.js";
import { IExtensionManagementService } from "../../../../platform/extensionManagement/common/extensionManagementService.js";
import { ExtensionsLanguagePackService } from "../../browser/extensionsLanguagePackService.js";
import { parseLanguagePackCatalog, parseLanguagePackIndexEntry, resolveLanguagePackCatalog } from "../../common/languagePackCatalog.js";
import type { LanguagePackCatalog } from "../../common/languagePacksService.js";
import { builtinLanguagePackCatalogs, preinstalledLanguagePacks, productLanguagePackCatalogs } from "../../../../workbench/services/localization/common/localizationCatalogs.js";

test("English and preinstalled language packs remain available without Extensions", async () => {
	const extensionManagement = createExtensions([]);
	extensionManagement.listInstalled = async () => { throw new Error('Extensions is offline'); };
	using service = createService(extensionManagement);

	await service.whenReady;
	assert.deepEqual(service.availableLocales.map(locale => locale.locale), ["en", "zh-CN"]);
	assert.deepEqual(service.availableLocales.map(locale => locale.source), ['builtin', 'preinstalled']);
	assert.deepEqual(service.installedPackages.map(pack => pack.id), ['ash/language-pack-zh-cn']);
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

test("Extensions localization capability resources become installed language packs", async () => {
	const catalog: LanguagePackCatalog = {
		schemaVersion: 1,
		locale: "fr",
		languageName: "French",
		localizedLanguageName: "Français",
		catalogVersion: "ash-1",
		bundles: { "ash.test": { greeting: "Bonjour" } },
	};
	const extensionManagement = createExtensions([catalog]);
	using service = createService(extensionManagement);

	await service.whenReady;
	assert.equal(service.availableLocales.some(locale => locale.locale === "fr" && locale.source === "extensionManagement"), true);
	assert.equal(service.installedPackages[0]?.installed, true);
	assert.equal((await service.search("", 10))[0]?.installed, true);
});

function createExtensions(catalogs: readonly LanguagePackCatalog[]): IExtensionManagementService {
	const changes = new Emitter<void>();
	const installed = catalogs.map((catalog, index) => ({
		installationId: `installation.localization.${index}`,
		package: { id: `example/localization-${catalog.locale.toLowerCase()}-${index}`, version: "1.0.0", digest: `sha256:${"a".repeat(64)}` },
		state: "installed" as const,
		capabilities: [{
			reference: { id: `capability.localization.${index}` },
			kind: "localization" as const,
			id: "localization.fr",
			contractVersion: "ash-localization-1",
			permissions: [],
			authenticationProvider: null,
		}],
	}));
	return {
		onDidChangeInstalled: changes.event,
		sources: async () => ({ revision: 0, sources: [] }),
		addSource: async () => { throw new Error("unused"); },
		setSourceEnabled: async () => { throw new Error("unused"); },
		cachedBrowse: () => undefined,
		browse: () => Promise.reject(new Error("unused")),
		refreshBrowse: () => Promise.reject(new Error("unused")),
		search: async () => [{ id: "example/localization-fr-0", version: "1.0.0", packageType: "localization", displayName: "Français", description: "French" }],
		get: () => Promise.reject(new Error("unused")),
		download: () => Promise.reject(new Error("unused")),
		install: async () => installed[0]!,
		update: () => Promise.reject(new Error("unused")),
		uninstall: () => Promise.reject(new Error("unused")),
		listInstalled: async () => installed,
		listBuiltInProviders: async () => ({ revision: 1, providers: [] }),
		setBuiltInProviderEnabled: () => Promise.reject(new Error('unused')),
		listEditorExtensions: () => Promise.reject(new Error('Execution policy is outside this language-pack fixture')),
		setEditorExtensionPolicy: () => Promise.reject(new Error('Execution policy is outside this language-pack fixture')),
		acquireCapability: async id => ({
			lease: { id, capability: { id }, installationId: id.replace('capability', 'installation') },
			spec: { kind: "localization" as const, contractVersion: "1", catalog: { id: "catalog.json" } },
		}),
		releaseCapability: async () => { },
		openResource: async lease => ({ mediaType: "application/json", dataBase64: Buffer.from(JSON.stringify(catalogs[Number(lease.split('.').at(-1))]), "utf8").toString("base64") }),
	};
}

function createService(extensionManagement: IExtensionManagementService, store: Partial<ILanguagePackStore> = {}): ExtensionsLanguagePackService {
	using services = new InstantiationService();
	services.registerInstance(IExtensionManagementService, extensionManagement);
	services.registerInstance(ILanguagePackStore, createTestLanguagePackStore(store));
	return services.createInstance(ExtensionsLanguagePackService, builtinLanguagePackCatalogs, preinstalledLanguagePacks);
}

test('installed pack updates are saved for the next startup before they are advertised', async () => {
	const catalogs: LanguagePackCatalog[] = [{ schemaVersion: 1, locale: 'fr', languageName: 'French', localizedLanguageName: 'Français', catalogVersion: 'ash-1', bundles: { ash: { hello: 'Bonjour' } } }];
	const saved: LanguagePackCatalog[] = [];
	using service = createService(createExtensions(catalogs), { read: async () => undefined, write: async catalog => { saved.push(catalog); } });
	await service.whenReady;
	catalogs[0] = { ...catalogs[0], bundles: { ash: { hello: 'Salut' } } };
	await service.refresh();
	assert.deepEqual(saved.map(catalog => catalog.bundles.ash.hello), ['Bonjour', 'Salut']);
	assert.deepEqual(service.catalogs.find(catalog => catalog.locale === 'fr'), catalogs[0]);
});

test('a failed resource save preserves the published installed language catalog', async () => {
	const catalogs: LanguagePackCatalog[] = [{ schemaVersion: 1, locale: 'fr', languageName: 'French', localizedLanguageName: 'Français', catalogVersion: 'ash-1', bundles: { ash: { hello: 'Bonjour' } } }];
	let failWrite = false;
	using service = createService(createExtensions(catalogs), { read: async () => undefined, write: async () => { if (failWrite) throw new Error('storage full'); } });
	await service.whenReady;
	const published = service.catalogs.find(catalog => catalog.locale === 'fr');
	catalogs[0] = { ...catalogs[0], bundles: { ash: { hello: 'Salut' } } };
	failWrite = true;
	await assert.rejects(service.refresh(), /storage full/);
	assert.equal(service.catalogs.find(catalog => catalog.locale === 'fr'), published);
});

test('the Ash French example package loads through the localization capability', async () => {
	const catalog = parseLanguagePackCatalog(JSON.parse(await readFile(resolve('localization/examples/fr/localization/package.json'), 'utf8')))!;
	assert.ok(catalog);
	const saved: LanguagePackCatalog[] = [];
	using service = createService(createExtensions([catalog]), { read: async () => undefined, write: async value => { saved.push(value); } });
	await service.whenReady;
	assert.deepEqual(service.catalogs.find(value => value.locale === 'fr'), catalog);
	assert.deepEqual(saved, [catalog]);
});

test('conflicting locale providers cannot overwrite resources or hide other languages', async () => {
	const first: LanguagePackCatalog = { schemaVersion: 1, locale: 'fr', languageName: 'French', localizedLanguageName: 'Français', catalogVersion: 'ash-1', bundles: { ash: { hello: 'Bonjour' } } };
	const second = { ...first, locale: 'FR', bundles: { ash: { hello: 'Salut' } } };
	const german = { ...first, locale: 'de', languageName: 'German', localizedLanguageName: 'Deutsch' };
	for (const catalogs of [[first, second, german], [second, german, first]]) {
		const saved: LanguagePackCatalog[] = [];
		using service = createService(createExtensions(catalogs), { read: async () => undefined, write: async value => { saved.push(value); } });
		await service.whenReady;
		assert.deepEqual(service.availableLocales.map(value => value.locale), ['de', 'en', 'zh-CN']);
		assert.deepEqual(saved, [german]);
	}
});

test('preinstalled catalogs cannot be replaced by an installed provider', async () => {
	const catalog = { ...productLanguagePackCatalogs.find(value => value.locale === 'zh-CN')!, bundles: { ash: { hello: 'replacement' } } };
	using service = createService(createExtensions([catalog]), { read: async () => undefined, write: async () => { assert.fail('Foreign providers must not replace a preinstalled language'); } });
	await service.whenReady;
	assert.deepEqual(service.catalogs.find(value => value.locale === 'zh-CN'), productLanguagePackCatalogs.find(value => value.locale === 'zh-CN'));
});

test('an unreadable provider releases its lease and does not hide another locale', async () => {
	const catalog: LanguagePackCatalog = { schemaVersion: 1, locale: 'fr', languageName: 'French', localizedLanguageName: 'Français', catalogVersion: 'ash-1', bundles: { ash: { hello: 'Bonjour' } } };
	const extensions = createExtensions([catalog, { ...catalog, locale: 'de' }]);
	const openResource = extensions.openResource;
	const released: string[] = [];
	extensions.openResource = async (lease, resource) => {
		if (lease.endsWith('.0')) { throw new Error('resource unavailable'); }
		return openResource(lease, resource);
	};
	extensions.releaseCapability = async lease => { released.push(lease); };
	using service = createService(extensions);
	await service.whenReady;
	assert.deepEqual(service.availableLocales.map(value => value.locale), ['de', 'en', 'zh-CN']);
	assert.deepEqual(released, ['capability.localization.0', 'capability.localization.1']);
});

test('the preinstalled Chinese extension can update independently and uninstall restores the bundled version', async () => {
	const original = productLanguagePackCatalogs.find(value => value.locale === 'zh-CN')!;
	const updated = { ...original, bundles: { ...original.bundles, ash: { ...original.bundles.ash, greeting: '更新后的语言包' } } };
	const extensions = createExtensions([updated]);
	const installed = await extensions.listInstalled();
	let current = [{ ...installed[0], package: { ...installed[0].package, id: 'ash.language-pack-zh-cn@official', version: '1.1.0' } }];
	extensions.listInstalled = async () => current;
	const store = createTestLanguagePackStore();
	using service = createService(extensions, store);
	await service.whenReady;
	assert.equal(service.installedPackages.find(pack => pack.id === 'ash.language-pack-zh-cn@official')?.version, '1.1.0');
	assert.equal(service.installedPackages.length, 1);
	assert.equal(service.availableLocales.find(pack => pack.locale === 'zh-CN')?.source, 'extensionManagement');
	assert.equal((await resolveLanguagePackCatalog('zh-CN', productLanguagePackCatalogs, store)).bundles.ash.greeting, '更新后的语言包');
	assert.deepEqual((await store.readIndex()).map(({ extensionId, version, locale }) => ({ extensionId, version, locale })), [{ extensionId: 'ash.language-pack-zh-cn@official', version: '1.1.0', locale: 'zh-CN' }]);
	current = [];
	await service.refresh();
	assert.deepEqual(await store.readIndex(), []);
	assert.deepEqual(await resolveLanguagePackCatalog('zh-CN', productLanguagePackCatalogs, store), original);
});

test('uninstall removes a language provider from startup resources and falls back to English', async () => {
	const catalog: LanguagePackCatalog = { schemaVersion: 1, locale: 'fr', languageName: 'French', localizedLanguageName: 'Français', catalogVersion: 'ash-1', bundles: { ash: { hello: 'Bonjour' } } };
	const extensions = createExtensions([catalog]);
	let installed = await extensions.listInstalled();
	extensions.listInstalled = async () => installed;
	const store = createTestLanguagePackStore();
	using service = createService(extensions, store);
	await service.whenReady;
	assert.equal((await resolveLanguagePackCatalog('fr-CA', productLanguagePackCatalogs, store)).locale, 'fr');
	installed = [];
	await service.refresh();
	assert.equal((await resolveLanguagePackCatalog('fr-CA', productLanguagePackCatalogs, store)).locale, 'en');
	assert.equal(service.availableLocales.some(pack => pack.locale === 'fr'), false);
});

test('English remains the fallback even when an installed provider declares English', async () => {
	const catalog = { ...builtinLanguagePackCatalogs[0], bundles: { ash: { hello: 'replacement' } } };
	const store = createTestLanguagePackStore();
	using service = createService(createExtensions([catalog]), store);
	await service.whenReady;
	assert.deepEqual(await store.readIndex(), []);
	assert.deepEqual(await resolveLanguagePackCatalog('en', productLanguagePackCatalogs, store), builtinLanguagePackCatalogs[0]);
});

test('extension translation resources stay pinned to the startup version until restart', async () => {
	const original = productLanguagePackCatalogs.find(value => value.locale === 'zh-CN')!;
	const store = createTestLanguagePackStore();
	const updated = { ...original, extensionTranslations: { 'ash.git': { package: { 'git.menu.branch': '新版分支' }, bundle: { 'Hello {0}': '你好 {0}' } } } };
	await store.replace([{ locale: 'zh-CN', extensionId: 'ash/language-pack-zh-cn', version: '2.0.0', digest: `sha256:${'a'.repeat(64)}`, catalog: updated }]);
	const extensions = createExtensions([]);
	extensions.listInstalled = async () => { throw new Error('offline'); };
	using service = createService(extensions, store);
	await service.whenReady;
	const uri = await service.getBuiltInExtensionTranslationsUri('ASH.GIT', 'zh-CN');
	assert.ok(uri);
	assert.deepEqual(JSON.parse(uri.path.slice('application/json,'.length)).contents, updated.extensionTranslations['ash.git']);
	assert.equal(await service.getBuiltInExtensionTranslationsUri('ash.git', 'en'), undefined);
	assert.equal(await service.getBuiltInExtensionTranslationsUri('unknown.extension', 'zh-CN'), undefined);
});

test('startup index accepts source-qualified package identities and rejects damaged provenance', () => {
	const catalog = productLanguagePackCatalogs.find(value => value.locale === 'zh-CN')!;
	const entry = { locale: 'zh-CN', extensionId: 'ash.language-pack-zh-cn@official', version: '1.1.0', digest: `sha256:${'a'.repeat(64)}`, catalog };
	for (const extensionId of ['ash.language-pack-zh-cn@official', 'language_zh@custom-source', 'ash/language-pack-zh-cn']) {
		assert.equal(parseLanguagePackIndexEntry({ ...entry, extensionId })?.extensionId, extensionId);
	}
	for (const extensionId of ['../other', 'pack@other/source', 'pack@@source', 'x'.repeat(161)]) {
		assert.equal(parseLanguagePackIndexEntry({ ...entry, extensionId }), undefined);
	}
	assert.equal(parseLanguagePackIndexEntry({ ...entry, digest: 'unverified' }), undefined);
	assert.equal(parseLanguagePackIndexEntry({ ...entry, locale: 'de' }), undefined);
});
