import { AppServerProtocolClient } from '../../platform/app-server/browser/appServerProtocolClient.js';
import { AppServerTextDocumentHost } from '../services/textfile/browser/appServerTextDocumentHost.js';
import { IChatEditingService } from '../contrib/chat/common/editing/chatEditingService.js';
import { addDisposableListener } from '../../base/browser/dom.js';
import { installBaseUiStyles } from '../../base/browser/ui/styles.js';
import { Disposable, DisposableTracker, installDisposableTracker, toDisposable } from '../../base/common/lifecycle.js';
import { onUnexpectedError } from '../../base/common/errors.js';
import { URI } from '../../base/common/uri.js';
import { IFileService } from '../../platform/files/common/files.js';
import { ElectronRendererClipboardService } from '../../platform/clipboard/electron-browser/electronRendererClipboardService.js';
import { validateConfigurationSnapshot } from '../../platform/configuration/common/configurationIpc.js';
import { invoke, subscribe } from '../../platform/ipc/electron-browser/rendererIpc.js';
import { InstantiationService } from '../../platform/instantiation/common/instantiationService.js';
import { IMainProcessService } from '../../platform/ipc/common/mainProcessService.js';
import { ElectronIPCMainProcessService } from '../../platform/ipc/electron-browser/mainProcessService.js';
import { createElectronRendererApi, type ElectronRendererCapabilityContribution } from '../../platform/native/electron-browser/rendererApi.js';
import { parseWorkspace } from '../../platform/workspace/common/workspace.js';
import { showStartupError } from '../browser/startupError.js';
import { NativeHostColorSchemeService } from '../services/themes/electron-browser/nativeHostColorSchemeService.js';
import { startWorkbench, type Workbench } from '../browser/workbench.js';
import { WorkbenchModeId } from '../common/workbenchMode.js';
import { createElectronWorkbenchContextMenuService } from '../services/contextmenu/electron-browser/contextMenuService.js';
import { loadUserThemes } from '../services/themes/browser/workbenchThemeService.js';
import { switchElectronWorkbenchMode } from '../services/workbenchMode/electron-browser/electronWorkbenchModeHost.js';
import { ElectronLifecycleService } from '../services/lifecycle/electron-browser/lifecycleService.js';
import { createElectronTitlebarPartFactory } from './parts/titlebar/titlebarPart.js';
import { NativeDialogHandler } from './parts/dialogs/dialogHandler.js';
import { DirectoryPermissionDialog } from './parts/dialogs/directoryPermissionDialog.js';
import { ElectronWindow } from './window.js';
import { registerLocalTranscriptionService } from '../services/localTranscription/electron-browser/localTranscriptionService.js';
import { NativeWorkbenchStorageService } from '../services/storage/electron-browser/storageService.js';
import { LoggerChannelClient } from '../../platform/log/common/logIpc.js';

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
		installBaseUiStyles();
		const tracker = import.meta.env.DEV ? new DisposableTracker() : undefined;
		const tracking = tracker ? installDisposableTracker(tracker) : undefined;
		try {
			const container = document.querySelector<HTMLElement>('#app') ?? document.body;
			const permissionDialog = this._register(new DirectoryPermissionDialog(container));
			const transcriptionServices = this._register(new InstantiationService());
			const profileServices = this._register(new InstantiationService());
			const windowId = await invoke<unknown>('ash:ipc:window-id');
			if (!Number.isSafeInteger(windowId) || (windowId as number) <= 0) { throw new TypeError('Invalid Main IPC window ID'); }
			const mainProcessService = this._register(profileServices.createInstance(ElectronIPCMainProcessService, windowId as number));
			profileServices.registerInstance(IMainProcessService, mainProcessService);
			await mainProcessService.connect();
			const logger = profileServices.createInstance(LoggerChannelClient);
			let documentClient: AppServerProtocolClient | undefined;
			const api = this._register(await createElectronRendererApi([
				client => { documentClient = client; return {}; },
				...this.rendererCapabilities,
				client => registerLocalTranscriptionService(transcriptionServices, client),
			], { browser: true, textDocuments: this.modeId === WorkbenchModeId.Code }, permissionDialog, mainProcessService));
			profileServices.registerInstance(IFileService, api.localFiles);
			const userThemes = this._register(await loadUserThemes(profileServices, URI.parse(api.userDataHome.toString().replace(/\/$/u, '') + '/themes')));
			const workspace = parseWorkspace(await api.workspace.getWorkspace());
			const initialConfigurationSnapshot = validateConfigurationSnapshot(await api.configuration.read());
			let lifecycleService!: ElectronLifecycleService;
			let desktopWindow!: ElectronWindow;
			const hostColorScheme = await api.nativeHost.getOSColorScheme();
			const workbench = this._register(await startWorkbench({
				modeId: this.modeId,
				createTextDocumentHost: documentClient && this.modeId === WorkbenchModeId.Code ? services => {
					const editing = services.get(IChatEditingService);
					return services.createInstance(AppServerTextDocumentHost, documentClient!, editing.applyEdits.bind(editing));
				} : undefined,
				createLogService: () => logger.createLogger('workbench'),
				createStorageService: async options => {
					const storage = profileServices.createInstance(NativeWorkbenchStorageService, options);
					try { await storage.initialize(); return storage; }
					catch (error) { storage.dispose(); throw error; }
				},
				api,
				browserViewApi: api.browserView,
				container,
				workspace,
				createLifecycleService: services => {
					lifecycleService = services.createInstance(ElectronLifecycleService, { ownerWindow: window, onError: onUnexpectedError });
					this._register(lifecycleService.onWillShutdown(event => event.join(logger.flush(), 'Desktop logs flush')));
					return lifecycleService;
				},
				createWindow: services => desktopWindow = services.createInstance(ElectronWindow, { invoke, subscribe }),
				configurationApi: api.configuration,
				initialConfigurationSnapshot,
				keybindingsResourceApi: api.keybindings,
				keyboardLayoutProvider: api.keyboardLayout,
				userKeyboardLayoutApi: api.userKeyboardLayout,
				nativeHostApi: api.nativeHost,
				createHostColorSchemeService: services => {
					const colors = services.createInstance(NativeHostColorSchemeService, hostColorScheme);
					void colors.initialize().catch(onUnexpectedError);
					return colors;
				},
				clipboardService: new ElectronRendererClipboardService(),
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
			await lifecycleService.initialize();
			await workbench.whenRestored;
			await desktopWindow.initialize();
		} catch (error) {
			try {
				this.dispose();
			} finally {
				tracking?.[Symbol.dispose]();
			}
			showStartupError(error, text => invoke<void>('ash:host:writeClipboard', text));
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
