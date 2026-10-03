import { AppServerProtocolClient } from '../../platform/app-server/browser/appServerProtocolClient.js';
import { AppServerTextDocumentHost } from '../services/textfile/browser/appServerTextDocumentHost.js';
import { IChatEditingService } from '../contrib/chat/common/editing/chatEditingService.js';
import { WorkbenchModeId } from "../common/workbenchMode.js";
import type { RendererCapabilityContribution } from "../../platform/app-server/browser/webRendererApi.js";
import { BrowserClipboardService } from "../../platform/clipboard/browser/clipboardService.js";
import { startWebWorkbench } from "./web.factory.js";
import { showStartupError } from "./startupError.js";
import type { IDisposable } from "../../base/common/lifecycle.js";
import { connectBrowserWorkbenchHost } from './web.host.js';

/** Starts a Workbench mode after resolving its optional development host. */
export async function startBrowserWorkbench(modeId: WorkbenchModeId, rendererCapabilities: readonly RendererCapabilityContribution[] = []): Promise<void> {
	let connectedHost: IDisposable | undefined;
	try {
		let documentClient: AppServerProtocolClient | undefined;
		connectedHost = await connectBrowserWorkbenchHost([...rendererCapabilities, client => { documentClient = client; return {}; }], modeId === WorkbenchModeId.Code);
		await startWebWorkbench(modeId, connectedHost, documentClient && modeId === WorkbenchModeId.Code ? services => {
			const editing = services.get(IChatEditingService);
			return services.createInstance(AppServerTextDocumentHost, documentClient!, { applyEdits: editing.applyEdits.bind(editing), finishTurn: editing.finishTurn.bind(editing) });
		} : undefined);
	} catch (error) {
		connectedHost?.dispose();
		showStartupError(error, text => new BrowserClipboardService(window.navigator.clipboard).writeText(text));
	}
}
