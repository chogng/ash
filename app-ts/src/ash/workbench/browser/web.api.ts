import type { IDisposable } from "../../base/common/lifecycle.js";
import type { IRendererHost } from "../../platform/renderer/common/rendererHost.js";
import type { ShutdownReason } from "../../platform/lifecycle/common/lifecycleService.js";
import type {
	IAnyWorkspaceIdentifier,
} from "../../platform/workspace/common/workspace.js";
import type { WorkbenchModeId } from "../common/workbenchMode.js";
import type { WorkbenchDefaultLayout } from "./layout.js";

/**
 * Capabilities and identity supplied by an embedding Web application.
 *
 * The embedder owns transport authentication and must provide an API that
 * obeys the same renderer contract as the Electron preload bridge.
 */
export interface IWebWorkbenchHost {
	readonly api: IRendererHost;
	readonly workspace?: IAnyWorkspaceIdentifier;
	readonly container?: HTMLElement | null;
	readonly defaultLayout?: WorkbenchDefaultLayout;
	readonly switchWorkbenchMode?: (modeId: WorkbenchModeId) => Promise<void>;
}

/** Inputs used to create one browser-hosted Workbench instance. */
export interface IWebWorkbenchConstructionOptions {
	readonly api: IRendererHost;
	readonly workspace?: IAnyWorkspaceIdentifier;
	readonly container: HTMLElement;
	readonly defaultLayout?: WorkbenchDefaultLayout;
	readonly switchWorkbenchMode?: (modeId: WorkbenchModeId) => Promise<void>;
}

/** Lifecycle facade returned to a Web Workbench embedder. */
export interface IWebWorkbench extends IDisposable {
	shutdown(reason: ShutdownReason): Promise<void>;
}

declare global {
	/**
	 * Optional host capabilities installed before the shared Workbench entry is imported.
	 */
	var ashWebWorkbenchHost: IWebWorkbenchHost | undefined;
}
