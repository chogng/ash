import { decodeBase64, VSBuffer } from "../../../base/common/buffer.js";
import type { ExtensionCatalogReload, ExtensionResourceRequest, IExtensionApi } from "../common/extensionApi.js";
import { normalizeExtensionCatalog, normalizeExtensionResourceChunk, normalizeExtensionResourceOpenResult, verifyExtensionResourceDigest } from "../common/extensionApi.js";
import type { IResourceApi } from "../../agentHost/common/appServerApi.js";
import type { AppServerProtocolClient } from "../../agentHost/browser/appServerProtocolClient.js";
import { appServerRequest } from "../../agentHost/browser/appServerRequest.js";
import { localize } from '../../../nls.js';

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
		readResource: async request => {
			const { catalog, resources } = await load();
			const extension = resources[request.extensionId];
			if (request.generation !== catalog.generation || !extension || !Object.hasOwn(extension, request.path)) {
				throw new Error(localize('extensions.browser.resourceMissing', 'Browser extension resource is not in the current package: {0}/{1}', request.extensionId, request.path));
			}
			return decodeBase64(extension[request.path]).buffer;
		},
	};
}

export function createAppServerExtensionApi(connection: AppServerProtocolClient, resourceApi: IResourceApi): IExtensionApi {
	return {
		list: async (reload: ExtensionCatalogReload) => normalizeExtensionCatalog(await appServerRequest(connection, "extensions/list", { reload })),
		readResource: request => readExtensionResource(connection, resourceApi, request),
	};
}

async function readExtensionResource(connection: AppServerProtocolClient, resourceApi: IResourceApi, request: ExtensionResourceRequest): Promise<Uint8Array> {
	const resource = normalizeExtensionResourceOpenResult(await appServerRequest(connection, "extensions/resource/open", request));
	const chunks: VSBuffer[] = [];
	let offset = 0;
	try {
		while (offset < resource.size) {
			const chunk = normalizeExtensionResourceChunk(await resourceApi.read({ resourceId: resource.resourceId, offset, maxBytes: Math.min(262_144, resource.size - offset) }));
			const bytes = decodeBase64(chunk.dataBase64);
			if (chunk.resourceId !== resource.resourceId || chunk.offset !== offset || chunk.decodedLength !== bytes.byteLength || bytes.byteLength === 0 || bytes.byteLength > resource.size - offset) throw new Error("Extension resource response is inconsistent");
			chunks.push(bytes);
			offset += bytes.byteLength;
			if (chunk.eof !== (offset === resource.size)) throw new Error("Extension resource EOF marker is inconsistent");
		}
		const bytes = VSBuffer.concat(chunks);
		if (bytes.byteLength !== resource.size) throw new Error("Extension resource byte count is inconsistent");
		await verifyExtensionResourceDigest(bytes.buffer, resource.sha256);
		return bytes.buffer;
	} finally {
		await resourceApi.release({ resourceId: resource.resourceId });
	}
}
