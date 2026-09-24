import type { AppServerProtocolClient } from "../../app-server/browser/appServerProtocolClient.js";
import { appServerRequest, voidResult } from "../../app-server/browser/appServerRequest.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { IMarketplaceApi } from "../common/marketplaceApi.js";

export function createDisconnectedMarketplaceApi(unavailable: UnavailableOperation): IMarketplaceApi {
	return { search: () => unavailable("marketplace.search"), get: () => unavailable("marketplace.get"), download: () => unavailable("marketplace.download"), install: () => unavailable("marketplace.install"), update: () => unavailable("marketplace.update"), uninstall: () => unavailable("marketplace.uninstall"), listInstalled: () => unavailable("marketplace.listInstalled"), acquireCapability: () => unavailable("marketplace.acquireCapability"), releaseCapability: () => unavailable("marketplace.releaseCapability"), openResource: () => unavailable("marketplace.openResource") };
}

export function createAppServerMarketplaceApi(connection: AppServerProtocolClient): IMarketplaceApi {
	return {
		search: async params => {
			if ((params.capabilityKind || params.languageId) && connection.capabilities?.contracts.marketplaceSearch?.version !== 1) {
				throw new Error("This App Server does not support Marketplace capability and language filters. Update the App Server to search with these filters.");
			}
			return appServerRequest(connection, "marketplace/search", params);
		},
		get: params => appServerRequest(connection, "marketplace/get", params),
		download: params => appServerRequest(connection, "marketplace/download", params),
		install: params => appServerRequest(connection, "marketplace/install", params),
		update: params => appServerRequest(connection, "marketplace/update", params),
		uninstall: params => voidResult(appServerRequest(connection, "marketplace/uninstall", params)),
		listInstalled: () => appServerRequest(connection, "marketplace/listInstalled", {}),
		acquireCapability: params => appServerRequest(connection, "marketplace/acquireCapability", params),
		releaseCapability: params => voidResult(appServerRequest(connection, "marketplace/releaseCapability", params)),
		openResource: params => appServerRequest(connection, "marketplace/openResource", params),
	};
}
