import type { IURLCallbackProvider } from '../services/url/browser/urlService.js';
import type { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import type { IDisposable } from "../../base/common/lifecycle.js";
import type { IRendererHost } from "../../platform/renderer/common/rendererHost.js";
import type { ShutdownReason } from "../services/lifecycle/common/lifecycle.js";
import type {
	IAnyWorkspaceIdentifier,
} from "../../platform/workspace/common/workspace.js";
import type { WorkbenchDefaultLayout } from "./layout.js";
import type { HTMLFileSystemProvider } from '../../platform/files/browser/htmlFileSystemProvider.js';
import type { IWebWorkspaceClient } from '../services/workspaces/browser/workspaceOpenService.js';
import type { IConfigurationApi, IConfigurationSnapshot } from '../../platform/configuration/common/configurationIpc.js';

/**
 * Capabilities and identity supplied by an embedding Web application.
 *
 * The embedder owns transport authentication and must provide an API that
 * obeys the same renderer contract as the Electron preload bridge.
 */
export interface IWebWorkbenchHost {
	readonly api: IRendererHost;
	readonly urlCallbackProvider?: IURLCallbackProvider;
	readonly webWorkspaceClient?: IWebWorkspaceClient;
	readonly workspace?: IAnyWorkspaceIdentifier;
	readonly container?: HTMLElement | null;
	readonly defaultLayout?: WorkbenchDefaultLayout;
}

/** Inputs used to create one browser-hosted Workbench instance. */
export interface IWebWorkbenchConstructionOptions {
	readonly createTextDocumentHost?: (services: IInstantiationService) => IDisposable;
	readonly api: IRendererHost;
	readonly urlCallbackProvider?: IURLCallbackProvider;
	readonly configurationApi: IConfigurationApi;
	readonly initialConfigurationSnapshot: IConfigurationSnapshot;
	readonly webWorkspaceClient?: IWebWorkspaceClient;
	readonly browserFileSystemProvider?: HTMLFileSystemProvider;
	readonly workspace?: IAnyWorkspaceIdentifier;
	readonly container: HTMLElement;
	readonly defaultLayout?: WorkbenchDefaultLayout;
}

/** Lifecycle facade returned to a Web Workbench embedder. */
export interface IWebWorkbench extends IDisposable {
	/** Saved editors and dirty working copies are restored before startup completes. */
	readonly whenRestored: Promise<void>;
	shutdown(reason: ShutdownReason): Promise<void>;
}

declare global {
	/**
	 * Optional host capabilities installed before the shared Workbench entry is imported.
	 */
	var ashWebWorkbenchHost: IWebWorkbenchHost | undefined;
}
