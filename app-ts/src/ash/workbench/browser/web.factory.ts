import { IndexedDBFileSystemProvider } from '../../platform/files/browser/indexedDBFileSystemProvider.js';
import { Schemas } from '../../base/common/network.js';
import { BrowserURLService } from '../services/url/browser/urlService.js';
import type { IStartWorkbenchOptions } from './workbench.js';
import { IndexedDbWorkingCopyBackupService } from '../services/workingCopy/browser/indexedDbWorkingCopyBackupService.js';
import { addDisposableListener } from "../../base/browser/dom.js";
import { installBaseUiStyles } from "../../base/browser/ui/styles.js";
import {
	DisposableStore,
	type IDisposable,
} from "../../base/common/lifecycle.js";
import {
	createDisconnectedRendererApi,
} from "../../platform/app-server/browser/rendererApi.js";
import {
	type IEmptyWorkspaceIdentifier,
	workspaceFromIdentifier,
} from "../../platform/workspace/common/workspace.js";
import {
	createBrowserContextMenuService,
} from "../../platform/contextview/browser/contextMenuService.js";
import {
	createBrowserTitlebarPart,
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
import { BrowserLifecycleService } from '../services/lifecycle/browser/lifecycleService.js';
import { onUnexpectedError } from '../../base/common/errors.js';
import { EMPTY_WORKSPACE_ID_KEY } from '../services/host/browser/browserHostService.js';
import { URI } from '../../base/common/uri.js';
import { IWorkspaceContextService, type IAnyWorkspaceIdentifier } from '../../platform/workspace/common/workspace.js';
import { IndexedDbConfigurationApi } from '../../platform/configuration/browser/indexedDbConfigurationApi.js';
import { createBrowserExtensionApi } from '../../platform/extensions/browser/extensionApi.js';
import { BrowserExtensionHostApi } from '../../platform/extensionHost/browser/extensionHostApi.js';

/** Creates a browser-hosted Workbench with the shared Web adapters. */
export async function createWebWorkbench(
	options: IWebWorkbenchConstructionOptions,
): Promise<IWebWorkbench> {
	installBaseUiStyles();
	const ownerWindow = options.container.ownerDocument.defaultView;
	if (!ownerWindow) throw new Error('Workbench requires an owner window');

	return startWorkbench({
		productName: options.productName,
		createURLService: services => services.createInstance(BrowserURLService, options.urlCallbackProvider),
		createTextDocumentHost: options.createTextDocumentHost,
		createStorageService: async storageOptions => new BrowserStorageService(storageOptions),
		createWorkingCopyBackupService: (_services, workspaceId) => new IndexedDbWorkingCopyBackupService(workspaceId),
		createLogService: () => new LogService({ sinks: [new ConsoleLogSink()] }),
		createUserDataFileSystemProvider: () => IndexedDBFileSystemProvider.create(ownerWindow.indexedDB, Schemas.vscodeUserData),
		configurationApi: options.configurationApi,
		initialConfigurationSnapshot: options.initialConfigurationSnapshot,
		defaultLayout: options.defaultLayout,
		api: options.api,
		webWorkspaceClient: options.webWorkspaceClient,
		browserFileSystemProvider: options.browserFileSystemProvider,
		createWindow: options.browserFileSystemProvider ? services => services.get(IWorkspaceContextService).onDidChangeWorkspace(({ workspace }) => {
			const url = new URL(ownerWindow.location.href);
			const folder = workspace.folders[0];
			if (folder) {
				url.searchParams.set('folder', folder.uri.toString());
			} else {
				url.searchParams.delete('folder');
			}
			ownerWindow.history.replaceState(ownerWindow.history.state, '', url);
		}) : undefined,
		container: options.container,
		createLifecycleService: services => services.createInstance(BrowserLifecycleService, { ownerWindow, onError: onUnexpectedError }),
		workspace: workspaceFromIdentifier(options.workspace ?? (options.browserFileSystemProvider ? getBrowserWorkspaceIdentifier(ownerWindow) : getEmptyWorkspaceIdentifier())),
		createContextMenuService: createBrowserContextMenuService,
		createTitlebarPart: createBrowserTitlebarPart,
	});
}

function getBrowserWorkspaceIdentifier(ownerWindow: Window): IAnyWorkspaceIdentifier {
	const folder = new URL(ownerWindow.location.href).searchParams.get('folder');
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
		const configurationApi = workbench.add(new IndexedDbConfigurationApi());
		const initialConfigurationSnapshot = await configurationApi.read();
		let api = host?.api;
		if (!api) {
			const extensions = createBrowserExtensionApi();
			api = { ...createDisconnectedRendererApi(), extensions, extensionHost: workbench.add(new BrowserExtensionHostApi(extensions)) };
		}
		const picker = window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> };
		const browserFileSystemProvider = !host && picker.showDirectoryPicker && globalThis.indexedDB
			? new HTMLFileSystemProvider(globalThis.indexedDB)
			: undefined;
		const instance = await createWebWorkbench({
			...options,
			urlCallbackProvider: host?.urlCallbackProvider,
			api,
			createTextDocumentHost,
			configurationApi,
			initialConfigurationSnapshot,
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
