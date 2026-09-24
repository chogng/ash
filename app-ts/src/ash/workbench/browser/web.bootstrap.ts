import { URI } from "../../base/common/uri.js";
import { WorkbenchModeRegistry, type WorkbenchModeId } from "../common/workbenchMode.js";
import { connectWebRendererApi, type RendererCapabilityContribution } from "../../platform/app-server/browser/webRendererApi.js";
import { authenticateWebAppServer, type AppServerWebSocketTransport } from '../../platform/app-server/browser/appServerWebSocketTransport.js';
import { BrowserClipboardService } from "../../platform/clipboard/browser/browserClipboardService.js";
import { BrowserOpenerService } from "../../platform/opener/browser/browserOpenerService.js";
import { startWebWorkbench } from "./web.factory.js";
import { showStartupError } from "./startupError.js";
import { toDisposable, type IDisposable } from "../../base/common/lifecycle.js";
import { addDisposableListener } from '../../base/browser/dom.js';

declare const __ASH_WEB_APP_SERVER__: boolean;

/** Starts a Workbench mode after resolving its optional development host. */
export function startBrowserWorkbench(modeId: WorkbenchModeId, rendererCapabilities: readonly RendererCapabilityContribution[] = []): void {
	document.title = WorkbenchModeRegistry.get(modeId).title;
	void startBrowserWorkbenchAsync(modeId, rendererCapabilities);
}

async function startBrowserWorkbenchAsync(modeId: WorkbenchModeId, rendererCapabilities: readonly RendererCapabilityContribution[]): Promise<void> {
	if (globalThis.ashWebWorkbenchHost !== undefined || !__ASH_WEB_APP_SERVER__) {
		startWebWorkbench(modeId);
		return;
	}
	let transport: AppServerWebSocketTransport | undefined;
	let connectedHost: IDisposable | undefined;
	try {
		const parameters = new URLSearchParams(window.location.hash.slice(1));
		const endpoint = new URL(parameters.get('ash-endpoint') ?? sessionStorage.getItem('ash.appServer.endpoint') ?? window.location.origin);
		const ticket = parameters.get('ash-ticket');
		if (ticket) { history.replaceState(history.state, '', window.location.pathname + window.location.search); }
		transport = await authenticateWebAppServer(endpoint, sessionStorage, ticket);
		const connected = await connectWebRendererApi(transport, {
			openerService: new BrowserOpenerService(window),
			clipboardService: new BrowserClipboardService(window.navigator.clipboard),
		}, {}, rendererCapabilities);
		globalThis.ashWebWorkbenchHost = {
			api: connected.api,
			workspace: Object.freeze({
				id: connected.metadata.workspaceId,
				uri: URI.file(connected.metadata.workspaceRoot),
			}),
		};
		const authenticationLink = addDisposableListener(window, 'hashchange', () => {
			const parameters = new URLSearchParams(window.location.hash.slice(1));
			if (parameters.has('ash-ticket') && parameters.has('ash-endpoint')) {
				window.location.reload();
			}
		});
		connectedHost = toDisposable(() => { authenticationLink.dispose(); connected.dispose(); transport?.dispose(); });
	} catch (error) {
		transport?.dispose();
		showStartupError(error);
		return;
	}
	try {
		startWebWorkbench(modeId, connectedHost);
	} catch (error) {
		connectedHost?.dispose();
		showStartupError(error);
	}
}
