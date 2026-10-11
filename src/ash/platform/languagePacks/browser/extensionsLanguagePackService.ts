import { Emitter } from "../../../base/common/event.js";
import { Disposable } from "../../../base/common/lifecycle.js";
import { IExtensionManagementService, type ExtensionsInstalledPackage } from "../../extensionManagement/common/extensionManagementService.js";
import { decodeBase64, normalizeLocale, parseLanguagePackCatalog } from "../common/languagePackCatalog.js";
import { ILanguagePackStore } from "../common/languagePackStore.js";
import type { ILanguagePackService, LanguagePackCatalog, LanguagePackInfo, LanguagePackPackage } from "../common/languagePacksService.js";

/** Browser client adapter that projects Extensions localization capabilities. */
export class ExtensionsLanguagePackService extends Disposable implements ILanguagePackService {
	private readonly _onDidChange = this._register(new Emitter<void>());
	private readonly builtinLocales: ReadonlySet<string>;
	private readonly catalogsByLocale = new Map<string, LanguagePackCatalog>();
	private extensionManagementLocales = new Set<string>();
	private _installedPackages: readonly LanguagePackPackage[] = [];
	private refreshPromise: Promise<void> | undefined;

	readonly onDidChange = this._onDidChange.event;
	readonly whenReady: Promise<void>;

	constructor(
		builtinCatalogs: readonly LanguagePackCatalog[],
		@IExtensionManagementService private readonly extensionManagement: IExtensionManagementService,
		@ILanguagePackStore private readonly store: ILanguagePackStore,
	) {
		super();
		this.builtinLocales = new Set(builtinCatalogs.map(catalog => normalizeLocale(catalog.locale)));
		for (const catalog of builtinCatalogs) {
			const locale = normalizeLocale(catalog.locale);
			if (locale) this.catalogsByLocale.set(locale, { ...catalog, locale });
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
		return this.catalogs.map(catalog => ({
			locale: catalog.locale,
			languageName: catalog.languageName,
			localizedLanguageName: catalog.localizedLanguageName,
			source: this.builtinLocales.has(catalog.locale) ? "builtin" as const : "extensionManagement" as const,
		})).sort((left, right) => left.locale.localeCompare(right.locale));
	}

	get installedPackages(): readonly LanguagePackPackage[] {
		return this._installedPackages;
	}

	async search(query: string, limit?: number): Promise<readonly LanguagePackPackage[]> {
		const packages = await this.extensionManagement.search(query, { packageType: "localization", limit });
		const installed = new Set(this._installedPackages.map(packageValue => `${packageValue.id}\0${packageValue.version}`));
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

	async refresh(): Promise<void> {
		if (this.refreshPromise) return this.refreshPromise;
		let refresh!: Promise<void>;
		refresh = this.load().finally(() => {
			if (this.refreshPromise === refresh) this.refreshPromise = undefined;
		});
		this.refreshPromise = refresh;
		return refresh;
	}

	private async load(): Promise<void> {
		const installed = await this.extensionManagement.listInstalled();
		const installedPackages = installed
			.filter(packageValue => packageValue.state === "installed")
			.map(packageValue => ({
				id: packageValue.package.id,
				version: packageValue.package.version,
				displayName: packageValue.package.id,
				description: "",
				installed: true,
			}));
		const loaded = (await loadInstalledCatalogs(this.extensionManagement, installed))
			.filter(catalog => !this.builtinLocales.has(normalizeLocale(catalog.locale)));
		// Only publish installed languages once their next-startup resources are saved.
		for (const catalog of loaded) await this.store.write(catalog);
		for (const locale of this.extensionManagementLocales) this.catalogsByLocale.delete(locale);
		this.extensionManagementLocales.clear();
		for (const catalog of loaded) {
			const locale = normalizeLocale(catalog.locale);
			if (!locale || this.builtinLocales.has(locale)) continue;
			this.catalogsByLocale.set(locale, { ...catalog, locale });
			this.extensionManagementLocales.add(locale);
		}
		this._installedPackages = installedPackages;
		this._onDidChange.fire();
	}
}

async function loadInstalledCatalogs(
	extensionManagement: IExtensionManagementService,
	installed: readonly ExtensionsInstalledPackage[],
): Promise<readonly LanguagePackCatalog[]> {
	const catalogs: LanguagePackCatalog[] = [];
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
				if (catalog) catalogs.push(catalog);
			} finally {
				await extensionManagement.releaseCapability(acquired.lease.id).catch(() => undefined);
			}
		}
	}
	return catalogs;
}
