import { URI } from '../../../base/common/uri.js';
import type { LanguagePackCatalog, LanguagePackIndexEntry, PreinstalledLanguagePack } from '../common/languagePackContract.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IExtensionManagementService, type ExtensionsInstalledPackage } from '../../extensionManagement/common/extensionManagementService.js';
import { decodeBase64, normalizeLocale, parseLanguagePackCatalog } from '../common/languagePackCatalog.js';
import { ILanguagePackStore } from '../common/languagePackStore.js';
import type { ILanguagePackService, ILanguagePackItem } from '../common/languagePacks.js';
import { IMeteredConnectionService } from '../../meteredConnection/common/meteredConnection.js';

/** Browser client adapter that projects Extensions localization capabilities. */
export class WebLanguagePacksService extends Disposable implements ILanguagePackService {
	private readonly _onDidChange = this._register(new Emitter<void>());
	private readonly builtinLocales: ReadonlySet<string>;
	private readonly startupCatalogs = new Map<string, LanguagePackCatalog>();
	private cacheInitialization: Promise<void> | undefined;
	private automaticRefreshNeeded = true;
	private refreshQueued = false;
	private readonly catalogsByLocale = new Map<string, LanguagePackCatalog>();
	private readonly installedProviders = new Map<string, string>();
	private refreshPromise: Promise<void> | undefined;

	readonly onDidChange = this._onDidChange.event;
	readonly whenReady: Promise<void>;

	constructor(
		builtinCatalogs: readonly LanguagePackCatalog[],
		private readonly preinstalled: readonly PreinstalledLanguagePack[],
		@IExtensionManagementService private readonly extensionManagement: IExtensionManagementService,
		@ILanguagePackStore private readonly store: ILanguagePackStore,
		@IMeteredConnectionService private readonly meteredConnection: IMeteredConnectionService,
	) {
		super();
		this.builtinLocales = new Set(builtinCatalogs.map(catalog => normalizeLocale(catalog.locale)));
		for (const catalog of [...builtinCatalogs, ...preinstalled.map(extension => extension.catalog)]) {
			const locale = normalizeLocale(catalog.locale);
			if (locale) this.catalogsByLocale.set(locale, { ...catalog, locale });
			this.startupCatalogs.set(locale, { ...catalog, locale });
		}
		this.whenReady = this.refreshAutomatically().catch(() => undefined);
		this._register(meteredConnection.onDidChangeIsConnectionMetered(isMetered => {
			if (!isMetered && this.automaticRefreshNeeded) void this.refreshAutomatically().catch(() => undefined);
		}));
		this._register(extensionManagement.onDidChangeInstalled(() => {
			void this.refresh().catch(() => undefined);
		}));
	}

	get catalogs(): readonly LanguagePackCatalog[] {
		return [...this.catalogsByLocale.values()];
	}

	public async getInstalledLanguages(): Promise<ILanguagePackItem[]> {
		await this.whenReady;
		// Requesting the language list is explicit intent, so a postponed startup
		// sync must not prevent the user from choosing a newly installed pack.
		if (this.automaticRefreshNeeded) await this.refresh().catch(() => undefined);
		return this.catalogs.map(catalog => {
			const extensionId = this.installedProviders.get(catalog.locale)
				?? this.preinstalled.find(pack => pack.catalog.locale === catalog.locale)?.id;
			return {
				id: catalog.locale,
				label: catalog.localizedLanguageName,
				description: catalog.languageName,
				...(extensionId ? { extensionId } : {}),
			};
		}).sort((left, right) => left.id.localeCompare(right.id));
	}

	public async getBuiltInExtensionTranslationsUri(id: string, language: string): Promise<URI | undefined> {
		let locale = normalizeLocale(language);
		if (!locale || locale === 'en') return undefined;
		// Extension labels use the pinned startup snapshot. Synchronizing installed
		// packs updates the next startup, so it must not block these local lookups.
		await this.initializeCache();
		while (locale && locale !== 'en') {
			const translations = this.startupCatalogs.get(locale)?.extensionTranslations?.[id.toLowerCase()];
			if (translations) {
				return URI.from({ scheme: 'data', path: 'application/json,' + JSON.stringify({ contents: translations }) });
			}
			const separator = locale.lastIndexOf('-');
			locale = separator > 0 ? locale.slice(0, separator) : '';
		}
		return undefined;
	}

