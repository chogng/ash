import { Emitter } from "../../../../base/common/event.js";
import { localize } from '../../../../nls.js';
import type { ExtensionsBuiltInProviders, ExtensionsEditorExtensionPolicy, ExtensionsEditorExtensionPolicyAction, ExtensionsEditorExtensions } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import type { IServerEventApi } from "../../../../platform/agentHost/common/appServerApi.js";
import type { IExtensionManagementApi } from "../../../../platform/extensionManagement/common/extensionManagementApi.js";
import type { IExtensionManagementService, ExtensionsAcquiredCapability, ExtensionsBrowseSnapshot, ExtensionsInstalledPackage, ExtensionsPackageDetails, ExtensionsPackageSummary, ExtensionsSearchOptions, ExtensionsSearchPage, ExtensionRegistrySources, AshExtensionSource } from "../../../../platform/extensionManagement/common/extensionManagementService.js";

/** App Server adapter and owner of path-free Renderer browse snapshots. */
export class AppServerExtensionManagementService extends Disposable implements IExtensionManagementService {
	private readonly browseSnapshots = new Map<string, ExtensionsBrowseSnapshot>();
	private readonly browseRequests = new Map<string, Promise<ExtensionsBrowseSnapshot>>();
	private readonly details = new Map<string, Promise<ExtensionsPackageDetails>>();
	private browseGeneration = 0;
	private installedInstanceId: string | undefined;
	private installedGeneration = 0;
	private readonly _onDidChangeInstalled = this._register(new Emitter<void>());

	readonly onDidChangeInstalled = this._onDidChangeInstalled.event;

	sources(): Promise<ExtensionRegistrySources> { return this.api.sources(); }

	async searchPage(query: string, options: ExtensionsSearchOptions & { readonly sourceId: string; readonly pageSize: number; readonly cursor?: string; }): Promise<ExtensionsSearchPage> {
		const page = await this.api.searchPage({ query, sourceId: options.sourceId, pageSize: options.pageSize, cursor: options.cursor ?? null, packageType: options.packageType ?? null, capabilityKind: options.capabilityKind ?? null, languageId: options.languageId ?? null });
		const total = Number(page.total);
		if (!Number.isSafeInteger(total) || total < 0) {
			throw new TypeError(localize({ bundle: 'ash.extensions', key: 'marketplaceInvalidCount' }, 'The registry returned an invalid result count.'));
		}
		return { packages: page.packages, total, nextCursor: page.nextCursor ?? undefined };
	}

	async addSource(source: AshExtensionSource, expectedRevision: number): Promise<ExtensionRegistrySources> {
		const result = await this.api.addSource({ ...source, expectedRevision });
		this.invalidateBrowse();
		return result;
	}

	async setSourceEnabled(sourceId: string, enabled: boolean, expectedRevision: number): Promise<ExtensionRegistrySources> {
		const result = await this.api.setSourceEnabled({ sourceId, enabled, expectedRevision });
		this.invalidateBrowse();
		return result;
	}

	public listBuiltInProviders(): Promise<ExtensionsBuiltInProviders> { return this.api.builtInProviders(); }
	public setBuiltInProviderEnabled(id: string, enabled: boolean, expectedRevision: number): Promise<ExtensionsBuiltInProviders> { return this.api.setBuiltInProviderEnablement({ id, enabled, expectedRevision }); }

	listEditorExtensions(): Promise<ExtensionsEditorExtensions> {
		return this.api.editorExtensions();
	}

	setEditorExtensionPolicy(extension: ExtensionsEditorExtensionPolicy, action: ExtensionsEditorExtensionPolicyAction, expectedRevision: number): Promise<ExtensionsEditorExtensions> {
		return this.api.setEditorExtensionPolicy({ installationId: extension.installationId, packageDigest: extension.package.digest, expectedRevision, action });
	}

	constructor(private readonly api: IExtensionManagementApi, events: IServerEventApi) {
		super();
		const subscription = events.subscribe(event => {
			if (event.method !== "extensions/changed") return;
			if (event.params.instanceId === this.installedInstanceId && event.params.generation <= this.installedGeneration) return;
			this.installedInstanceId = event.params.instanceId;
			this.installedGeneration = event.params.generation;
			this.invalidateBrowse();
			this._onDidChangeInstalled.fire();
		});
		this._register(toDisposable(() => subscription.dispose()));
	}

	cachedBrowse(query: string, options: ExtensionsSearchOptions = {}): ExtensionsBrowseSnapshot | undefined {
		return this.browseSnapshots.get(browseKey(query, options));
	}

