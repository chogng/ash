import type { Event } from "../../../base/common/event.js";
import type { IWorkspaceFolder } from '../../workspace/common/workspace.js';
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

export interface PluginPackageView {
	readonly id: string;
	readonly version: string;
	readonly digest: string;
	readonly displayName: string;
	readonly permissions: readonly PluginPermission[];
	readonly hasEditorExtensions: boolean;
	readonly enabled: boolean;
	readonly granted: boolean;
	readonly effective: boolean;
	readonly revoked: boolean;
}

export type PluginPermission =
	| { readonly type: 'directory'; readonly access: 'read' | 'write'; }
	| { readonly type: 'process'; readonly executable: string; }
	| { readonly type: 'network'; readonly hosts: readonly string[]; };

export interface PluginInstallation {
	readonly id: string;
	readonly version: string;
	readonly digest: string;
}

export interface PluginCatalogView {
	readonly revision: number;
	readonly activationGeneration: number;
	readonly packages: readonly PluginPackageView[];
}

export interface IPluginManagementService {
	readonly onDidChange: Event<number>;
	list(): Promise<PluginCatalogView>;
	/** Path is relative to the selected authorized directory; installation does not activate it. */
	installLocal(path: string, revision: number): Promise<PluginInstallation>;
	/** App-owned source materialization; the package authority still owns installation and grants. */
	installFromGit(
		folder: IWorkspaceFolder,
		url: string,
		reference: string | undefined,
		packagePath: string,
		signal: AbortSignal,
	): Promise<PluginInstallation>;
	enable(plugin: PluginPackageView, revision: number): Promise<void>;
	disable(plugin: PluginPackageView, revision: number): Promise<void>;
	grant(plugin: PluginPackageView, revision: number): Promise<void>;
	revokeGrant(plugin: PluginPackageView, revision: number): Promise<void>;
	uninstall(plugin: PluginPackageView, revision: number): Promise<void>;
}

export const IPluginManagementService = createServiceIdentifier<IPluginManagementService>("pluginManagementService");
