import { Event } from '../../../base/common/event.js';
import type { IGlobalExtensionEnablementService } from '../../extensionManagement/common/extensionManagement.js';
import type { ExtensionCatalog, ExtensionResourceRequest, IExtensionApi } from '../common/extensionApi.js';
import { normalizeExtensionCatalog, MAX_EXTENSION_RESOURCE_BYTES } from '../common/extensionApi.js';
import { readAppServerResource } from '../../agentHost/browser/appServerApi.js';
import type { IResourceApi } from '../../agentHost/common/appServerApi.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import { localize } from '../../../nls.js';
import { ExtensionResourceLoaderService } from '../../extensionResourceLoader/browser/extensionResourceLoaderService.js';

/** No package discovery or resource fallback runs in a disconnected client. */
export function createDisconnectedExtensionApi(unavailable: UnavailableOperation): IExtensionApi {
	return {
		list: async () => normalizeExtensionCatalog({
			generation: 0, extensions: [], diagnostics: [{
				source: 'builtIn', subject: null, code: 'sourceUnavailable',
				message: localize('extensions.backend.unavailable', 'Connect to the App Server to load extensions.'),
			}],
		}),
		resources: new ExtensionResourceLoaderService(() => unavailable('extensions.resource')),
	};
}

/** Both executable and declarative consumers read the same profile enablement. */
export function withEnabledBuiltInExtensions(packages: IExtensionApi, enablement: IGlobalExtensionEnablementService): IExtensionApi {
	return {
		onDidChange: Event.any(packages.onDidChange ?? Event.None, Event.map(enablement.onDidChangeEnablement, () => undefined)),
		list: async (reload, options) => {
			const catalog = await packages.list(reload);
			if (options?.includeDisabled) { return catalog; }
			const disabled = new Set(enablement.getDisabledExtensions().map(extension => extension.id));
			return { ...catalog, extensions: catalog.extensions.filter(extension => extension.sourceKind !== 'builtIn' || !disabled.has(extension.id.toLowerCase())) };
		},
		resources: packages.resources,
	};
}

/** Adapts the single Rust catalog and fences resource handles across connection incarnations. */
export function createAppServerExtensionApi(connection: AppServerProtocolClient, resourceApi: IResourceApi): IExtensionApi {
	let published: { connectionGeneration: number; backendGeneration: number; catalog: ExtensionCatalog; } | undefined;
	let generation = 0;
	let pending: Promise<unknown> = Promise.resolve();
	const retired = () => new Error(localize('extensions.resources.retired', 'Extension resource generation has retired.'));
	return {
		// An interrupted activation must retry against the newly initialized catalog.
		onDidChange: (listener, thisArgs) => connection.onStateChange(state => {
			if (state === 'ready') { listener.call(thisArgs); }
		}),
		list(reload) {
			const next = pending.then(async () => {
				const incarnation = resourceApi.connectionGeneration;
				const catalog = normalizeExtensionCatalog(await appServerRequest(connection, 'extensions/list', { reload }));
				if (incarnation !== resourceApi.connectionGeneration) { throw retired(); }
				if (published?.connectionGeneration === incarnation && published.backendGeneration === catalog.generation) { return published.catalog; }
				const exposed = Object.freeze({ ...catalog, generation: ++generation });
				published = { connectionGeneration: incarnation, backendGeneration: catalog.generation, catalog: exposed };
				return exposed;
			});
			pending = next.catch(() => undefined);
			return next;
		},
		resources: new ExtensionResourceLoaderService(async request => {
			const snapshot = published;
			if (!snapshot || request.generation !== snapshot.catalog.generation || snapshot.connectionGeneration !== resourceApi.connectionGeneration) { throw retired(); }
			const bytes = await readExtensionResource(connection, resourceApi, { ...request, generation: snapshot.backendGeneration });
			if (published !== snapshot || snapshot.connectionGeneration !== resourceApi.connectionGeneration) { throw retired(); }
			return bytes;
		}, {
			template: async () => {
				if (connection.capabilities?.contracts.extensionGalleryResources?.version !== 1) { return undefined; }
				return (await appServerRequest(connection, 'extensions/gallery', {})).resourceUrlTemplate ?? undefined;
			},
			read: async request => {
				const incarnation = resourceApi.connectionGeneration;
				const opened = await appServerRequest(connection, 'extensions/gallery/resource/open', request);
				return readAppServerResource(resourceApi, opened.resource, MAX_EXTENSION_RESOURCE_BYTES, undefined, incarnation);
			},
		}),
	};
}

async function readExtensionResource(connection: AppServerProtocolClient, resourceApi: IResourceApi, request: ExtensionResourceRequest): Promise<Uint8Array> {
	const incarnation = resourceApi.connectionGeneration;
	const opened = await appServerRequest(connection, 'extensions/resource/open', request);
	return readAppServerResource(resourceApi, opened.resource, MAX_EXTENSION_RESOURCE_BYTES, undefined, incarnation);
}
