import { installBaseUiStyles } from "../../base/browser/ui/styles.js";
import { addDisposableListener } from "../../base/browser/dom.js";
import {
	DisposableStore,
	DisposableTracker,
	installDisposableTracker,
	toDisposable,
} from "../../base/common/lifecycle.js";
import { WorkbenchModeRegistry, type WorkbenchModeId } from "../common/workbenchMode.js";
import {
	createElectronRendererApi,
} from "../../platform/native/electron-browser/rendererApi.js";
import {
	parseWorkspace,
} from "../../platform/workspace/common/workspace.js";
import { type Workbench, startWorkbench } from "../browser/workbench.js";
import { showStartupError } from "../browser/startupError.js";
import {
	createElectronTitlebarPartFactory,
} from "./parts/titlebar/titlebarPart.js";
import {
	createElectronWorkbenchContextMenuService,
} from "../services/contextmenu/electron-browser/contextMenuService.js";
import { URI } from "../../base/common/uri.js";
import { ServiceContainer } from "../../platform/instantiation/common/instantiation.js";
import { IFileService } from "../../platform/files/common/files.js";
import { loadUserThemes } from "../services/themes/browser/workbenchThemeService.js";
import { type ElectronRendererCapabilityContribution } from "../../platform/native/electron-browser/rendererApi.js";
import { switchElectronWorkbenchMode } from "../services/workbenchMode/electron-browser/electronWorkbenchModeHost.js";

/** Starts one Electron renderer for the selected Workbench mode. */
export async function startElectronWorkbench(
	modeId: WorkbenchModeId,
	rendererCapabilities: readonly ElectronRendererCapabilityContribution[] = [],
): Promise<void> {
	document.title = WorkbenchModeRegistry.get(modeId).title;
	installBaseUiStyles();
	const disposableTracker = import.meta.env.DEV
		? new DisposableTracker()
		: undefined;
	const tracking = disposableTracker
		? installDisposableTracker(disposableTracker)
		: undefined;
	let api: Awaited<ReturnType<typeof createElectronRendererApi>>;
	try {
		api = await createElectronRendererApi(rendererCapabilities);
	} catch (error) {
		tracking?.[Symbol.dispose]();
		showStartupError(error);
		return;
	}
	const profileServices = new ServiceContainer();
	profileServices.registerInstance(IFileService, api.localFiles);
	const userThemes = await loadUserThemes(profileServices, URI.parse(api.userDataHome.toString().replace(/\/$/u, "") + "/themes"));
	const workbench = startWorkbench({
		modeId,
		api,
		browserViewApi: api.browserView,
		container: document.querySelector<HTMLElement>("#app") ?? document.body,
		workspace: parseWorkspace(await api.workspace.getWorkspace()),
		configurationApi: api.configuration,
		keybindingsResourceApi: api.keybindings,
		keyboardLayoutProvider: api.keyboardLayout,
		userKeyboardLayoutApi: api.userKeyboardLayout,
		nativeHostApi: api.nativeHost,
		userThemeService: userThemes,
		createContextMenuService: (options) =>
			createElectronWorkbenchContextMenuService(
				options,
				api.nativeContextMenu,
			),
		createTitlebarPart: createElectronTitlebarPartFactory(
			api.nativeMenubar,
		),
		switchWorkbenchMode: switchElectronWorkbenchMode,
	});
	const lifecycle = new DisposableStore();
	lifecycle.add(api);
	lifecycle.add(profileServices);
	const workspaceSubscription = api.workspace.onDidChange((workspace) => {
		void applyWorkspaceChange(workbench, workspace);
	});
	lifecycle.add(toDisposable(() => workspaceSubscription.dispose()));
	lifecycle.add(addDisposableListener(window, "pagehide", () => {
		void workbench.shutdown("pageHide").catch(error => console.error("Failed to shut down Workbench", error)).finally(() => {
			try {
				workbench.dispose();
				lifecycle.dispose();
				userThemes.dispose();
				disposableTracker?.assertNoLeaks();
			} finally {
				tracking?.[Symbol.dispose]();
			}
		});
	}, { once: true }));
}

async function applyWorkspaceChange(workbench: Workbench, workspace: unknown): Promise<void> {
	try {
		await workbench.updateWorkspace(parseWorkspace(workspace));
	} catch (error) {
		console.error("Failed to switch Workbench workspace", error);
		window.location.reload();
	}
}
