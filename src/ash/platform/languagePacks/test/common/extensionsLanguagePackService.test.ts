import { createTestLanguagePackStore } from '../../../../workbench/services/localization/test/common/localizationTestUtils.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { ILanguagePackStore } from '../../common/languagePackStore.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Emitter } from "../../../../base/common/event.js";
import { Event } from '../../../../base/common/event.js';
import { IMeteredConnectionService } from '../../../meteredConnection/common/meteredConnection.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { MeteredConnectionService } from '../../../meteredConnection/browser/meteredConnectionService.js';
import { IConfigurationService } from '../../../configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../configuration/common/inMemoryConfigurationService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IExtensionManagementService } from "../../../../platform/extensionManagement/common/extensionManagementService.js";
import { WebLanguagePacksService } from "../../browser/languagePacks.js";
import { parseLanguagePackCatalog, parseLanguagePackIndexEntry, resolveLanguagePackCatalog } from "../../common/languagePackCatalog.js";
import type { LanguagePackCatalog } from "../../common/languagePackContract.js";
import { builtinLanguagePackCatalogs, preinstalledLanguagePacks, productLanguagePackCatalogs } from "../../../../workbench/services/localization/common/localizationCatalogs.js";

ensureNoDisposablesAreLeakedInTestSuite();

test("English and preinstalled language packs remain available without Extensions", async () => {
	const extensionManagement = createExtensions([]);
	extensionManagement.listInstalled = async () => { throw new Error('Extensions is offline'); };
	using service = createService(extensionManagement);

	assert.deepEqual(await service.getInstalledLanguages(), [
		{ id: "en", label: "English", description: "English" },
		{ id: "zh-CN", label: "简体中文", description: "Chinese (Simplified)", extensionId: "ash/language-pack-zh-cn" },
	]);
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
	assert.deepEqual((await service.getInstalledLanguages()).find(locale => locale.id === "fr"), {
		id: "fr", label: "Français", description: "French", extensionId: "example/localization-fr-0",
	});
});

