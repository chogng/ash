import type { Event } from "../../../base/common/event.js";
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

export type MarketplaceCapabilityKind = "skill" | "mcp" | "connector" | "theme" | "language" | "localization" | "executable" | "asset";

export interface MarketplaceSearchOptions {
	readonly packageType?: string;
	readonly limit?: number;
	readonly capabilityKind?: MarketplaceCapabilityKind;
	readonly languageId?: string;
}

export interface MarketplaceOpenOptions extends Pick<MarketplaceSearchOptions, "capabilityKind" | "languageId"> {
	readonly mode?: "browse" | "installed";
	readonly query?: string;
}

export const OPEN_MARKETPLACE_COMMAND_ID = "ash.marketplace.open";
export const OPEN_PLUGINS_COMMAND_ID = "ash.plugins.open";

export interface MarketplacePackageRef {
	readonly id: string;
	readonly version: string;
	readonly digest: string;
}

export interface MarketplacePackageSummary {
	readonly id: string;
	readonly version: string;
	readonly packageType: string;
	readonly displayName: string;
	readonly description: string;
}

export interface MarketplaceCapabilityDescriptor {
	readonly reference: { readonly id: string };
	readonly kind: MarketplaceCapabilityKind;
	readonly id: string;
	readonly contractVersion: string;
	readonly permissions: readonly string[];
	readonly authenticationProvider: string | null;
}

export interface MarketplaceAvailableCapability {
	readonly kind: MarketplaceCapabilityKind;
	readonly id: string;
	readonly contractVersion: string;
	readonly permissions: readonly string[];
	readonly authenticationProvider: string | null;
}

export interface MarketplacePackageDetails {
	readonly package: MarketplacePackageRef;
	readonly packageType: string;
	readonly displayName: string;
	readonly description: string;
	readonly license: string;
	readonly source: "official" | "thirdParty";
	readonly upstream: {
		readonly registry: "officialMcp";
		readonly name: string;
		readonly version: string;
		readonly recordUrl: string;
		readonly repositoryUrl: string | null;
	} | null;
	readonly capabilities: readonly MarketplaceAvailableCapability[];
}

export interface MarketplaceInstalledPackage {
	readonly installationId: string;
	readonly package: MarketplacePackageRef;
	readonly state: "installed" | "pendingRemoval";
	readonly capabilities: readonly MarketplaceCapabilityDescriptor[];
}

export interface MarketplaceBrowsePackage {
	readonly summary: MarketplacePackageSummary;
	readonly details: MarketplacePackageDetails | undefined;
}

/** Renderer-ready catalog projection retained by the Workbench Marketplace service. */
export interface MarketplaceBrowseSnapshot {
	readonly query: string;
	readonly options: MarketplaceSearchOptions;
	readonly packages: readonly MarketplaceBrowsePackage[];
	readonly installed: readonly MarketplaceInstalledPackage[];
}

export type MarketplaceActivationSpec =
	| { readonly kind: "skill"; readonly contractVersion: string; readonly resource: { readonly id: string } }
	| { readonly kind: "mcp"; readonly contractVersion: string; readonly transport: { readonly type: "stdio"; readonly executable: { readonly id: string }; readonly args: readonly string[] } | { readonly type: "streamableHttp"; readonly url: string }; readonly networkHosts: readonly string[] }
	| { readonly kind: "connector"; readonly contractVersion: string; readonly authenticationProvider: string | null; readonly mcp: { readonly id: string } | null }
	| { readonly kind: "theme"; readonly contractVersion: string; readonly manifest: { readonly id: string } }
	| { readonly kind: "language"; readonly contractVersion: string; readonly manifest: { readonly id: string } }
	| { readonly kind: "localization"; readonly contractVersion: string; readonly catalog: { readonly id: string } }
	| { readonly kind: "executable"; readonly contractVersion: string; readonly runtime: "direct" | "node"; readonly entrypoint: { readonly id: string } };

export interface MarketplaceAcquiredCapability {
	readonly lease: { readonly id: string; readonly capability: { readonly id: string }; readonly installationId: string };
	readonly spec: MarketplaceActivationSpec;
}

/** Frontend Marketplace business capability, independent of distribution and package internals. */
export interface IMarketplaceService {
	readonly onDidChangeInstalled: Event<void>;
	cachedBrowse(query: string, options?: MarketplaceSearchOptions): MarketplaceBrowseSnapshot | undefined;
	browse(query: string, options?: MarketplaceSearchOptions): Promise<MarketplaceBrowseSnapshot>;
	refreshBrowse(query: string, options?: MarketplaceSearchOptions): Promise<MarketplaceBrowseSnapshot>;
	search(query: string, options?: MarketplaceSearchOptions): Promise<readonly MarketplacePackageSummary[]>;
	get(packageId: string, version?: string): Promise<MarketplacePackageDetails>;
	download(packageId: string, version?: string): Promise<{ readonly id: string; readonly package: MarketplacePackageRef }>;
	install(packageId: string, version?: string): Promise<MarketplaceInstalledPackage>;
	update(installationId: string, version?: string): Promise<MarketplaceInstalledPackage>;
	uninstall(installationId: string, mode?: "ifUnused" | "whenUnused"): Promise<void>;
	listInstalled(): Promise<readonly MarketplaceInstalledPackage[]>;
	acquireCapability(capabilityId: string): Promise<MarketplaceAcquiredCapability>;
	releaseCapability(leaseId: string): Promise<void>;
	openResource(leaseId: string, resourceId: string): Promise<{ readonly mediaType: string; readonly dataBase64: string }>;
}

export const IMarketplaceService = createServiceIdentifier<IMarketplaceService>("marketplaceService");
