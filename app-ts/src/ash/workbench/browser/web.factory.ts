import { BrowserURLService } from '../services/url/browser/urlService.js';
import type { IStartWorkbenchOptions } from './workbench.js';
import { IndexedDbWorkingCopyBackupService } from '../services/workingCopy/browser/indexedDbWorkingCopyBackupService.js';
import { addDisposableListener } from "../../base/browser/dom.js";
import { installBaseUiStyles } from "../../base/browser/ui/styles.js";
import {
	DisposableStore,
	type IDisposable,
} from "../../base/common/lifecycle.js";
import type { WorkbenchModeId } from "../common/workbenchMode.js";
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
import { BrowserStorageService, migrateBrowserStorage } from '../services/storage/browser/storageService.js';
import { LogService } from '../../platform/log/common/logServiceImpl.js';
import { ConsoleLogSink } from '../../platform/log/common/consoleLogSink.js';
import { HTMLFileSystemProvider } from '../../platform/files/browser/htmlFileSystemProvider.js';
import { BrowserLifecycleService } from '../services/lifecycle/browser/lifecycleService.js';
import { onUnexpectedError } from '../../base/common/errors.js';
import { EMPTY_WORKSPACE_ID_KEY } from '../services/host/browser/browserHostService.js';
import { IndexedDbConfigurationApi } from '../../platform/configuration/browser/indexedDbConfigurationApi.js';
import { migrateAcademicWorkbenchSettings } from '../common/workbenchMode.js';

/** Creates a browser-hosted Workbench with the shared Web adapters. */
export async function createWebWorkbench(
	modeId: WorkbenchModeId,
	options: IWebWorkbenchConstructionOptions,
): Promise<IWebWorkbench> {
	installBaseUiStyles();
	const ownerWindow = options.container.ownerDocument.defaultView;
	if (!ownerWindow) throw new Error('Workbench requires an owner window');
	const conflicts = migrateBrowserStorage(ownerWindow.localStorage, 'academic', 'code');
	if (conflicts.length > 0) { console.warn('Academic state migration retained conflicting entries', conflicts); }
	return startWorkbench({
		modeId,
		createURLService: services => services.createInstance(BrowserURLService, options.urlCallbackProvider),
		createTextDocumentHost: options.createTextDocumentHost,
		createStorageService: async storageOptions => new BrowserStorageService(storageOptions),
		createWorkingCopyBackupService: (_services, workspaceId) => new IndexedDbWorkingCopyBackupService(workspaceId),
		createLogService: () => new LogService({ sinks: [new ConsoleLogSink()] }),
		configurationApi: options.configurationApi,
		initialConfigurationSnapshot: options.initialConfigurationSnapshot,
		defaultLayout: options.defaultLayout,
		api: options.api,
		webWorkspaceClient: options.webWorkspaceClient,
		browserFileSystemProvider: options.browserFileSystemProvider,
		container: options.container,
		createLifecycleService: services => services.createInstance(BrowserLifecycleService, { ownerWindow, onError: onUnexpectedError }),
		workspace: workspaceFromIdentifier(options.workspace ?? getEmptyWorkspaceIdentifier()),
		createContextMenuService: createBrowserContextMenuService,
		createTitlebarPart: createBrowserTitlebarPart,
	});
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
 * Starts a Workbench mode from the optional global Web host and owns page
 * shutdown. A page without an embedder starts in an explicit disconnected
 * state so its UI remains inspectable without claiming backend availability.
 */
export async function startWebWorkbench(
	modeId: WorkbenchModeId,
	hostLifetime?: IDisposable,
	createTextDocumentHost?: IStartWorkbenchOptions['createTextDocumentHost'],
): Promise<IDisposable> {
	const host = readWebWorkbenchHost();
	const workbench = new DisposableStore();
	workbench.add(hostLifetime);
	try {
		const configurationApi = workbench.add(new IndexedDbConfigurationApi());
		let initialConfigurationSnapshot = await configurationApi.read();
		const migratedSource = migrateAcademicWorkbenchSettings(initialConfigurationSnapshot.document.source);
		if (migratedSource !== undefined) {
			initialConfigurationSnapshot = await configurationApi.update({ expectedRevision: initialConfigurationSnapshot.revision, document: { version: 1, source: migratedSource } });
		}
		const picker = window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> };
		const browserFileSystemProvider = !host && picker.showDirectoryPicker && globalThis.indexedDB
			? new HTMLFileSystemProvider(globalThis.indexedDB)
			: undefined;
		const instance = await createWebWorkbench(modeId, {
			urlCallbackProvider: host?.urlCallbackProvider,
			api: host?.api ?? createDisconnectedRendererApi(),
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
