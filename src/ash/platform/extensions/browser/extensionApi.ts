import { URI } from '../../../base/common/uri.js';
import { extensionResourceRequest } from '../../extensionResourceLoader/common/extensionResourceLoader.js';
import { decodeBase64 } from "../../../base/common/buffer.js";
import type { ExtensionCatalog, ExtensionCatalogReload, ExtensionResourceRequest, IExtensionApi } from "../common/extensionApi.js";
import { normalizeExtensionCatalog, MAX_EXTENSION_RESOURCE_BYTES } from "../common/extensionApi.js";
import { readAppServerResource } from '../../agentHost/browser/appServerApi.js';
import type { IResourceApi } from "../../agentHost/common/appServerApi.js";
import type { AppServerProtocolClient } from "../../agentHost/browser/appServerProtocolClient.js";
import { appServerRequest } from "../../agentHost/browser/appServerRequest.js";
import { localize } from '../../../nls.js';
import { ExtensionResourceLoaderService } from '../../extensionResourceLoader/browser/extensionResourceLoaderService.js';

/** Reads complete package snapshots prepared by the browser build, without server transport. */
export function createBrowserExtensionApi(fetchResource: typeof fetch = fetch): IExtensionApi {
	// Package bytes are a static asset, not JavaScript imported into every renderer entry.
	let snapshot: Promise<{ catalog: ReturnType<typeof normalizeExtensionCatalog>; resources: Readonly<Record<string, Readonly<Record<string, string>>>>; }> | undefined;
	const load = () => snapshot ??= (async () => {
		const response = await fetchResource(new URL('../common/generated/browser.json', import.meta.url));
		if (!response.ok) { throw new Error(localize('extensions.browser.catalogFailure', 'Cannot load browser extension catalog: HTTP {0}', response.status)); }
		const bundle = await response.json();
		return { catalog: normalizeExtensionCatalog(bundle.catalog), resources: bundle.resources };
	})().catch(error => { snapshot = undefined; throw error; });
	return {
		list: async () => (await load()).catalog,
		resources: new ExtensionResourceLoaderService(async request => {
			const { catalog, resources } = await load();
			const extension = resources[request.extensionId];
			if (request.generation !== catalog.generation || !extension || !Object.hasOwn(extension, request.path)) {
				throw new Error(localize('extensions.browser.resourceMissing', 'Browser extension resource is not in the current package: {0}/{1}', request.extensionId, request.path));
			}
			const encoded = extension[request.path];
			if (typeof encoded !== 'string' || encoded.length > 4 * Math.ceil(MAX_EXTENSION_RESOURCE_BYTES / 3)) { throw new RangeError(localize('extensions.browser.resourceTooLarge', 'Browser extension resource exceeds its byte limit.')); }
			const bytes = decodeBase64(encoded).buffer;
			if (bytes.byteLength > MAX_EXTENSION_RESOURCE_BYTES) { throw new RangeError(localize('extensions.browser.resourceTooLarge', 'Browser extension resource exceeds its byte limit.')); }
			return bytes;
		}),
	};
}

export function createAppServerExtensionApi(connection: AppServerProtocolClient, resourceApi: IResourceApi): IExtensionApi {
	return withBuiltInExtensions({
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
	});
}

/** The client owns built-in editor assets; the backend exposes only host-selected external packages. */
export function withBuiltInExtensions(installed: IExtensionApi, builtIn: IExtensionApi = createBrowserExtensionApi()): IExtensionApi {
	let current: { catalog: ExtensionCatalog; builtIn: ExtensionCatalog; installed: ExtensionCatalog; } | undefined;
	let generation = 0;
	let fingerprint: string | undefined;
	// Serialize publication so a slower refresh cannot restore a retired resource generation.
	let pending: Promise<unknown> = Promise.resolve();
	const resources = new ExtensionResourceLoaderService(async request => {
		const snapshot = current;
		if (!snapshot || request.generation !== snapshot.catalog.generation) { throw new Error(localize('extensions.resources.retired', 'Extension resource generation has retired.')); }
		const local = snapshot.builtIn.extensions.some(extension => extension.id === request.extensionId);
		const source = local ? builtIn : installed;
		const sourceGeneration = local ? snapshot.builtIn.generation : snapshot.installed.generation;
		const bytes = await source.resources.readExtensionResourceBytes({ ...request, generation: sourceGeneration });
		if (current !== snapshot) { throw new Error(localize('extensions.resources.retired', 'Extension resource generation has retired.')); }
		return bytes;
	});
	const readBytes: IExtensionApi['resources']['readExtensionResourceBytes'] = resource => {
		if (URI.isUri(resource) && !extensionResourceRequest(resource)) { return installed.resources.readExtensionResourceBytes(resource); }
		return resources.readExtensionResourceBytes(resource);
	};
	return {
		list(reload) {
			const next = pending.then(async () => {
				const [local, remote] = await Promise.all([builtIn.list('cached'), installed.list(reload)]);
				const identity = JSON.stringify([local, remote]);
				if (identity === fingerprint && current) { return current.catalog; }
				const ids = new Set(local.extensions.map(extension => extension.id));
				const duplicates = remote.extensions.filter(extension => ids.has(extension.id));
				const catalog: ExtensionCatalog = Object.freeze({
					generation: ++generation,
					extensions: Object.freeze([...local.extensions, ...remote.extensions.filter(extension => !ids.has(extension.id))]),
					diagnostics: Object.freeze([...local.diagnostics, ...remote.diagnostics, ...duplicates.map(extension => ({ source: extension.sourceKind, subject: extension.id, code: 'duplicateExtension' as const, message: localize('extensions.resources.duplicate', 'Extension ID is already provided by the product.') }))]),
				});
				current = { catalog, builtIn: local, installed: remote };
				fingerprint = identity;
				return catalog;
			});
			pending = next.catch(() => undefined);
			return next;
		},
		resources: {
			readExtensionResource: async uri => new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(uri)),
			readExtensionResourceBytes: readBytes,
			supportsExtensionGalleryResources: () => installed.resources.supportsExtensionGalleryResources(),
			isExtensionGalleryResource: uri => installed.resources.isExtensionGalleryResource(uri),
			getExtensionGalleryResourceURL: (extension, path) => installed.resources.getExtensionGalleryResourceURL(extension, path),
		},
	};
}

async function readExtensionResource(connection: AppServerProtocolClient, resourceApi: IResourceApi, request: ExtensionResourceRequest): Promise<Uint8Array> {
	const generation = resourceApi.connectionGeneration;
	const opened = await appServerRequest(connection, 'extensions/resource/open', request);
	return readAppServerResource(resourceApi, opened.resource, MAX_EXTENSION_RESOURCE_BYTES, undefined, generation);
}
