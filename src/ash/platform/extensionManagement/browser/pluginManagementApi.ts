import type { AppServerProtocolClient } from "../../agentHost/browser/appServerProtocolClient.js";
import { appServerRequest } from "../../agentHost/browser/appServerRequest.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { IPluginManagementApi } from "../common/pluginManagementApi.js";

export function createDisconnectedPluginManagementApi(unavailable: UnavailableOperation): IPluginManagementApi {
	return {
		list: () => unavailable("plugins.list"),
		installLocal: () => unavailable("plugins.installLocal"),
		enable: () => unavailable("plugins.enable"),
		disable: () => unavailable("plugins.disable"),
		grant: () => unavailable("plugins.grant"),
		revokeGrant: () => unavailable("plugins.revokeGrant"),
		uninstall: () => unavailable("plugins.uninstall"),
	};
}

export function createAppServerPluginManagementApi(connection: AppServerProtocolClient): IPluginManagementApi {
	return {
		list: () => appServerRequest(connection, "plugin/list", {}),
		installLocal: params => appServerRequest(connection, "plugin/installLocal", params),
		enable: params => appServerRequest(connection, "plugin/enable", params),
		disable: params => appServerRequest(connection, "plugin/disable", params),
		grant: params => appServerRequest(connection, "plugin/grant", params),
		revokeGrant: params => appServerRequest(connection, "plugin/revokeGrant", params),
		uninstall: params => appServerRequest(connection, "plugin/uninstall", params),
	};
}