	public async refresh(): Promise<void> {
		this.automaticRefreshNeeded = false;
		this.refreshQueued = true;
		if (this.refreshPromise) { return this.refreshPromise; }
		this.refreshPromise = (async () => {
			while (this.refreshQueued && !this.isDisposed) {
				this.refreshQueued = false;
				await this.load();
			}
		})().finally(() => { this.refreshPromise = undefined; });
		return this.refreshPromise;
	}

	private async refreshAutomatically(): Promise<void> {
		// Loading local catalogs remains part of readiness. Fetching complete
		// installed catalogs is optional startup work and may wait for another network.
		await this.initializeCache();
		await this.meteredConnection.whenConnectionStateInitialized;
		if (this.isDisposed || !this.automaticRefreshNeeded || this.meteredConnection.isConnectionMetered) return;
		await this.refresh();
	}

	private initializeCache(): Promise<void> {
		this.cacheInitialization ??= (async () => {
			const cached = await this.store.readIndex().catch(() => []);
			if (this.isDisposed) return;
			for (const entry of cached) {
				if (this.builtinLocales.has(entry.locale)) { continue; }
				const preinstalled = this.preinstalled.find(pack => pack.catalog.locale === entry.locale);
				if (preinstalled && providerId(preinstalled.id) !== providerId(entry.extensionId)) { continue; }
				this.catalogsByLocale.set(entry.locale, entry.catalog);
				this.startupCatalogs.set(entry.locale, entry.catalog);
				this.installedProviders.set(entry.locale, entry.extensionId);
			}
		})();
		return this.cacheInitialization;
	}

	private async load(): Promise<void> {
		await this.initializeCache();
		if (this.isDisposed) return;
		const installed = await this.extensionManagement.listInstalled();
		const candidates = new Map<string, LanguagePackIndexEntry | undefined>();
		for (const entry of await loadInstalledCatalogs(this.extensionManagement, installed)) {
			if (this.builtinLocales.has(entry.locale)) { continue; }
			const preinstalled = this.preinstalled.find(pack => pack.catalog.locale === entry.locale);
			if (preinstalled && providerId(preinstalled.id) !== providerId(entry.extensionId)) { continue; }
			candidates.set(entry.locale, candidates.has(entry.locale) ? undefined : entry);
		}
		const loaded = [...candidates.values()].filter((entry): entry is LanguagePackIndexEntry => entry !== undefined);
		this.assertNotDisposed();
		// A complete replacement ties startup resources to current installations and removes retired providers atomically.
		await this.store.replace(loaded);
		this.assertNotDisposed();
		this.catalogsByLocale.clear();
		for (const catalog of [...this.startupCatalogs.values()]) {
			if (this.builtinLocales.has(catalog.locale)) { this.catalogsByLocale.set(catalog.locale, catalog); }
		}
		for (const pack of this.preinstalled) { this.catalogsByLocale.set(pack.catalog.locale, pack.catalog); }
		this.installedProviders.clear();
		for (const entry of loaded) {
			this.catalogsByLocale.set(entry.locale, entry.catalog);
			this.installedProviders.set(entry.locale, entry.extensionId);
		}
		this._onDidChange.fire();
	}
}

async function loadInstalledCatalogs(
	extensionManagement: IExtensionManagementService,
	installed: readonly ExtensionsInstalledPackage[],
): Promise<readonly LanguagePackIndexEntry[]> {
	const catalogs: LanguagePackIndexEntry[] = [];
	for (const packageValue of installed) {
		if (packageValue.state !== 'installed') continue;
		for (const capability of packageValue.capabilities) {
			if (capability.kind !== 'localization') continue;
			let acquired: Awaited<ReturnType<IExtensionManagementService['acquireCapability']>>;
			try {
				acquired = await extensionManagement.acquireCapability(capability.reference.id);
			} catch {
				continue;
			}
			try {
				if (acquired.spec.kind !== 'localization') continue;
				const content = await extensionManagement.openResource(acquired.lease.id, acquired.spec.catalog.id);
				let parsed: unknown;
				try {
					parsed = JSON.parse(decodeBase64(content.dataBase64));
				} catch {
					continue;
				}
				const catalog = parseLanguagePackCatalog(parsed);
				if (catalog) { catalogs.push({ locale: catalog.locale, extensionId: packageValue.package.id, version: packageValue.package.version, digest: packageValue.package.digest, catalog }); }
			} catch {
				// One unavailable resource must not hide other installed languages.
			} finally {
				await extensionManagement.releaseCapability(acquired.lease.id).catch(() => undefined);
			}
		}
	}
	return catalogs;
}

function providerId(id: string): string {
	return id.split('@', 1)[0].replace('/', '.');
}
