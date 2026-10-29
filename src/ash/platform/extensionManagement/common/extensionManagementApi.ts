import type { ExtensionsAcquireCapabilityParams, ExtensionsAcquiredCapabilityDto, ExtensionsArtifactHandleDto, ExtensionsDownloadParams, ExtensionsGetParams, ExtensionsInstallParams, ExtensionsInstalledPackageDto, ExtensionsListInstalledResult, ExtensionsOpenResourceParams, ExtensionsPackageDetailsDto, ExtensionsReleaseCapabilityParams, ExtensionsResourceContentDto, ExtensionsSearchParams, ExtensionsSearchResult, ExtensionsUninstallParams, ExtensionsUpdateParams } from '../../../../../.build/protocol/typescript/index.js';

/** Transport API mirroring the generic App Server Extensions contract. */
export interface IExtensionManagementApi {
	recommendationEnvironment(): Promise<import('../../../../../.build/protocol/typescript/index.js').ExtensionsRecommendationEnvironmentResult>;
	searchPage(params: import('../../../../../.build/protocol/typescript/index.js').ExtensionsSearchPageParams): Promise<import('../../../../../.build/protocol/typescript/index.js').ExtensionsSearchPageResult>;
	builtInProviders(): Promise<import('../../../../../.build/protocol/typescript/index.js').ExtensionsBuiltInProvidersResult>;
	setBuiltInProviderEnablement(params: import('../../../../../.build/protocol/typescript/index.js').ExtensionsBuiltInProviderEnablementParams): Promise<import('../../../../../.build/protocol/typescript/index.js').ExtensionsBuiltInProvidersResult>;
	sources(): Promise<import('../../../../../.build/protocol/typescript/index.js').ExtensionsSourcesResult>;
	addSource(params: import('../../../../../.build/protocol/typescript/index.js').ExtensionsAddSourceParams): Promise<import('../../../../../.build/protocol/typescript/index.js').ExtensionsSourcesResult>;
	setSourceEnabled(params: import('../../../../../.build/protocol/typescript/index.js').ExtensionsSetSourceEnabledParams): Promise<import('../../../../../.build/protocol/typescript/index.js').ExtensionsSourcesResult>;
	search(params: ExtensionsSearchParams): Promise<ExtensionsSearchResult>;
	get(params: ExtensionsGetParams): Promise<ExtensionsPackageDetailsDto>;
	download(params: ExtensionsDownloadParams): Promise<ExtensionsArtifactHandleDto>;
	install(params: ExtensionsInstallParams): Promise<ExtensionsInstalledPackageDto>;
	update(params: ExtensionsUpdateParams): Promise<ExtensionsInstalledPackageDto>;
	uninstall(params: ExtensionsUninstallParams): Promise<void>;
	listInstalled(): Promise<ExtensionsListInstalledResult>;
	editorExtensions(): Promise<import('../../../../../.build/protocol/typescript/index.js').ExtensionsEditorExtensionsResult>;
	setEditorExtensionPolicy(params: import('../../../../../.build/protocol/typescript/index.js').ExtensionsEditorExtensionPolicyParams): Promise<import('../../../../../.build/protocol/typescript/index.js').ExtensionsEditorExtensionsResult>;
	acquireCapability(params: ExtensionsAcquireCapabilityParams): Promise<ExtensionsAcquiredCapabilityDto>;
	releaseCapability(params: ExtensionsReleaseCapabilityParams): Promise<void>;
	openResource(params: ExtensionsOpenResourceParams): Promise<ExtensionsResourceContentDto>;
}
