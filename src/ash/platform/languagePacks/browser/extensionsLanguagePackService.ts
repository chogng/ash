import { URI } from "../../../base/common/uri.js";
import type { LanguagePackIndexEntry } from "../common/languagePackContract.js";
import { Emitter } from "../../../base/common/event.js";
import { Disposable } from "../../../base/common/lifecycle.js";
import { IExtensionManagementService, type ExtensionsInstalledPackage } from "../../extensionManagement/common/extensionManagementService.js";
import { decodeBase64, normalizeLocale, parseLanguagePackCatalog } from "../common/languagePackCatalog.js";
import { ILanguagePackStore } from "../common/languagePackStore.js";
import type { ILanguagePackService, LanguagePackCatalog, LanguagePackInfo, LanguagePackPackage, PreinstalledLanguagePack } from "../common/languagePacksService.js";

/** Browser client adapter that projects Extensions localization capabilities. */
export class ExtensionsLanguagePackService extends Disposable implements ILanguagePackService {
	private readonly _onDidChange = this._register(new Emitter<void>());
	private readonly builtinLocales: ReadonlySet<string>;
	private readonly preinstalledLocales: ReadonlySet<string>;
	private readonly startupCatalogs = new Map<string, LanguagePackCatalog>();
	private initialized = false;
	private refreshQueued = false;
	private readonly catalogsByLocale = new Map<string, LanguagePackCatalog>();
	private extensionManagementLocales = new Set<string>();
	private _installedPackages: readonly LanguagePackPackage[] = [];
	private refreshPromise: Promise<void> | undefined;

	readonly onDidChange = this._onDidChange.event;
	readonly whenReady: Promise<void>;

	constructor(
		builtinCatalogs: readonly LanguagePackCatalog[],
		private readonly preinstalled: readonly PreinstalledLanguagePack[],
		@IExtensionManagementService private readonly extensionManagement: IExtensionManagementService,
		@ILanguagePackStore private readonly store: ILanguagePackStore,
	) {
		super();
		this.builtinLocales = new Set(builtinCatalogs.map(catalog => normalizeLocale(catalog.locale)));
		this.preinstalledLocales = new Set(preinstalled.map(extension => normalizeLocale(extension.catalog.locale)));
		for (const catalog of [...builtinCatalogs, ...preinstalled.map(extension => extension.catalog)]) {
			const locale = normalizeLocale(catalog.locale);
			if (locale) this.catalogsByLocale.set(locale, { ...catalog, locale });
			this.startupCatalogs.set(locale, { ...catalog, locale });
		}
		this.whenReady = this.refresh().catch(() => undefined);
		this._register(extensionManagement.onDidChangeInstalled(() => {
			void this.refresh().catch(() => undefined);
		}));
	}

	get catalogs(): readonly LanguagePackCatalog[] {
		return [...this.catalogsByLocale.values()];
	}

	get availableLocales(): readonly LanguagePackInfo[] {
		return this.catalogs.map(catalog => {
			let source: LanguagePackInfo['source'] = "extensionManagement";
			if (this.builtinLocales.has(catalog.locale)) { source = "builtin"; }
			else if (this.preinstalledLocales.has(catalog.locale) && !this.extensionManagementLocales.has(catalog.locale)) { source = "preinstalled"; }
			return { locale: catalog.locale, languageName: catalog.languageName, localizedLanguageName: catalog.localizedLanguageName, source };
		}).sort((left, right) => left.locale.localeCompare(right.locale));
	}

	get installedPackages(): readonly LanguagePackPackage[] {
		const updatedIds = new Set(this._installedPackages.map(extension => providerId(extension.id)));
		return [...this.preinstalled.filter(extension => !updatedIds.has(providerId(extension.id))).map(({ catalog: _catalog, ...extension }) => ({ ...extension, installed: true })), ...this._installedPackages];
	}

	async search(query: string, limit?: number): Promise<readonly LanguagePackPackage[]> {
		const packages = await this.extensionManagement.search(query, { packageType: "localization", limit });
		const installed = new Set(this.installedPackages.map(packageValue => `${packageValue.id}\0${packageValue.version}`));
		return packages.map(packageValue => ({
			id: packageValue.id,
			version: packageValue.version,
			displayName: packageValue.displayName,
			description: packageValue.description,
			installed: installed.has(`${packageValue.id}\0${packageValue.version}`),
		}));
	}

	async install(packageId: string, version?: string): Promise<void> {
		await this.extensionManagement.install(packageId, version);
		await this.refresh();
	}

	public async getBuiltInExtensionTranslationsUri(id: string, language: string): Promise<URI | undefined> {
		await this.whenReady;
		let locale = normalizeLocale(language);
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

	private async load(): Promise<void> {
		if (!this.initialized) {
			const cached = await this.store.readIndex().catch(() => []);
			for (const entry of cached) {
				if (this.builtinLocales.has(entry.locale)) { continue; }
				const preinstalled = this.preinstalled.find(pack => pack.catalog.locale === entry.locale);
				if (preinstalled && providerId(preinstalled.id) !== providerId(entry.extensionId)) { continue; }
				this.catalogsByLocale.set(entry.locale, entry.catalog);
				this.startupCatalogs.set(entry.locale, entry.catalog);
				this.extensionManagementLocales.add(entry.locale);
			}
			this.initialized = true;
		}
		const installed = await this.extensionManagement.listInstalled();
		const installedPackages = installed
			.filter(packageValue => packageValue.state === 'installed' && packageValue.capabilities.some(capability => capability.kind === 'localization'))
			.map(packageValue => ({ id: packageValue.package.id, version: packageValue.package.version, displayName: packageValue.package.id, description: '', installed: true }));
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
		this.extensionManagementLocales.clear();
		for (const entry of loaded) {
			this.catalogsByLocale.set(entry.locale, entry.catalog);
			this.extensionManagementLocales.add(entry.locale);
		}
		this._installedPackages = installedPackages;
		this._onDidChange.fire();
	}
}

async function loadInstalledCatalogs(
	extensionManagement: IExtensionManagementService,
	installed: readonly ExtensionsInstalledPackage[],
): Promise<readonly LanguagePackIndexEntry[]> {
	const catalogs: LanguagePackIndexEntry[] = [];
	for (const packageValue of installed) {
		if (packageValue.state !== "installed") continue;
		for (const capability of packageValue.capabilities) {
			if (capability.kind !== "localization") continue;
			let acquired: Awaited<ReturnType<IExtensionManagementService["acquireCapability"]>>;
			try {
				acquired = await extensionManagement.acquireCapability(capability.reference.id);
			} catch {
				continue;
			}
			try {
				if (acquired.spec.kind !== "localization") continue;
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
