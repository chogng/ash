import type { AppServerProtocolClient } from "../../app-server/browser/appServerProtocolClient.js";
import { appServerRequest } from "../../app-server/browser/appServerRequest.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { IDirPermissionsApi } from "../common/dirPermissionsApi.js";

export function createDisconnectedDirPermissionsApi(unavailable: UnavailableOperation): IDirPermissionsApi {
	return {
		list: () => unavailable("dirPermissions.list"),
		read: () => unavailable("dirPermissions.read"),
		set: () => unavailable("dirPermissions.set"),
		forget: () => unavailable("dirPermissions.forget"),
	};
}
export function createAppServerDirPermissionsApi(connection: AppServerProtocolClient): IDirPermissionsApi {
	return {
		list: () => appServerRequest(connection, "config/dirPermissions/list", {}),
		read: params => appServerRequest(connection, "config/dirPermissions/read", params),
		set: params => appServerRequest(connection, "config/dirPermissions/set", params),
		forget: params => appServerRequest(connection, "config/dirPermissions/forget", params),
	};
}