	browse(query: string, options: ExtensionsSearchOptions = {}): Promise<ExtensionsBrowseSnapshot> {
		return Promise.resolve(this.cachedBrowse(query, options) ?? this.loadBrowse(query, options));
	}

	refreshBrowse(query: string, options: ExtensionsSearchOptions = {}): Promise<ExtensionsBrowseSnapshot> {
		const key = browseKey(query, options);
		this.browseSnapshots.delete(key);
		return this.loadBrowse(query, options);
	}

	async search(query: string, options: ExtensionsSearchOptions = {}): Promise<readonly ExtensionsPackageSummary[]> {
		return (await this.api.search({ query, packageType: options.packageType ?? null, limit: options.limit ?? null, capabilityKind: options.capabilityKind ?? null, languageId: options.languageId ?? null })).packages;
	}

	get(packageId: string, version?: string): Promise<ExtensionsPackageDetails> {
		return this.api.get({ packageId, version: version ?? null });
	}

	download(packageId: string, version?: string) {
		return this.api.download({ packageId, version: version ?? null });
	}

	async install(packageId: string, version?: string): Promise<ExtensionsInstalledPackage> {
		return this.api.install({ packageId, version: version ?? null });
	}

	async update(installationId: string, version?: string): Promise<ExtensionsInstalledPackage> {
		return this.api.update({ installationId, version: version ?? null });
	}

	async uninstall(installationId: string, mode: "ifUnused" | "whenUnused" = "whenUnused"): Promise<void> {
		await this.api.uninstall({ installationId, mode });
	}

	async listInstalled(): Promise<readonly ExtensionsInstalledPackage[]> {
		const result = await this.api.listInstalled();
		if (result.instanceId !== this.installedInstanceId) {
			this.installedInstanceId = result.instanceId;
			this.installedGeneration = result.generation;
		} else {
			this.installedGeneration = Math.max(this.installedGeneration, result.generation);
		}
		return result.packages;
	}

	acquireCapability(capabilityId: string): Promise<ExtensionsAcquiredCapability> {
		return this.api.acquireCapability({ capability: { id: capabilityId } });
	}

	releaseCapability(leaseId: string): Promise<void> {
		return this.api.releaseCapability({ leaseId });
	}

	openResource(leaseId: string, resourceId: string) {
		return this.api.openResource({ leaseId, resource: { id: resourceId } });
	}

	private loadBrowse(query: string, options: ExtensionsSearchOptions = {}): Promise<ExtensionsBrowseSnapshot> {
		const key = browseKey(query, options);
		const existing = this.browseRequests.get(key);
		if (existing) return existing;
		const generation = this.browseGeneration;
		let request!: Promise<ExtensionsBrowseSnapshot>;
		request = Promise.all([
			this.api.search({ query, packageType: options.packageType ?? null, limit: options.limit ?? null, capabilityKind: options.capabilityKind ?? null, languageId: options.languageId ?? null }),
			this.listInstalled(),
		]).then(async ([searchResult, installed]) => {
			const packages = searchResult.packages;
			const browsePackages = await Promise.all(packages.map(async summary => ({
				summary,
				details: await this.packageDetails(summary.id, summary.version).catch(() => undefined),
			})));
			const snapshot = Object.freeze({ query, options, unavailableSources: Object.freeze(searchResult.unavailableSources ?? []), packages: Object.freeze(browsePackages), installed: Object.freeze([...installed]) });
			if (generation === this.browseGeneration) this.browseSnapshots.set(key, snapshot);
			return snapshot;
		}).finally(() => {
			if (this.browseRequests.get(key) === request) this.browseRequests.delete(key);
		});
		this.browseRequests.set(key, request);
		return request;
	}

	private packageDetails(packageId: string, version: string): Promise<ExtensionsPackageDetails> {
		const key = `${packageId}\0${version}`;
		const existing = this.details.get(key);
		if (existing) return existing;
		const request = this.get(packageId, version).catch((error: unknown) => {
			this.details.delete(key);
			throw error;
		});
		this.details.set(key, request);
		return request;
	}

	private invalidateBrowse(): void {
		this.browseGeneration += 1;
		this.browseSnapshots.clear();
		this.browseRequests.clear();
	}
}

function browseKey(query: string, options: ExtensionsSearchOptions = {}): string {
	return JSON.stringify([query, options.packageType ?? null, options.limit ?? null, options.capabilityKind ?? null, options.languageId ?? null]);
}
