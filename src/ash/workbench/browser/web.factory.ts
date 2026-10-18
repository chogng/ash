import { parseJsonc } from '../../base/common/jsonc.js';
import { basename } from '../../base/common/resources.js';
import { parseStoredWorkspaceFolders, toWorkspaceFolders } from '../../platform/workspaces/common/workspaces.js';
import { IWorkspaceEditingService } from '../services/workspaces/common/workspaceEditing.js';
import { IContextKeyService } from '../../platform/contextkey/common/contextkey.js';
import { EnterMultiRootWorkspaceSupportContext } from '../common/contextkeys.js';
import { migrateLegacyBrowserSettings } from '../services/userData/browser/userDataInit.js';
import { IndexedDBFileSystemProvider } from '../../platform/files/browser/indexedDBFileSystemProvider.js';
import { Schemas } from '../../base/common/network.js';
import { BrowserURLService } from '../services/url/browser/urlService.js';
import type { IStartWorkbenchOptions } from './workbench.js';
import { IndexedDbWorkingCopyBackupService } from '../services/workingCopy/browser/indexedDbWorkingCopyBackupService.js';
import { addDisposableListener } from "../../base/browser/dom.js";
import { installBaseUiStyles } from "../../base/browser/ui/styles.js";
import {
	DisposableStore,
	toDisposable,
	type IDisposable,
} from "../../base/common/lifecycle.js";
import {
	createDisconnectedRendererApi,
} from "./rendererApi.js";
import {
	type IEmptyWorkspaceIdentifier,
	workspaceFromIdentifier,
} from "../../platform/workspace/common/workspace.js";
import {
	BrowserContextMenuService,
} from "../../platform/contextview/browser/contextMenuService.js";
import {
	createBrowserTitlebarPart,
	BrowserTitleService,
} from "./parts/titlebar/titlebarPart.js";
import type {
	IWebWorkbench,
	IWebWorkbenchConstructionOptions,
	IWebWorkbenchHost,
} from "./web.api.js";
import { startWorkbench } from "./workbench.js";
import { BrowserStorageService } from '../services/storage/browser/storageService.js';
import { LogService } from '../../platform/log/common/logServiceImpl.js';
import { ConsoleLogSink } from '../../platform/log/common/consoleLogSink.js';
import { HTMLFileSystemProvider } from '../../platform/files/browser/htmlFileSystemProvider.js';
import { WebFileSystemAccess } from '../../platform/files/browser/webFileSystemAccess.js';
import { BrowserLifecycleService } from '../services/lifecycle/browser/lifecycleService.js';
import { onUnexpectedError } from '../../base/common/errors.js';
import { EMPTY_WORKSPACE_ID_KEY } from '../services/host/browser/browserHostService.js';
import { URI } from '../../base/common/uri.js';
import { IWorkspaceContextService, parseWorkspaceIdentifier, type IAnyWorkspaceIdentifier } from '../../platform/workspace/common/workspace.js';
import { BrowserWorkbenchEnvironmentService } from '../services/environment/browser/environmentService.js';
import { createWebUpdateProvider } from '../services/update/browser/updateService.js';

/** Creates a browser-hosted Workbench with the shared Web adapters. */
export async function createWebWorkbench(
	options: IWebWorkbenchConstructionOptions,
): Promise<IWebWorkbench> {
	installBaseUiStyles();
	const ownerWindow = options.container.ownerDocument.defaultView;
	if (!ownerWindow) throw new Error('Workbench requires an owner window');

	const userFiles = await IndexedDBFileSystemProvider.create(ownerWindow.indexedDB, Schemas.vscodeUserData);
	try {
		await migrateLegacyBrowserSettings(ownerWindow.indexedDB, userFiles, URI.from({ scheme: Schemas.vscodeUserData, path: '/user/settings.json' }));
		const identifier = options.workspace ?? (options.browserFileSystemProvider ? getBrowserWorkspaceIdentifier(ownerWindow) : getEmptyWorkspaceIdentifier());
		let workspace = options.webWorkspaceClient?.getInitialWorkspace?.() ?? workspaceFromIdentifier(identifier);
		if (workspace.configuration && options.browserFileSystemProvider) {
			const resource = workspace.configuration;
			const provider = resource.scheme === Schemas.vscodeUserData ? userFiles : options.browserFileSystemProvider;
			const document = parseJsonc(new TextDecoder('utf-8', { fatal: true }).decode((await provider.readFile(resource)).bytes), resource.toString());
			const folders = toWorkspaceFolders(parseStoredWorkspaceFolders(document, resource.toString()), resource);
			for (const folder of folders) await options.browserFileSystemProvider.getDirectoryHandle(folder.uri);
			workspace = { id: identifier.id, configuration: resource, name: basename(resource).replace(/\.(ash|code)-workspace$/i, ''), folders };
		}

		return await startWorkbench({
			productName: options.productName,
			environmentService: new BrowserWorkbenchEnvironmentService(ownerWindow.location, options.webviewEndpoint, { updateProvider: options.updateProvider }),
			createURLService: services => services.createInstance(BrowserURLService, options.urlCallbackProvider),
			createTextDocumentHost: options.createTextDocumentHost,
			createStorageService: async storageOptions => new BrowserStorageService(storageOptions),
			createWorkingCopyBackupService: (_services, workspaceId) => new IndexedDbWorkingCopyBackupService(workspaceId),
			createLogService: () => new LogService({ sinks: [new ConsoleLogSink()] }),
			createUserDataFileSystemProvider: async () => userFiles,
			defaultLayout: options.defaultLayout,
			api: options.api,
			webWorkspaceClient: options.webWorkspaceClient,
			browserFileSystemProvider: options.browserFileSystemProvider,
			createWindow: options.browserFileSystemProvider || options.webWorkspaceClient?.updateWorkspace ? services => {
				const lifetime = new DisposableStore();
				const support = EnterMultiRootWorkspaceSupportContext.bindTo(services.get(IContextKeyService));
				support.set(true);
				lifetime.add(toDisposable(() => support.reset()));
				services.get(IWorkspaceEditingService);
				lifetime.add(services.get(IWorkspaceContextService).onDidChangeWorkspace(({ workspace }) => {
					const url = new URL(ownerWindow.location.href);
					const folder = workspace.configuration ? undefined : workspace.folders[0];
					if (workspace.configuration) url.searchParams.set('workspace', workspace.configuration.toString());
					else url.searchParams.delete('workspace');
					if (folder) {
						url.searchParams.set('folder', folder.uri.toString());
					} else {
						url.searchParams.delete('folder');
					}
					ownerWindow.history.replaceState(ownerWindow.history.state, '', url);
				}));
				return lifetime;
			} : undefined,
			container: options.container,
			createLifecycleService: services => services.createInstance(BrowserLifecycleService, { ownerWindow, onError: onUnexpectedError }),
			workspace,
			createContextMenuService: services => services.createInstance(BrowserContextMenuService),
			createTitleService: (container, productName, groups, services) => services.createInstance(BrowserTitleService, container, productName, createBrowserTitlebarPart, groups),
		});
	} catch (error) {
		userFiles.dispose();
		throw error;
	}
}

