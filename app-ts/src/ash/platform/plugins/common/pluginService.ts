import type { Event } from "../../../base/common/event.js";
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

export interface PluginPackageView {
	readonly id: string;
	readonly version: string;
	readonly digest: string;
	readonly enabled: boolean;
	readonly granted: boolean;
	readonly effective: boolean;
	readonly revoked: boolean;
}

export interface PluginCatalogView {
	readonly revision: number;
	readonly activationGeneration: number;
	readonly packages: readonly PluginPackageView[];
}

export interface IPluginService {
	readonly onDidChange: Event<number>;
	list(): Promise<PluginCatalogView>;
	enable(plugin: PluginPackageView, revision: number): Promise<void>;
	disable(plugin: PluginPackageView, revision: number): Promise<void>;
	grant(plugin: PluginPackageView, revision: number): Promise<void>;
	revokeGrant(plugin: PluginPackageView, revision: number): Promise<void>;
	uninstall(plugin: PluginPackageView, revision: number): Promise<void>;
}

export const IPluginService = createServiceIdentifier<IPluginService>("pluginService");
