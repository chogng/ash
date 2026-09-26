import { addDisposableListener } from '../../base/browser/dom.js';
import { installBaseUiStyles } from '../../base/browser/ui/styles.js';
import { Disposable, DisposableTracker, installDisposableTracker, toDisposable } from '../../base/common/lifecycle.js';
import { URI } from '../../base/common/uri.js';
import { IFileService } from '../../platform/files/common/files.js';
import { ServiceContainer } from '../../platform/instantiation/common/instantiation.js';
import { createElectronRendererApi, type ElectronRendererCapabilityContribution } from '../../platform/native/electron-browser/rendererApi.js';
import { registerWindowCloseHandler } from '../../platform/windows/electron-browser/windowClose.js';
import { parseWorkspace } from '../../platform/workspace/common/workspace.js';
import { showStartupError } from '../browser/startupError.js';
import { startWorkbench, type Workbench } from '../browser/workbench.js';
import { WorkbenchModeRegistry, type WorkbenchModeId } from '../common/workbenchMode.js';
import { createElectronWorkbenchContextMenuService } from '../services/contextmenu/electron-browser/contextMenuService.js';
import { loadUserThemes } from '../services/themes/browser/workbenchThemeService.js';
import { switchElectronWorkbenchMode } from '../services/workbenchMode/electron-browser/electronWorkbenchModeHost.js';
import { createElectronTitlebarPartFactory } from './parts/titlebar/titlebarPart.js';
import { NativeDialogHandler } from './parts/dialogs/dialogHandler.js';
import { DirectoryPermissionDialog } from './parts/dialogs/directoryPermissionDialog.js';

/** Owns desktop startup and the resources of one renderer window. */
export class DesktopMain extends Disposable {
	private opened = false;

	constructor(private readonly modeId: WorkbenchModeId, private readonly rendererCapabilities: readonly ElectronRendererCapabilityContribution[]) {
		super();
	}

	public async open(): Promise<void> {
		this.assertNotDisposed();
		if (this.opened) {
			throw new Error('Desktop startup has already begun');
		}
		this.opened = true;
		document.title = WorkbenchModeRegistry.get(this.modeId).title;
		installBaseUiStyles();
		const tracker = import.meta.env.DEV ? new DisposableTracker() : undefined;
		const tracking = tracker ? installDisposableTracker(tracker) : undefined;
		try {
			const container = document.querySelector<HTMLElement>('#app') ?? document.body;
			const permissionDialog = this._register(new DirectoryPermissionDialog(container));
			const api = this._register(await createElectronRendererApi(this.rendererCapabilities, { browser: true }, path => permissionDialog.select(path)));
			const profileServices = this._register(new ServiceContainer());
			profileServices.registerInstance(IFileService, api.localFiles);
			const userThemes = this._register(await loadUserThemes(profileServices, URI.parse(api.userDataHome.toString().replace(/\/$/u, '') + '/themes')));
			const workbench = this._register(startWorkbench({
				modeId: this.modeId,
				api,
				browserViewApi: api.browserView,
				container,
				workspace: parseWorkspace(await api.workspace.getWorkspace()),
				configurationApi: api.configuration,
				keybindingsResourceApi: api.keybindings,
				keyboardLayoutProvider: api.keyboardLayout,
				userKeyboardLayoutApi: api.userKeyboardLayout,
				nativeHostApi: api.nativeHost,
				dialogHandler: new NativeDialogHandler(api.nativeHost, container),
				userThemeService: userThemes,
				createContextMenuService: options => createElectronWorkbenchContextMenuService(options, api.nativeContextMenu),
				createTitlebarPart: createElectronTitlebarPartFactory(api.nativeMenubar),
				switchWorkbenchMode: switchElectronWorkbenchMode,
			}));
			const subscription = api.workspace.onDidChange(workspace => {
				void this.updateWorkspace(workbench, workspace);
			});
			this._register(toDisposable(() => subscription.dispose()));
			this._register(addDisposableListener(window, 'pagehide', () => {
				void workbench.shutdown('pageHide').catch(error => console.error('Failed to shut down Workbench', error)).finally(() => {
					try {
						this.dispose();
						tracker?.assertNoLeaks();
					} finally {
						tracking?.[Symbol.dispose]();
					}
				});
			}, { once: true }));
			this._register(await registerWindowCloseHandler(() => workbench.shutdown('windowClose')));
		} catch (error) {
			try {
				this.dispose();
			} finally {
				tracking?.[Symbol.dispose]();
			}
			showStartupError(error);
		}
	}

	private async updateWorkspace(workbench: Workbench, workspace: unknown): Promise<void> {
		try {
			await workbench.updateWorkspace(parseWorkspace(workspace));
		} catch (error) {
			if (this.isDisposed) {
				return;
			}
			console.error('Failed to switch Workbench workspace', error);
			window.location.reload();
		}
	}
}

export function main(modeId: WorkbenchModeId, rendererCapabilities: readonly ElectronRendererCapabilityContribution[] = []): Promise<void> {
	return new DesktopMain(modeId, rendererCapabilities).open();
}
