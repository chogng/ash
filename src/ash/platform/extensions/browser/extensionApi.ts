import { Event } from '../../../base/common/event.js';
import { LRUCache } from '../../../base/common/map.js';
import type { IExtensionManagementService } from '../../extensionManagement/common/extensionManagementService.js';
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
export function withEnabledBuiltInExtensions(packages: IExtensionApi, enablement: IGlobalExtensionEnablementService, management?: IExtensionManagementService): IExtensionApi {
	return {
		onDidChange: Event.any(packages.onDidChange ?? Event.None, Event.map(enablement.onDidChangeEnablement, () => undefined), management?.onDidChangeInstalled ?? Event.None),
		list: async (reload, options) => {
			const catalog = await packages.list(reload);
			if (options?.includeDisabled) { return catalog; }
			const disabled = new Set(enablement.getDisabledExtensions().map(extension => extension.id));
			const languageExtensions = new Set(catalog.extensions.filter(extension => extension.sourceKind === 'builtIn' && JSON.parse(extension.manifestJson).ashLanguageServers).map(extension => extension.id));
			// The backend owns these extensions' enablement for both syntax and executable
			// contributions. Do not mirror it in the declarative-only profile setting.
			const providers = languageExtensions.size ? await management?.listBuiltInProviders().catch(() => undefined) : undefined;
			return { ...catalog, extensions: catalog.extensions.filter(extension => languageExtensions.has(extension.id) ? providers?.providers.some(provider => provider.id === extension.id && provider.enabled) : extension.sourceKind !== 'builtIn' || !disabled.has(extension.id.toLowerCase())) };
		},
		resources: packages.resources,
	};
}

/** Adapts the single Rust catalog and fences resource handles across connection incarnations. */
export function createAppServerExtensionApi(connection: AppServerProtocolClient, resourceApi: IResourceApi): IExtensionApi {
	let published: { connectionGeneration: number; backendGeneration: number; catalog: ExtensionCatalog; } | undefined;
	let generation = 0;
	let pending: Promise<ExtensionCatalog> | undefined;
	// Small immutable resources are shared by theme, declaration and executable loaders.
	// Bound retained bytes to 64 × 128 KiB; large browser bundles remain uncached.
	const resources = new LRUCache<string, Promise<Uint8Array>>(64);
	const retired = () => new Error(localize('extensions.resources.retired', 'Extension resource generation has retired.'));
	return {
		// An interrupted activation must retry against the newly initialized catalog.
		onDidChange: (listener, thisArgs) => connection.onStateChange(state => {
			if (state === 'ready') { listener.call(thisArgs); }
		}),
		list(reload) {
			const load = async () => {
				const incarnation = resourceApi.connectionGeneration;
				const catalog = normalizeExtensionCatalog(await appServerRequest(connection, 'extensions/list', { reload }));
				if (incarnation !== resourceApi.connectionGeneration) { throw retired(); }
				if (published?.connectionGeneration === incarnation && published.backendGeneration === catalog.generation) { return published.catalog; }
				const exposed = Object.freeze({ ...catalog, generation: ++generation });
				resources.clear();
				published = { connectionGeneration: incarnation, backendGeneration: catalog.generation, catalog: exposed };
				return exposed;
			};
			// Dispatch the idle queue synchronously: callers may construct the entire
			// Workbench before yielding, while the backend can already load its catalog.
			const next = pending ? pending.then(load, load) : load();
			pending = next;
			const settled = () => { if (pending === next) pending = undefined; };
			void next.then(settled, settled);
			return next;
		},
		resources: new ExtensionResourceLoaderService(async request => {
			const snapshot = published;
			if (!snapshot || request.generation !== snapshot.catalog.generation || snapshot.connectionGeneration !== resourceApi.connectionGeneration) { throw retired(); }
			const key = `${request.extensionId}\0${request.path}`;
			let operation = resources.get(key);
			if (!operation) {
				operation = readExtensionResource(connection, resourceApi, { ...request, generation: snapshot.backendGeneration });
				resources.set(key, operation);
				const current = operation;
				const forget = () => { if (resources.peek(key) === current) resources.delete(key); };
				void operation.then(bytes => { if (bytes.byteLength > 128 * 1024) forget(); }, forget);
			}
			const bytes = await operation;
			if (published !== snapshot || snapshot.connectionGeneration !== resourceApi.connectionGeneration) { throw retired(); }
			// Callers may edit their buffer; the verified cached bytes remain private.
			return Uint8Array.from(bytes);
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
