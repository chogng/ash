import { installBaseUiStyles } from "../../base/browser/ui/styles.js";
import { addDisposableListener } from "../../base/browser/dom.js";
import { onUnexpectedError } from "../../base/common/errors.js";
import { DisposableStore, type IDisposable } from "../../base/common/lifecycle.js";
import { createDisconnectedRendererApi } from "../../platform/app-server/browser/rendererApi.js";
import { navigateToDedicatedWindowPage } from "../../platform/windows/browser/dedicatedWindowNavigation.js";
import { createBrowserWorkbenchContextMenuService } from "../../workbench/browser/workbenchInteractionServices.js";
import type { WorkbenchModeId } from "../../workbench/common/workbenchMode.js";
import type { SessionsProfile } from "../common/sessionsProfile.js";
import { Workbench } from "./workbench.js";

/** Starts a browser-hosted Sessions page with the optional renderer host. */
export function startBrowserSessions(modeId: WorkbenchModeId, profile: SessionsProfile): IDisposable {
	installBaseUiStyles();
	const sessions = new DisposableStore();
	const host = globalThis.ashWebWorkbenchHost;
	const container = host?.container ?? document.querySelector<HTMLElement>("#app");
	if (!container) throw new Error("Sessions renderer requires an #app container");
	const workbench = sessions.add(new Workbench({
		modeId,
		profile,
		api: host?.api ?? createDisconnectedRendererApi(),
		returnToWorkbench: () => navigateToDedicatedWindowPage(profile.workbenchRelativePath, container.ownerDocument.location),
		createContextMenuService: createBrowserWorkbenchContextMenuService,
		container,
	}));
	sessions.add(addDisposableListener(window, "pagehide", () => {
		void workbench.shutdown("pageHide").catch(onUnexpectedError).finally(() => sessions.dispose());
	}, { once: true }));
	return sessions;
}
