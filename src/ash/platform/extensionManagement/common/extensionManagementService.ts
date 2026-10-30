import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export type ExtensionsCapabilityKind = 'skill' | 'mcp' | 'connector' | 'theme' | 'language' | 'localization' | 'executable' | 'editorExtension' | 'asset';

/** Product windows declared by a package manifest, separate from execution platforms. */
export enum ExtensionUiTarget { IDE = 'ide', Agents = 'agents' }

export interface ExtensionsRecommendationEnvironment {
	readonly platform: 'macos' | 'linux' | 'windows' | 'other';
	readonly executables: readonly string[];
}

export interface ExtensionsSearchOptions {
	readonly packageType?: string;
	readonly limit?: number;
	readonly capabilityKind?: ExtensionsCapabilityKind;
	readonly languageId?: string;
}

export interface ExtensionsSearchPage {
	readonly packages: readonly ExtensionsPackageSummary[];
	readonly total: number;
	readonly nextCursor?: string;
}

export interface ExtensionsOpenOptions extends Pick<ExtensionsSearchOptions, 'capabilityKind' | 'languageId'> {
	readonly mode?: 'browse' | 'installed' | 'builtIn';
	readonly view?: 'extensions' | 'plugins' | 'skills' | 'mcp' | 'recommended';
	readonly query?: string;
}

export const OPEN_EXTENSIONS_COMMAND_ID = 'ash.extensions.open';
export const OPEN_INSTALLED_EXTENSIONS_COMMAND_ID = 'ash.extensions.installed';

export interface ExtensionsPackageRef {
	readonly id: string;
	readonly version: string;
	readonly digest: string;
}

export interface ExtensionsPackageSummary {
	readonly id: string;
	readonly version: string;
	readonly packageType: string;
	readonly displayName: string;
	readonly description: string;
	readonly uiTargets?: readonly ExtensionUiTarget[];
}

export interface ExtensionsCapabilityDescriptor {
	readonly reference: { readonly id: string; };
	readonly kind: ExtensionsCapabilityKind;
	readonly id: string;
	readonly contractVersion: string;
	readonly permissions: readonly string[];
	readonly authenticationProvider: string | null;
}

export interface ExtensionsAvailableCapability {
	readonly kind: ExtensionsCapabilityKind;
	readonly id: string;
	readonly contractVersion: string;
	readonly permissions: readonly string[];
	readonly authenticationProvider: string | null;
}

export interface ExtensionsPackageDetails {
	readonly package: ExtensionsPackageRef;
	readonly packageType: string;
	readonly displayName: string;
	readonly description: string;
	readonly license: string;
	readonly source: 'official' | 'thirdParty';
	readonly upstream: {
		readonly registry: 'officialMcp';
		readonly name: string;
		readonly version: string;
		readonly recordUrl: string;
		readonly repositoryUrl: string | null;
	} | null;
	readonly capabilities: readonly ExtensionsAvailableCapability[];
	readonly uiTargets?: readonly ExtensionUiTarget[];
}

export interface ExtensionsInstalledPackage {
	readonly installationId: string;
	readonly package: ExtensionsPackageRef;
	readonly state: 'installed' | 'pendingRemoval';
	readonly capabilities: readonly ExtensionsCapabilityDescriptor[];
}

export type ExtensionsEditorExtensionPolicyAction = 'enable' | 'disable' | 'grant' | 'revoke';
export interface ExtensionsEditorExtensionPolicy {
	readonly installationId: string;
	readonly package: ExtensionsPackageRef;
	readonly entrypoint: string | null;
	readonly executionKind?: 'node' | 'native';
	readonly enabled: boolean;
	readonly granted: boolean;
}
export interface ExtensionsEditorExtensions {
	readonly revision: number;
	readonly extensions: readonly ExtensionsEditorExtensionPolicy[];
}

export interface ExtensionsBuiltInProvider {
	readonly id: string;
	readonly enabled: boolean;
	readonly running: boolean;
}

export interface ExtensionsBuiltInProviders {
	readonly revision: number;
	/** The connected backend decides whether this connection may change provider enablement. */
	readonly canChangeEnablement: boolean;
	readonly providers: readonly ExtensionsBuiltInProvider[];
}

export interface ExtensionsBrowsePackage {
	readonly summary: ExtensionsPackageSummary;
	readonly details: ExtensionsPackageDetails | undefined;
}

/** Renderer-ready catalog projection retained by the Workbench Extensions service. */
export interface ExtensionsBrowseSnapshot {
	readonly query: string;
	readonly options: ExtensionsSearchOptions;
	readonly packages: readonly ExtensionsBrowsePackage[];
	readonly installed: readonly ExtensionsInstalledPackage[];
	readonly unavailableSources: readonly string[];
}

