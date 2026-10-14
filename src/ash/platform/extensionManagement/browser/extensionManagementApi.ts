import type { AppServerProtocolClient } from "../../agentHost/browser/appServerProtocolClient.js";
import { appServerRequest, voidResult } from "../../agentHost/browser/appServerRequest.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { IExtensionManagementApi } from "../common/extensionManagementApi.js";
import { localize } from '../../../nls.js';

export function createDisconnectedExtensionsApi(unavailable: UnavailableOperation): IExtensionManagementApi {
	return { searchPage: () => unavailable('extensionManagement.searchPage'), builtInProviders: () => unavailable("extensions.builtInProviders"), setBuiltInProviderEnablement: () => unavailable("extensions.setBuiltInProviderEnablement"), sources: () => unavailable("extensions.sources"), addSource: () => unavailable("extensions.addSource"), setSourceEnabled: () => unavailable("extensions.setSourceEnabled"), search: () => unavailable("extensionManagement.search"), get: () => unavailable("extensionManagement.get"), download: () => unavailable("extensionManagement.download"), install: () => unavailable("extensionManagement.install"), update: () => unavailable("extensionManagement.update"), uninstall: () => unavailable("extensionManagement.uninstall"), listInstalled: () => unavailable("extensionManagement.listInstalled"), editorExtensions: () => unavailable("extensionManagement.editorExtensions"), setEditorExtensionPolicy: () => unavailable("extensionManagement.setEditorExtensionPolicy"), acquireCapability: () => unavailable("extensionManagement.acquireCapability"), releaseCapability: () => unavailable("extensionManagement.releaseCapability"), openResource: () => unavailable("extensionManagement.openResource") };
}

export function createAppServerExtensionManagementApi(connection: AppServerProtocolClient): IExtensionManagementApi {
	return {
		searchPage: params => {
			if (connection.capabilities?.contracts.extensionsPaging?.version !== 1) {
				return Promise.reject(new Error(localize({ bundle: 'ash.extensions', key: 'marketplacePagingUnsupported' }, 'This App Server does not support paged extension catalogs. Update the App Server.')));
			}
			return appServerRequest(connection, 'extensions/searchPage', params);
		},
		builtInProviders: () => appServerRequest(connection, 'extensions/builtInProviders', {}),
		setBuiltInProviderEnablement: params => appServerRequest(connection, 'extensions/setBuiltInProviderEnablement', params),
		sources: () => appServerRequest(connection, 'extensions/sources/list', {}),
		addSource: params => appServerRequest(connection, 'extensions/sources/add', params),
		setSourceEnabled: params => appServerRequest(connection, 'extensions/sources/setEnabled', params),
		search: async params => {
			if ((params.capabilityKind || params.languageId) && connection.capabilities?.contracts.extensionsSearch?.version !== 1) {
				throw new Error("This App Server does not support Extensions capability and language filters. Update the App Server to search with these filters.");
			}
			return appServerRequest(connection, "extensions/search", params);
		},
		get: params => appServerRequest(connection, "extensions/get", params),
		download: params => appServerRequest(connection, "extensions/download", params),
		install: params => appServerRequest(connection, "extensions/install", params),
		update: params => appServerRequest(connection, "extensions/update", params),
		uninstall: params => voidResult(appServerRequest(connection, "extensions/uninstall", params)),
		listInstalled: () => appServerRequest(connection, "extensions/listInstalled", {}),
		editorExtensions: () => appServerRequest(connection, "extensions/editorExtensions", {}),
		setEditorExtensionPolicy: params => appServerRequest(connection, "extensions/setEditorExtensionPolicy", params),
		acquireCapability: params => appServerRequest(connection, "extensions/acquireCapability", params),
		releaseCapability: params => voidResult(appServerRequest(connection, "extensions/releaseCapability", params)),
		openResource: params => appServerRequest(connection, "extensions/openResource", params),
	};
}
