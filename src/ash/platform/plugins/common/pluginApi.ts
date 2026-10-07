import type { PluginCommandResultDto, PluginInstallLocalParams, PluginInstallLocalResult, PluginListResult, PluginPackageCommandParams } from "../../../../../.build/protocol/typescript/index.js";

export interface IPluginApi {
	list(): Promise<PluginListResult>;
	installLocal(params: PluginInstallLocalParams): Promise<PluginInstallLocalResult>;
	enable(params: PluginPackageCommandParams): Promise<PluginCommandResultDto>;
	disable(params: PluginPackageCommandParams): Promise<PluginCommandResultDto>;
	grant(params: PluginPackageCommandParams): Promise<PluginCommandResultDto>;
	revokeGrant(params: PluginPackageCommandParams): Promise<PluginCommandResultDto>;
	uninstall(params: PluginPackageCommandParams): Promise<PluginCommandResultDto>;
}
