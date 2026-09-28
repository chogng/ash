import { WorkbenchModeRegistry, type WorkbenchModeId } from "../common/workbenchMode.js";
import type { RendererCapabilityContribution } from "../../platform/app-server/browser/webRendererApi.js";
import { BrowserClipboardService } from "../../platform/clipboard/browser/browserClipboardService.js";
import { startWebWorkbench } from "./web.factory.js";
import { showStartupError } from "./startupError.js";
import type { IDisposable } from "../../base/common/lifecycle.js";
import { connectBrowserWorkbenchHost } from './web.host.js';

/** Starts a Workbench mode after resolving its optional development host. */
export function startBrowserWorkbench(modeId: WorkbenchModeId, rendererCapabilities: readonly RendererCapabilityContribution[] = []): void {
	document.title = WorkbenchModeRegistry.get(modeId).title;
	void startBrowserWorkbenchAsync(modeId, rendererCapabilities);
}

async function startBrowserWorkbenchAsync(modeId: WorkbenchModeId, rendererCapabilities: readonly RendererCapabilityContribution[]): Promise<void> {
	let connectedHost: IDisposable | undefined;
	try {
		connectedHost = await connectBrowserWorkbenchHost(rendererCapabilities);
		startWebWorkbench(modeId, connectedHost);
	} catch (error) {
		connectedHost?.dispose();
		showStartupError(error, text => new BrowserClipboardService(window.navigator.clipboard).writeText(text));
	}
}
