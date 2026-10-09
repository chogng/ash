import { decodeBase64 } from "../../../base/common/buffer.js";
import type { ExtensionCatalogReload, ExtensionResourceRequest, IExtensionApi } from "../common/extensionApi.js";
import { normalizeExtensionCatalog, MAX_EXTENSION_RESOURCE_BYTES } from "../common/extensionApi.js";
import { readAppServerResource } from '../../agentHost/browser/appServerApi.js';
import type { IResourceApi } from "../../agentHost/common/appServerApi.js";
import type { AppServerProtocolClient } from "../../agentHost/browser/appServerProtocolClient.js";
import { appServerRequest } from "../../agentHost/browser/appServerRequest.js";
import { localize } from '../../../nls.js';
import { ExtensionResourceLoaderService } from '../../extensionResourceLoader/browser/extensionResourceLoaderService.js';

/** Reads complete package snapshots prepared by the browser build, without server transport. */
export function createBrowserExtensionApi(): IExtensionApi {
	// Package bytes are a static asset, not JavaScript imported into every renderer entry.
	let snapshot: Promise<{ catalog: ReturnType<typeof normalizeExtensionCatalog>; resources: Readonly<Record<string, Readonly<Record<string, string>>>>; }> | undefined;
	const load = () => snapshot ??= (async () => {
		const response = await fetch(new URL('../common/generated/browser.json', import.meta.url));
		if (!response.ok) { throw new Error(localize('extensions.browser.catalogFailure', 'Cannot load browser extension catalog: HTTP {0}', response.status)); }
		const bundle = await response.json();
		return { catalog: normalizeExtensionCatalog(bundle.catalog), resources: bundle.resources };
	})();
	return {
		list: async () => (await load()).catalog,
		resources: new ExtensionResourceLoaderService(async request => {
			const { catalog, resources } = await load();
			const extension = resources[request.extensionId];
			if (request.generation !== catalog.generation || !extension || !Object.hasOwn(extension, request.path)) {
				throw new Error(localize('extensions.browser.resourceMissing', 'Browser extension resource is not in the current package: {0}/{1}', request.extensionId, request.path));
			}
			return decodeBase64(extension[request.path]).buffer;
		}),
	};
}

export function createAppServerExtensionApi(connection: AppServerProtocolClient, resourceApi: IResourceApi): IExtensionApi {
	return {
		list: async (reload: ExtensionCatalogReload) => normalizeExtensionCatalog(await appServerRequest(connection, "extensions/list", { reload })),
		resources: new ExtensionResourceLoaderService(request => readExtensionResource(connection, resourceApi, request), {
			template: async () => {
				if (connection.capabilities?.contracts.extensionGalleryResources?.version !== 1) { return undefined; }
				return (await appServerRequest(connection, 'extensions/gallery', {})).resourceUrlTemplate ?? undefined;
			},
			read: async request => {
				const generation = resourceApi.connectionGeneration;
				const opened = await appServerRequest(connection, 'extensions/gallery/resource/open', request);
				return readAppServerResource(resourceApi, opened.resource, MAX_EXTENSION_RESOURCE_BYTES, undefined, generation);
			},
		}),
	};
}

async function readExtensionResource(connection: AppServerProtocolClient, resourceApi: IResourceApi, request: ExtensionResourceRequest): Promise<Uint8Array> {
	const generation = resourceApi.connectionGeneration;
	const opened = await appServerRequest(connection, 'extensions/resource/open', request);
	return readAppServerResource(resourceApi, opened.resource, MAX_EXTENSION_RESOURCE_BYTES, undefined, generation);
}
