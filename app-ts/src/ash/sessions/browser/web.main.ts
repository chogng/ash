import { installBaseUiStyles } from "../../base/browser/ui/styles.js";
import { addDisposableListener } from "../../base/browser/dom.js";
import { onUnexpectedError } from "../../base/common/errors.js";
import { DisposableStore, type IDisposable } from "../../base/common/lifecycle.js";
import { createDisconnectedRendererApi } from "../../platform/app-server/browser/rendererApi.js";
import { BrowserLifecycleService } from '../../workbench/services/lifecycle/browser/lifecycleService.js';
import { createBrowserContextMenuService } from "../../platform/contextview/browser/contextMenuService.js";
import { BrowserClipboardService } from '../../platform/clipboard/browser/browserClipboardService.js';
import { connectBrowserWorkbenchHost } from '../../workbench/browser/web.host.js';
import { showStartupError } from '../../workbench/browser/startupError.js';
import type { WorkbenchModeId } from "../../workbench/common/workbenchMode.js";
import type { SessionsProfile } from "../common/sessionsProfile.js";
import { Workbench } from "./workbench.js";

/** Starts a browser-hosted Sessions page with the optional renderer host. */
export function startBrowserSessions(modeId: WorkbenchModeId, profile: SessionsProfile): void {
	void startBrowserSessionsAsync(modeId, profile);
}

async function startBrowserSessionsAsync(modeId: WorkbenchModeId, profile: SessionsProfile): Promise<void> {
	let connectedHost: IDisposable | undefined;
	try {
		connectedHost = await connectBrowserWorkbenchHost();
		mountBrowserSessions(modeId, profile, connectedHost);
	} catch (error) {
		connectedHost?.dispose();
		showStartupError(error, text => new BrowserClipboardService(window.navigator.clipboard).writeText(text));
	}
}

function mountBrowserSessions(modeId: WorkbenchModeId, profile: SessionsProfile, connectedHost?: IDisposable): void {
	installBaseUiStyles();
	const sessions = new DisposableStore();
	const host = globalThis.ashWebWorkbenchHost;
	const container = host?.container ?? document.querySelector<HTMLElement>("#app");
	if (!container) throw new Error("Sessions renderer requires an #app container");
	const ownerWindow = container.ownerDocument.defaultView;
	if (!ownerWindow) throw new Error('Sessions renderer requires an owner window');
	const workbench = sessions.add(new Workbench({
		modeId,
		profile,
		api: host?.api ?? createDisconnectedRendererApi(),
		lifecycleService: new BrowserLifecycleService({ ownerWindow, onError: onUnexpectedError }),
		returnToWorkbench: () => {
			const location = container.ownerDocument.location;
			location.assign(new URL(profile.workbenchRelativePath, location.href).href);
		},
		createContextMenuService: createBrowserContextMenuService,
		container,
	}));
	sessions.add(addDisposableListener(window, "pagehide", () => {
		void workbench.shutdown("pageHide").catch(onUnexpectedError).finally(() => sessions.dispose());
	}, { once: true }));
	if (connectedHost) sessions.add(connectedHost);
}
