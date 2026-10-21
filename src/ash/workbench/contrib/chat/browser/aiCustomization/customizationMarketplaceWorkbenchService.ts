import { raceCancellationError } from '../../../../../base/common/async.js';
import { CancellationTokenSource, type CancellationToken } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import {
	CustomizationMarketplaceMediaType, CustomizationMarketplaceService,
	type ICustomizationMarketplacePage, type ICustomizationMarketplaceQuery,
	type ICustomizationMarketplaceResource, type ICustomizationMarketplaceService,
	type ICustomizationMarketplaceSourceInfo, type ICustomizationMarketplaceProvider,
} from '../../../../../platform/customizationMarketplace/common/customizationMarketplaceService.js';
import { CustomizationMarketplaceConfiguration, getEnabledCustomizationMarketplaceSources } from '../../../../../platform/customizationMarketplace/common/customizationMarketplaceSources.js';
import { IExtensionManagementService } from '../../../../../platform/extensionManagement/common/extensionManagementService.js';

/** Backend registries own catalogs and trust; this renderer retains source metadata and disposable page continuations. */
export class CustomizationMarketplaceWorkbenchService extends Disposable implements ICustomizationMarketplaceService {
	private metadata: readonly ICustomizationMarketplaceSourceInfo[] = [];
	private readonly catalog = this._register(new MutableDisposable<CustomizationMarketplaceService>());
	private readonly shutdown = new CancellationTokenSource();
	private readonly changedSources = this._register(new Emitter<void>());
	readonly onDidChangeSources = this.changedSources.event;

	constructor(
		@IExtensionManagementService private readonly extensions: IExtensionManagementService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		this._register(toDisposable(() => this.shutdown.dispose(true)));
		const invalidate = () => {
			this.catalog.clear();
			this.changedSources.fire();
		};
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CustomizationMarketplaceConfiguration.MarketplaceEnabled)) { invalidate(); }
		}));
		this._register(extensions.onDidChangeInstalled(invalidate));
	}

	get allSources(): readonly ICustomizationMarketplaceSourceInfo[] { return this.metadata; }
	get sources(): readonly ICustomizationMarketplaceSourceInfo[] {
		return getEnabledCustomizationMarketplaceSources(this.configuration, this.metadata);
	}

	async query(options: ICustomizationMarketplaceQuery, token: CancellationToken): Promise<ICustomizationMarketplacePage> {
		if (token.isCancellationRequested || this.isDisposed) { throw new CancellationError(); }
		if (!this.configuration.getValue<boolean>(CustomizationMarketplaceConfiguration.MarketplaceEnabled)) { return { items: [] }; }
		using lifetime = new DisposableStore();
		const cancellation = new CancellationTokenSource(token);
		lifetime.add(toDisposable(() => cancellation.dispose(true)));
		lifetime.add(this.shutdown.token.onCancellationRequested(() => cancellation.cancel()));
		lifetime.add(this.onDidChangeSources(() => cancellation.cancel()));
		const snapshot = await raceCancellationError(this.extensions.sources(), cancellation.token);
		if (this.isDisposed) { throw new CancellationError(); }
		const metadata = snapshot.sources.map(source => ({
			id: source.id, displayName: source.id, enabled: source.enabled,
			enablementSetting: CustomizationMarketplaceConfiguration.MarketplaceEnabled,
		}));
		if (JSON.stringify(metadata) !== JSON.stringify(this.metadata)) {
			this.metadata = metadata;
			this.catalog.clear();
		}
		if (!this.catalog.value) {
			this.catalog.value = new CustomizationMarketplaceService(this.sources.map(source => this.provider(source.id)));
		}
		return await this.catalog.value.query({ ...options, sourceIds: options.sourceIds ?? this.sources.map(source => source.id) }, cancellation.token);
	}

	private provider(sourceId: string): ICustomizationMarketplaceProvider {
		return {
			id: sourceId, sourceId,
			query: async (options, token) => {
				const kind = options.mediaType === CustomizationMarketplaceMediaType.Skill ? 'skill'
					: options.mediaType === CustomizationMarketplaceMediaType.McpServer ? 'mcp' : undefined;
				const page = await raceCancellationError(this.extensions.searchPage(options.query ?? '', {
					sourceId, capabilityKind: kind, pageSize: options.pageSize ?? 30, cursor: options.cursor,
				}), token);
				const items = await raceCancellationError(Promise.all(page.packages.map(async summary => {
					const capabilities = (await this.extensions.get(summary.id, summary.version)).capabilities.map(capability => capability.kind);
					const resourceKind = kind ?? (capabilities.includes('skill') ? 'skill' : capabilities.includes('mcp') ? 'mcp' : undefined);
					if (!resourceKind) { return undefined; }
					const resource: ICustomizationMarketplaceResource = {
						sourceId, identifier: summary.id, version: summary.version,
						displayName: summary.displayName, description: summary.description,
						mediaType: resourceKind === 'skill' ? CustomizationMarketplaceMediaType.Skill : CustomizationMarketplaceMediaType.McpServer,
						capabilities, installation: { kind: 'providerCatalog', resourceKind, selectionId: summary.id },
					};
					return resource;
				})), token);
				return { items: items.filter((item): item is ICustomizationMarketplaceResource => item !== undefined), total: kind ? page.total : undefined, nextCursor: page.nextCursor };
			},
		};
	}
}
