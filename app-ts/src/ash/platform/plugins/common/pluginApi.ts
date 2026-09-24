import type { PluginCommandResultDto, PluginListResult, PluginPackageCommandParams } from "../../app-server/common/generated/index.js";

export interface IPluginApi {
	list(): Promise<PluginListResult>;
	enable(params: PluginPackageCommandParams): Promise<PluginCommandResultDto>;
	disable(params: PluginPackageCommandParams): Promise<PluginCommandResultDto>;
	grant(params: PluginPackageCommandParams): Promise<PluginCommandResultDto>;
	revokeGrant(params: PluginPackageCommandParams): Promise<PluginCommandResultDto>;
	uninstall(params: PluginPackageCommandParams): Promise<PluginCommandResultDto>;
}
