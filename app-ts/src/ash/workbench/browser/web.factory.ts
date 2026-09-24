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
	UNKNOWN_EMPTY_WINDOW_WORKSPACE,
	workspaceFromIdentifier,
} from "../../platform/workspace/common/workspace.js";
import {
	createBrowserWorkbenchContextMenuService,
} from "./workbenchInteractionServices.js";
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

/** Creates a browser-hosted Workbench with the shared Web adapters. */
export function createWebWorkbench(
	modeId: WorkbenchModeId,
	options: IWebWorkbenchConstructionOptions,
): IWebWorkbench {
	installBaseUiStyles();
	return startWorkbench({
		modeId,
		defaultLayout: options.defaultLayout,
		api: options.api,
		container: options.container,
		workspace: workspaceFromIdentifier(options.workspace ?? UNKNOWN_EMPTY_WINDOW_WORKSPACE),
		createContextMenuService: createBrowserWorkbenchContextMenuService,
		createTitlebarPart: createBrowserTitlebarPart,
		switchWorkbenchMode: options.switchWorkbenchMode ?? (targetModeId => switchBrowserWorkbenchMode(window, targetModeId)),
	});
}

/**
 * Starts a Workbench mode from the optional global Web host and owns page
 * shutdown. A page without an embedder starts in an explicit disconnected
 * state so its UI remains inspectable without claiming backend availability.
 */
export function startWebWorkbench(
	modeId: WorkbenchModeId,
	hostLifetime?: IDisposable,
): IDisposable {
	const host = readWebWorkbenchHost();
	const workbench = new DisposableStore();
	workbench.add(hostLifetime);
	const instance = createWebWorkbench(modeId, {
		api: host?.api ?? createDisconnectedRendererApi(),
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
