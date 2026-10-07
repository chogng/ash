import { addDisposableListener, windowOpenNoOpener } from '../../base/browser/dom.js';
import { toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import { URI } from '../../base/common/uri.js';
import { authenticateWebAppServer, type AppServerWebSocketTransport } from '../../platform/app-server/browser/appServerWebSocketTransport.js';
import { connectWebRendererApi, type RendererCapabilityContribution } from '../../platform/app-server/browser/webRendererApi.js';
import { BrowserClipboardService } from '../../platform/clipboard/browser/clipboardService.js';
import { normalizeExternalUrl } from '../../platform/opener/common/opener.js';
import { AppServerWebWorkspaceClient } from '../services/workspaces/browser/appServerWebWorkspaceClient.js';

declare const __ASH_WEB_APP_SERVER__: boolean;

/** Connects a browser page to its App Server workspace before building either Workbench. */
export async function connectBrowserWorkbenchHost(rendererCapabilities: readonly RendererCapabilityContribution[] = [], textDocuments = false, appTools = false): Promise<IDisposable | undefined> {
	if (globalThis.ashWebWorkbenchHost !== undefined || !__ASH_WEB_APP_SERVER__) return undefined;
	let transport: AppServerWebSocketTransport | undefined;
	try {
		const parameters = new URLSearchParams(window.location.hash.slice(1));
		const endpoint = new URL(parameters.get('ash-endpoint') ?? sessionStorage.getItem('ash.appServer.endpoint') ?? window.location.origin);
		const ticket = parameters.get('ash-ticket');
		if (ticket) { history.replaceState(history.state, '', window.location.pathname + window.location.search); }
		transport = await authenticateWebAppServer(endpoint, sessionStorage, ticket);
		const connected = await connectWebRendererApi(transport, {
			externalOpener: {
				openExternal: async href => {
					windowOpenNoOpener(normalizeExternalUrl(href));
					return true;
				},
			},
			clipboardService: new BrowserClipboardService(window.navigator.clipboard),
		}, { capabilities: { ...(textDocuments ? { textDocuments: { version: 2 } } : {}), ...(appTools ? { appTools: { version: 1, agents: true, desktop: false } } : {}) } }, rendererCapabilities);
		globalThis.ashWebWorkbenchHost = {
			api: connected.api,
			webWorkspaceClient: new AppServerWebWorkspaceClient(endpoint, transport.sessionToken, window),
			workspace: Object.freeze({
				id: connected.metadata.workspaceId,
				uri: URI.file(connected.metadata.workspaceRoot),
			}),
		};
		const authenticationLink = addDisposableListener(window, 'hashchange', () => {
			const parameters = new URLSearchParams(window.location.hash.slice(1));
			if (parameters.has('ash-ticket') && parameters.has('ash-endpoint')) window.location.reload();
		});
		return toDisposable(() => { authenticationLink.dispose(); connected.dispose(); transport?.dispose(); });
	} catch (error) {
		transport?.dispose();
		throw error;
	}
}
