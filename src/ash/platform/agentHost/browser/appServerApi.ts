import type { IAppServerApi, IResourceApi, IServerEventApi } from "../common/appServerApi.js";
import { inertSubscription, type UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { AppServerProtocolClient } from "./appServerProtocolClient.js";
import { appServerRequest, voidResult } from "./appServerRequest.js";

export function createDisconnectedAppServerApi(unavailable: UnavailableOperation): IAppServerApi {
	return {
		getConnectionState: () => Promise.resolve("stopped"),
		getSlashCommands: () => unavailable("appServer.getSlashCommands"),
		onConnectionState: inertSubscription,
	};
}

export function createDisconnectedResourceApi(unavailable: UnavailableOperation): IResourceApi {
	return {
		metadata: () => unavailable("resource.metadata"),
		read: () => unavailable("resource.read"),
		release: () => unavailable("resource.release"),
	};
}

export function createDisconnectedServerEventApi(): IServerEventApi {
	return { subscribe: inertSubscription };
}

export function createAppServerAppServerApi(connection: AppServerProtocolClient): IAppServerApi {
	return {
		getConnectionState: () => Promise.resolve(connection.state),
		getSlashCommands: () => Promise.resolve(connection.slashCommands),
		onConnectionState: (listener) => connection.onStateChange(listener),
	};
}

export function createAppServerResourceApi(connection: AppServerProtocolClient): IResourceApi {
	return {
		metadata: (params) => appServerRequest(connection, "resource/metadata", params),
		read: (params) => appServerRequest(connection, "resource/read", params),
		release: (params) => voidResult(appServerRequest(connection, "resource/release", params)),
	};
}

export function createAppServerServerEventApi(connection: AppServerProtocolClient): IServerEventApi {
	return { subscribe: (listener) => connection.onNotification(listener) };
}