function createExtensions(catalogs: readonly LanguagePackCatalog[]): IExtensionManagementService {
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
		onDidChangeInstalled: Event.None,
		searchPage: async () => { throw new Error('Language packs do not use customization paging'); },
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
		listBuiltInProviders: async () => ({ revision: 1, canChangeEnablement: false, providers: [] }),
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

function createService(extensionManagement: IExtensionManagementService, store: Partial<ILanguagePackStore> = {}, meteredConnection: IMeteredConnectionService = { _serviceBrand: undefined, isConnectionMetered: false, onDidChangeIsConnectionMetered: Event.None }): WebLanguagePacksService {
	using services = new InstantiationService();
	services.registerInstance(IMeteredConnectionService, meteredConnection);
	services.registerInstance(IExtensionManagementService, extensionManagement);
	services.registerInstance(ILanguagePackStore, createTestLanguagePackStore(store));
	return services.createInstance(WebLanguagePacksService, builtinLanguagePackCatalogs, preinstalledLanguagePacks);
}

test('metered startup retains cached language resources and resumes one catalog synchronization', async () => {
	using services = new InstantiationService();
	using configuration = new InMemoryConfigurationService();
	services.registerInstance(IConfigurationService, configuration);
	const connection = Object.assign(new EventTarget(), { metered: true });
	using policy = services.createInstance(MeteredConnectionService, () => connection);
	const catalog: LanguagePackCatalog = { schemaVersion: 1, locale: 'fr', languageName: 'French', localizedLanguageName: 'Français', catalogVersion: 'ash-1', bundles: { ash: { hello: 'Bonjour' } }, extensionTranslations: { example: { package: {}, bundle: { greeting: 'Bonjour' } } } };
	const extensionManagement = createExtensions([catalog]);
	let listCalls = 0;
	let resourceCalls = 0;
	const listInstalled = extensionManagement.listInstalled.bind(extensionManagement);
	const openResource = extensionManagement.openResource.bind(extensionManagement);
	extensionManagement.listInstalled = () => { listCalls++; return listInstalled(); };
	extensionManagement.openResource = (...args) => { resourceCalls++; return openResource(...args); };
	const synchronized = new DeferredPromise<void>();
	using service = createService(extensionManagement, {
		readIndex: async () => [{ locale: 'fr', extensionId: 'example/localization-fr-0', version: '0.9.0', digest: `sha256:${'b'.repeat(64)}`, catalog }],
		replace: async () => { void synchronized.complete(); },
	}, policy);
	await service.whenReady;
	assert.equal(service.catalogs.some(catalog => catalog.locale === 'fr'), true);
	const translations = await service.getBuiltInExtensionTranslationsUri('example', 'fr');
	assert.ok(translations?.path.includes('Bonjour'));
	assert.deepEqual({ listCalls, resourceCalls }, { listCalls: 0, resourceCalls: 0 });
	connection.metered = false;
	connection.dispatchEvent(new globalThis.Event('change'));
	connection.dispatchEvent(new globalThis.Event('change'));
	await synchronized.p;
	assert.deepEqual({ listCalls, resourceCalls }, { listCalls: 1, resourceCalls: 1 });
	service.dispose();
	connection.dispatchEvent(new globalThis.Event('change'));
	assert.equal(listCalls, 1);
});

test('explicit language listing and refresh bypass metered startup deferral', async () => {
	using changes = new Emitter<boolean>();
	let isMetered = true;
	const policy: IMeteredConnectionService = { _serviceBrand: undefined, get isConnectionMetered() { return isMetered; }, onDidChangeIsConnectionMetered: changes.event };
	const catalog: LanguagePackCatalog = { schemaVersion: 1, locale: 'fr', languageName: 'French', localizedLanguageName: 'Français', catalogVersion: 'ash-1', bundles: { ash: { hello: 'Bonjour' } } };
	const extensionManagement = createExtensions([catalog]);
	const listInstalled = extensionManagement.listInstalled.bind(extensionManagement);
	let listCalls = 0;
	extensionManagement.listInstalled = () => { listCalls++; return listInstalled(); };
	using service = createService(extensionManagement, {}, policy);
	await service.whenReady;
	assert.equal(listCalls, 0);
	assert.ok((await service.getInstalledLanguages()).some(language => language.id === 'fr'));
	await service.refresh();
	assert.equal(listCalls, 2);
	isMetered = false;
	changes.fire(false);
	await Promise.resolve();
	assert.equal(listCalls, 2);
});

test('installation changes refresh language resources even while startup sync is deferred', async () => {
	using installedChanges = new Emitter<void>();
	const catalog: LanguagePackCatalog = { schemaVersion: 1, locale: 'fr', languageName: 'French', localizedLanguageName: 'Français', catalogVersion: 'ash-1', bundles: { ash: { hello: 'Bonjour' } } };
	const extensionManagement = { ...createExtensions([catalog]), onDidChangeInstalled: installedChanges.event };
	const saved = new DeferredPromise<void>();
	using service = createService(extensionManagement, { replace: async () => { void saved.complete(); } }, {
		_serviceBrand: undefined, isConnectionMetered: true, onDidChangeIsConnectionMetered: Event.None,
	});
	await service.whenReady;
	installedChanges.fire();
	await saved.p;
});

test('disposing before network recovery does not fetch deferred language resources', async () => {
	using changes = new Emitter<boolean>();
	let isMetered = true;
	const extensionManagement = createExtensions([]);
	let requests = 0;
	extensionManagement.listInstalled = async () => { requests++; return []; };
	using service = createService(extensionManagement, {}, {
		_serviceBrand: undefined, get isConnectionMetered() { return isMetered; }, onDidChangeIsConnectionMetered: changes.event,
	});
	await service.whenReady;
	service.dispose();
	isMetered = false;
	changes.fire(false);
	await Promise.resolve();
	assert.equal(requests, 0);
});

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
		assert.deepEqual((await service.getInstalledLanguages()).map(value => value.id), ['de', 'en', 'zh-CN']);
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
	assert.deepEqual((await service.getInstalledLanguages()).map(value => value.id), ['de', 'en', 'zh-CN']);
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
	assert.equal((await service.getInstalledLanguages()).find(pack => pack.id === 'zh-CN')?.extensionId, 'ash.language-pack-zh-cn@official');
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
	assert.equal((await service.getInstalledLanguages()).some(pack => pack.id === 'fr'), false);
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


test('extension translations wait only for the pinned local index while installed synchronization is pending', async () => {
	const cache = new DeferredPromise<Awaited<ReturnType<ILanguagePackStore['readIndex']>>>();
	const installed = new DeferredPromise<void>();
	const englishRead = new DeferredPromise<void>();
	const extensions = createExtensions([]);
	extensions.listInstalled = async () => { await installed.p; return []; };
	const catalog: LanguagePackCatalog = {
		schemaVersion: 1, locale: 'fr', languageName: 'French', localizedLanguageName: 'Français', catalogVersion: 'ash-1',
		bundles: { ash: { hello: 'Bonjour' } }, extensionTranslations: { example: { package: { title: 'Bonjour' }, bundle: {} } },
	};
	using service = createService(extensions, { readIndex: () => cache.p });
	let ready = false;
	void service.whenReady.then(() => { ready = true; });
	try {
		let english: unknown = 'pending';
		const readingEnglish = service.getBuiltInExtensionTranslationsUri('example', 'en').then(value => { english = value; void englishRead.complete(); });
		await Promise.resolve();
		assert.equal(english, undefined, 'English lookup must complete even while the local index is pending');
		await englishRead.p;
		await readingEnglish;
		let localized = false;
		const readingFrench = service.getBuiltInExtensionTranslationsUri('example', 'fr-CA').then(value => { localized = true; return value; });
		await Promise.resolve();
		assert.equal(localized, false, 'Cached language provenance must load before localized labels');
		await cache.complete([{ locale: 'fr', extensionId: 'example/localization-fr-0', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, catalog }]);
		const uri = await readingFrench;
		assert.deepEqual(JSON.parse(uri!.path.slice('application/json,'.length)).contents, catalog.extensionTranslations!.example);
		const chinese = await service.getBuiltInExtensionTranslationsUri('ash.git', 'zh-CN');
		assert.ok(chinese?.path.includes('分支'));
		assert.equal(ready, false, 'Neither translation needs the pending installed-package synchronization');
	} finally {
		if (!cache.isSettled) await cache.complete([]);
		await installed.complete();
		await service.whenReady;
	}
});
