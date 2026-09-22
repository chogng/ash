import { Emitter } from "../../../base/common/event.js";
import { Disposable } from "../../../base/common/lifecycle.js";
import type { IMarketplaceService, MarketplaceInstalledPackage } from "../../marketplace/common/marketplaceService.js";
import { decodeBase64, normalizeLocale, parseLanguagePackCatalog } from "../common/languagePackCatalog.js";
import type { ILanguagePackService, LanguagePackCatalog, LanguagePackInfo, LanguagePackPackage } from "../common/languagePacksService.js";

/** Browser client adapter that projects Marketplace localization capabilities. */
export class MarketplaceLanguagePackService extends Disposable implements ILanguagePackService {
	private readonly _onDidChange = this._register(new Emitter<void>());
	private readonly builtinLocales: ReadonlySet<string>;
	private readonly catalogsByLocale = new Map<string, LanguagePackCatalog>();
	private marketplaceLocales = new Set<string>();
	private _installedPackages: readonly LanguagePackPackage[] = [];
	private refreshPromise: Promise<void> | undefined;

	readonly onDidChange = this._onDidChange.event;
	readonly whenReady: Promise<void>;

	constructor(
		private readonly marketplace: IMarketplaceService,
		builtinCatalogs: readonly LanguagePackCatalog[],
	) {
		super();
		this.builtinLocales = new Set(builtinCatalogs.map(catalog => normalizeLocale(catalog.locale)));
		for (const catalog of builtinCatalogs) {
			const locale = normalizeLocale(catalog.locale);
			if (locale) this.catalogsByLocale.set(locale, { ...catalog, locale });
		}
		this.whenReady = this.refresh().catch(() => undefined);
		this._register(marketplace.onDidChangeInstalled(() => {
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
			source: this.builtinLocales.has(catalog.locale) ? "builtin" as const : "marketplace" as const,
		})).sort((left, right) => left.locale.localeCompare(right.locale));
	}

	get installedPackages(): readonly LanguagePackPackage[] {
		return this._installedPackages;
	}

	async search(query: string, limit?: number): Promise<readonly LanguagePackPackage[]> {
		const packages = await this.marketplace.search(query, { packageType: "localization", limit });
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
		await this.marketplace.install(packageId, version);
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
		const installed = await this.marketplace.listInstalled();
		const installedPackages = installed
			.filter(packageValue => packageValue.state === "installed")
			.map(packageValue => ({
				id: packageValue.package.id,
				version: packageValue.package.version,
				displayName: packageValue.package.id,
				description: "",
				installed: true,
			}));
		const loaded = await loadInstalledCatalogs(this.marketplace, installed);
		for (const locale of this.marketplaceLocales) this.catalogsByLocale.delete(locale);
		this.marketplaceLocales.clear();
		for (const catalog of loaded) {
			const locale = normalizeLocale(catalog.locale);
			if (!locale || this.builtinLocales.has(locale)) continue;
			this.catalogsByLocale.set(locale, { ...catalog, locale });
			this.marketplaceLocales.add(locale);
		}
		this._installedPackages = installedPackages;
		this._onDidChange.fire();
	}
}

async function loadInstalledCatalogs(
	marketplace: IMarketplaceService,
	installed: readonly MarketplaceInstalledPackage[],
): Promise<readonly LanguagePackCatalog[]> {
	const catalogs: LanguagePackCatalog[] = [];
	for (const packageValue of installed) {
		if (packageValue.state !== "installed") continue;
		for (const capability of packageValue.capabilities) {
			if (capability.kind !== "localization") continue;
			let acquired: Awaited<ReturnType<IMarketplaceService["acquireCapability"]>>;
			try {
				acquired = await marketplace.acquireCapability(capability.reference.id);
			} catch {
				continue;
			}
			try {
				if (acquired.spec.kind !== "localization") continue;
				const content = await marketplace.openResource(acquired.lease.id, acquired.spec.catalog.id);
				let parsed: unknown;
				try {
					parsed = JSON.parse(decodeBase64(content.dataBase64));
				} catch {
					continue;
				}
				const catalog = parseLanguagePackCatalog(parsed);
				if (catalog) catalogs.push(catalog);
			} finally {
				await marketplace.releaseCapability(acquired.lease.id).catch(() => undefined);
			}
		}
	}
	return catalogs;
}