function getBrowserWorkspaceIdentifier(ownerWindow: Window): IAnyWorkspaceIdentifier {
	const params = new URL(ownerWindow.location.href).searchParams;
	const configuration = params.get('workspace');
	if (configuration) return parseWorkspaceIdentifier({ id: configuration, configPath: configuration });
	const folder = params.get('folder');
	if (!folder) { return getEmptyWorkspaceIdentifier(); }
	const uri = URI.parse(folder);
	// The URL carries identity only; the file provider checks the stored handle and permission on access.
	return { id: uri.toString(), uri };
}

function getEmptyWorkspaceIdentifier(): IEmptyWorkspaceIdentifier {
	const key = EMPTY_WORKSPACE_ID_KEY;
	let id = window.sessionStorage.getItem(key);
	if (!id) {
		id = `empty-window-${crypto.randomUUID()}`;
		window.sessionStorage.setItem(key, id);
	}
	return { id };
}

/**
 * Starts the Workbench from the optional global Web host and owns page
 * shutdown. Without a server host, files, settings and extensions are owned
 * by the browser; process-backed operations remain unavailable.
 */
export async function startWebWorkbench(
	options: Pick<IStartWorkbenchOptions, 'productName'>,
	hostLifetime?: IDisposable,
	createTextDocumentHost?: IStartWorkbenchOptions['createTextDocumentHost'],
): Promise<IDisposable> {
	const host = readWebWorkbenchHost();
	const workbench = new DisposableStore();
	workbench.add(hostLifetime);
	try {
		const api = host?.api ?? createDisconnectedRendererApi();
		const browserFileSystemProvider = !host && WebFileSystemAccess.supported(window) && globalThis.indexedDB
			? new HTMLFileSystemProvider(globalThis.indexedDB, window)
			: undefined;
		const instance = await createWebWorkbench({
			...options,
			webviewEndpoint: host?.webviewEndpoint,
			urlCallbackProvider: host?.urlCallbackProvider,
			updateProvider: host?.updateProvider ?? createWebUpdateProvider(document),
			api,
			createTextDocumentHost,
			webWorkspaceClient: host?.webWorkspaceClient,
			browserFileSystemProvider,
			defaultLayout: host?.defaultLayout,
			workspace: host?.workspace,
			container: host?.container ??
				document.querySelector<HTMLElement>("#app") ??
				document.body,
		});
		workbench.add(instance);
		workbench.add(addDisposableListener(window, "pagehide", () => {
			void instance.shutdown("pageHide").catch(error => console.error("Failed to shut down Workbench", error)).finally(() => workbench.dispose());
		}, { once: true }));
		await instance.whenRestored;
		return workbench;
	} catch (error) {
		workbench.dispose();
		throw error;
	}
}

function readWebWorkbenchHost(): IWebWorkbenchHost | undefined {
	const host = globalThis.ashWebWorkbenchHost;
	if (host === undefined) return undefined;
	if (
		typeof host !== "object" ||
		host === null ||
		typeof host.api !== "object" ||
		host.api === null
	) {
		throw new TypeError(
			"globalThis.ashWebWorkbenchHost must provide a renderer API",
		);
	}
	return host;
}
