import type { IExtensionHostApi } from "../common/extensionHostApi.js";
import { invokeExtensionHost, normalizeExtensionHostChanged, normalizeExtensionHostSnapshot } from "../common/extensionHostApi.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { AppServerProtocolClient } from "../../app-server/browser/appServerProtocolClient.js";
import { appServerRequest } from "../../app-server/browser/appServerRequest.js";
import { inertSubscription } from "../../renderer/browser/disconnectedHost.js";

export function createDisconnectedExtensionHostApi(unavailable: UnavailableOperation): IExtensionHostApi {
	return {
		isAvailable: () => Promise.resolve(false),
		list: () => unavailable("extensionHost.list"),
		reconcile: () => unavailable("extensionHost.reconcile"),
		invoke: () => unavailable("extensionHost.invoke"),
		getConnectionState: () => Promise.resolve("stopped"),
		onDidChange: inertSubscription,
		onConnectionState: inertSubscription,
	};
}

export function createAppServerExtensionHostApi(connection: AppServerProtocolClient): IExtensionHostApi {
	const transport = {
		start: (request: Parameters<IExtensionHostApi["invoke"]>[0]) => appServerRequest(connection, "extensionHost/invoke/start", request),
		read: (invocationId: string) => appServerRequest(connection, "extensionHost/invoke/read", { invocationId }),
		cancel: (invocationId: string) => appServerRequest(connection, "extensionHost/invoke/cancel", { invocationId }),
	};
	return {
		isAvailable: () => Promise.resolve(connection.capabilities?.extensionHost === true),
		list: async () => normalizeExtensionHostSnapshot(await appServerRequest(connection, "extensionHost/list", {})),
		reconcile: async mode => normalizeExtensionHostSnapshot(await appServerRequest(connection, "extensionHost/reconcile", { mode })),
		invoke: (request, signal) => invokeExtensionHost(transport, request, signal),
		getConnectionState: () => Promise.resolve(connection.state),
		onDidChange: listener => connection.onNotification(event => {
			if (event.method === "extensionHost/changed") listener(normalizeExtensionHostChanged(event.params));
		}),
		onConnectionState: listener => connection.onStateChange(listener),
	};
}
