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
import { switchBrowserWorkbenchMode } from "../services/workbenchMode/browser/browserWorkbenchModeHost.js";
import { HTMLFileSystemProvider } from '../../platform/files/browser/htmlFileSystemProvider.js';
import { BrowserLifecycleService } from '../services/lifecycle/browser/lifecycleService.js';
import { onUnexpectedError } from '../../base/common/errors.js';
import { IndexedDbConfigurationApi } from '../../platform/configuration/browser/indexedDbConfigurationApi.js';

/** Creates a browser-hosted Workbench with the shared Web adapters. */
export function createWebWorkbench(
	modeId: WorkbenchModeId,
	options: IWebWorkbenchConstructionOptions,
): IWebWorkbench {
	installBaseUiStyles();
	const ownerWindow = options.container.ownerDocument.defaultView;
	if (!ownerWindow) throw new Error('Workbench requires an owner window');
	return startWorkbench({
		modeId,
		configurationApi: options.configurationApi,
		initialConfigurationSnapshot: options.initialConfigurationSnapshot,
		defaultLayout: options.defaultLayout,
		api: options.api,
		webWorkspaceClient: options.webWorkspaceClient,
		browserFileSystemProvider: options.browserFileSystemProvider,
		container: options.container,
		lifecycleService: new BrowserLifecycleService({ ownerWindow, onError: onUnexpectedError }),
		workspace: workspaceFromIdentifier(options.workspace ?? getEmptyWorkspaceIdentifier()),
		createContextMenuService: createBrowserContextMenuService,
		createTitlebarPart: createBrowserTitlebarPart,
		switchWorkbenchMode: options.switchWorkbenchMode ?? (targetModeId => switchBrowserWorkbenchMode(window, targetModeId)),
	});
}

function getEmptyWorkspaceIdentifier(): IEmptyWorkspaceIdentifier {
	const key = 'ash.workbench.emptyWorkspaceId';
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
): Promise<IDisposable> {
	const host = readWebWorkbenchHost();
	const workbench = new DisposableStore();
	workbench.add(hostLifetime);
	try {
		const configurationApi = workbench.add(new IndexedDbConfigurationApi());
		const initialConfigurationSnapshot = await configurationApi.read();
		const picker = window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> };
		const browserFileSystemProvider = !host && picker.showDirectoryPicker && globalThis.indexedDB
			? new HTMLFileSystemProvider(globalThis.indexedDB)
			: undefined;
		const instance = createWebWorkbench(modeId, {
			api: host?.api ?? createDisconnectedRendererApi(),
			configurationApi,
			initialConfigurationSnapshot,
			webWorkspaceClient: host?.webWorkspaceClient,
			browserFileSystemProvider,
			defaultLayout: host?.defaultLayout,
			workspace: host?.workspace,
			container: host?.container ??
				document.querySelector<HTMLElement>("#app") ??
				document.body,
			switchWorkbenchMode: host?.switchWorkbenchMode,
		});
		workbench.add(instance);
		workbench.add(addDisposableListener(window, "pagehide", () => {
			void instance.shutdown("pageHide").catch(error => console.error("Failed to shut down Workbench", error)).finally(() => workbench.dispose());
		}, { once: true }));
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
