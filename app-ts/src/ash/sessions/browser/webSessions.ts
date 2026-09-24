import { installBaseUiStyles } from "../../base/browser/ui/styles.js";
import { addDisposableListener } from "../../base/browser/dom.js";
import { DisposableStore, type IDisposable } from "../../base/common/lifecycle.js";
import type { WorkbenchModeId } from "../../workbench/common/workbenchMode.js";
import { createDisconnectedRendererApi } from "../../platform/app-server/browser/rendererApi.js";
import { createBrowserWorkbenchContextMenuService } from "../../workbench/browser/workbenchInteractionServices.js";
import type { SessionsProfile } from "../common/sessionsProfile.js";
import { startSessionsWorkbench } from "./sessionsWorkbench.js";

/** Starts a browser-hosted Sessions page with the optional renderer host. */
export function startBrowserSessions(modeId: WorkbenchModeId, profile: SessionsProfile): IDisposable {
	installBaseUiStyles();
	const sessions = new DisposableStore();
	const host = globalThis.ashWebWorkbenchHost;
	const container = host?.container ?? document.querySelector<HTMLElement>("#app");
	if (!container) throw new Error("Sessions renderer requires an #app container");
	sessions.add(startSessionsWorkbench({
		modeId,
		profile,
		api: host?.api ?? createDisconnectedRendererApi(),
		createContextMenuService: createBrowserWorkbenchContextMenuService,
		container,
	}));
	sessions.add(addDisposableListener(window, "pagehide", () => sessions.dispose(), { once: true }));
	return sessions;
}