export type ExtensionsActivationSpec =
	| { readonly kind: 'skill'; readonly contractVersion: string; readonly resource: { readonly id: string; }; }
	| { readonly kind: 'mcp'; readonly contractVersion: string; readonly transport: { readonly type: 'stdio'; readonly executable: { readonly id: string; }; readonly args: readonly string[]; } | { readonly type: 'streamableHttp'; readonly url: string; }; readonly networkHosts: readonly string[]; }
	| { readonly kind: 'connector'; readonly contractVersion: string; readonly authenticationProvider: string | null; readonly mcp: { readonly id: string; } | null; }
	| { readonly kind: 'theme'; readonly contractVersion: string; readonly manifest: { readonly id: string; }; }
	| { readonly kind: 'language'; readonly contractVersion: string; readonly manifest: { readonly id: string; }; }
	| { readonly kind: 'localization'; readonly contractVersion: string; readonly catalog: { readonly id: string; }; }
	| { readonly kind: 'executable'; readonly contractVersion: string; readonly runtime: 'direct' | 'node'; readonly entrypoint: { readonly id: string; }; };

export interface ExtensionsAcquiredCapability {
	readonly lease: { readonly id: string; readonly capability: { readonly id: string; }; readonly installationId: string; };
	readonly spec: ExtensionsActivationSpec;
}

export interface ExtensionRegistrySource {
	readonly id: string;
	readonly kind: 'ash';
	readonly enabled: boolean;
	readonly productOwned: boolean;
}

export interface ExtensionRegistrySources {
	readonly revision: number;
	readonly sources: readonly ExtensionRegistrySource[];
}

export interface AshExtensionSource {
	readonly sourceId: string;
	readonly metadataBaseUrl: string;
	readonly targetsBaseUrl: string;
	readonly trustedRootJson: string;
}

/** Frontend Extensions business capability, independent of distribution and package internals. */
export interface IExtensionManagementService {
	recommendationEnvironment(): Promise<ExtensionsRecommendationEnvironment>;
	searchPage(query: string, options: ExtensionsSearchOptions & { readonly sourceId: string; readonly pageSize: number; readonly cursor?: string; }): Promise<ExtensionsSearchPage>;
	readonly onDidChangeInstalled: Event<void>;
	sources(): Promise<ExtensionRegistrySources>;
	addSource(source: AshExtensionSource, expectedRevision: number): Promise<ExtensionRegistrySources>;
	setSourceEnabled(sourceId: string, enabled: boolean, expectedRevision: number): Promise<ExtensionRegistrySources>;
	cachedBrowse(query: string, options?: ExtensionsSearchOptions): ExtensionsBrowseSnapshot | undefined;
	browse(query: string, options?: ExtensionsSearchOptions): Promise<ExtensionsBrowseSnapshot>;
	refreshBrowse(query: string, options?: ExtensionsSearchOptions): Promise<ExtensionsBrowseSnapshot>;
	search(query: string, options?: ExtensionsSearchOptions): Promise<readonly ExtensionsPackageSummary[]>;
	get(packageId: string, version?: string): Promise<ExtensionsPackageDetails>;
	download(packageId: string, version?: string): Promise<{ readonly id: string; readonly package: ExtensionsPackageRef; }>;
	install(packageId: string, version?: string): Promise<ExtensionsInstalledPackage>;
	update(installationId: string, version?: string): Promise<ExtensionsInstalledPackage>;
	uninstall(installationId: string, mode?: 'ifUnused' | 'whenUnused'): Promise<void>;
	listInstalled(): Promise<readonly ExtensionsInstalledPackage[]>;
	listEditorExtensions(): Promise<ExtensionsEditorExtensions>;
	listBuiltInProviders(): Promise<ExtensionsBuiltInProviders>;
	setBuiltInProviderEnabled(id: string, enabled: boolean, expectedRevision: number): Promise<ExtensionsBuiltInProviders>;
	setEditorExtensionPolicy(extension: ExtensionsEditorExtensionPolicy, action: ExtensionsEditorExtensionPolicyAction, expectedRevision: number): Promise<ExtensionsEditorExtensions>;
	acquireCapability(capabilityId: string): Promise<ExtensionsAcquiredCapability>;
	releaseCapability(leaseId: string): Promise<void>;
	openResource(leaseId: string, resourceId: string): Promise<{ readonly mediaType: string; readonly dataBase64: string; }>;
}

export const IExtensionManagementService = createServiceIdentifier<IExtensionManagementService>('extensionManagementService');
