import type { MarketplaceAcquireCapabilityParams, MarketplaceAcquiredCapabilityDto, MarketplaceArtifactHandleDto, MarketplaceDownloadParams, MarketplaceGetParams, MarketplaceInstallParams, MarketplaceInstalledPackageDto, MarketplaceListInstalledResult, MarketplaceOpenResourceParams, MarketplacePackageDetailsDto, MarketplaceReleaseCapabilityParams, MarketplaceResourceContentDto, MarketplaceSearchParams, MarketplaceSearchResult, MarketplaceUninstallParams, MarketplaceUpdateParams } from "../../../../../crates/app-server-protocol/schema/typescript/index.js";

/** Transport API mirroring the generic App Server Marketplace contract. */
export interface IMarketplaceApi {
	search(params: MarketplaceSearchParams): Promise<MarketplaceSearchResult>;
	get(params: MarketplaceGetParams): Promise<MarketplacePackageDetailsDto>;
	download(params: MarketplaceDownloadParams): Promise<MarketplaceArtifactHandleDto>;
	install(params: MarketplaceInstallParams): Promise<MarketplaceInstalledPackageDto>;
	update(params: MarketplaceUpdateParams): Promise<MarketplaceInstalledPackageDto>;
	uninstall(params: MarketplaceUninstallParams): Promise<void>;
	listInstalled(): Promise<MarketplaceListInstalledResult>;
	editorExtensions(): Promise<import('../../../../../crates/app-server-protocol/schema/typescript/index.js').MarketplaceEditorExtensionsResult>;
	setEditorExtensionPolicy(params: import('../../../../../crates/app-server-protocol/schema/typescript/index.js').MarketplaceEditorExtensionPolicyParams): Promise<import('../../../../../crates/app-server-protocol/schema/typescript/index.js').MarketplaceEditorExtensionsResult>;
	acquireCapability(params: MarketplaceAcquireCapabilityParams): Promise<MarketplaceAcquiredCapabilityDto>;
	releaseCapability(params: MarketplaceReleaseCapabilityParams): Promise<void>;
	openResource(params: MarketplaceOpenResourceParams): Promise<MarketplaceResourceContentDto>;
}
