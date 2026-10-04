import { IndexedDBFileSystemProvider } from '../../platform/files/browser/indexedDBFileSystemProvider.js';
import { Schemas } from '../../base/common/network.js';
import { AppServerProtocolClient } from '../../platform/app-server/browser/appServerProtocolClient.js';
import { AppServerTextDocumentHost } from '../../workbench/services/textfile/browser/appServerTextDocumentHost.js';
import { IChatEditingService } from '../../workbench/contrib/chat/common/editing/chatEditingService.js';
import { HTMLFileSystemProvider } from '../../platform/files/browser/htmlFileSystemProvider.js';
import { IFileService } from '../../platform/files/common/files.js';
import { IDialogService } from '../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../platform/workspace/common/workspace.js';
import { FileDialogService } from '../../workbench/services/dialogs/browser/fileDialogService.js';
import './parts/menubar.contribution.js';
import '../sessions.common.main.js';
import { installBaseUiStyles } from "../../base/browser/ui/styles.js";
import { addDisposableListener } from "../../base/browser/dom.js";
import { onUnexpectedError } from "../../base/common/errors.js";
import { DisposableStore, type IDisposable } from "../../base/common/lifecycle.js";
import { createDisconnectedRendererApi } from "../../platform/app-server/browser/rendererApi.js";
import { IndexedDbConfigurationApi } from '../../platform/configuration/browser/indexedDbConfigurationApi.js';
import { BrowserLifecycleService } from '../../workbench/services/lifecycle/browser/lifecycleService.js';
import { BrowserHostColorSchemeService } from '../../workbench/services/themes/browser/browserHostColorSchemeService.js';
import { createBrowserContextMenuService } from "../../platform/contextview/browser/contextMenuService.js";
import { BrowserClipboardService } from '../../platform/clipboard/browser/clipboardService.js';
import { connectBrowserWorkbenchHost } from '../../workbench/browser/web.host.js';
import { workspaceFromIdentifier } from '../../platform/workspace/common/workspace.js';
import { showStartupError } from '../../workbench/browser/startupError.js';
import type { WorkbenchModeId } from "../../workbench/common/workbenchMode.js";
import type { SessionsProfile } from "../common/sessionsProfile.js";
import { Workbench } from "./workbench.js";
import { BrowserStorageService } from '../../workbench/services/storage/browser/storageService.js';
import { LogService } from '../../platform/log/common/logServiceImpl.js';
import { ConsoleLogSink } from '../../platform/log/common/consoleLogSink.js';
import { selectionFromWorkspace } from './workspaceSelection.js';
import { IHostService } from '../../workbench/services/host/browser/host.js';
import { BrowserHostService } from '../../workbench/services/host/browser/browserHostService.js';
import { ILanguagePackStore } from '../../platform/languagePacks/common/languagePackStore.js';
import { BrowserLanguagePackStore } from '../../platform/languagePacks/browser/languagePackStore.js';
import { InstantiationType, registerSingleton } from '../../platform/instantiation/common/extensions.js';

registerSingleton(IHostService, BrowserHostService, InstantiationType.Delayed);
registerSingleton(ILanguagePackStore, BrowserLanguagePackStore, InstantiationType.Delayed);

/** Starts a browser-hosted Sessions page with the optional renderer host. */
export async function startBrowserSessions(modeId: WorkbenchModeId, profile: SessionsProfile): Promise<void> {
	let connectedHost: IDisposable | undefined;
	try {
		let documentClient: AppServerProtocolClient | undefined;
		connectedHost = await connectBrowserWorkbenchHost([client => { documentClient = client; return {}; }], true);
		await mountBrowserSessions(modeId, profile, connectedHost, documentClient);
	} catch (error) {
		connectedHost?.dispose();
		showStartupError(error, text => new BrowserClipboardService(window.navigator.clipboard).writeText(text));
	}
}

async function mountBrowserSessions(modeId: WorkbenchModeId, profile: SessionsProfile, connectedHost?: IDisposable, documentClient?: AppServerProtocolClient): Promise<void> {
	installBaseUiStyles();
	const sessions = new DisposableStore();
	try {
		const configurationApi = sessions.add(new IndexedDbConfigurationApi());
		const initialConfigurationSnapshot = await configurationApi.read();
		const host = globalThis.ashWebWorkbenchHost;
		const browserFiles = host?.webWorkspaceClient ? undefined : sessions.add(new HTMLFileSystemProvider(window.indexedDB));
		const container = host?.container ?? document.querySelector<HTMLElement>("#app");
		if (!container) throw new Error("Sessions renderer requires an #app container");
		const ownerWindow = container.ownerDocument.defaultView;
		if (!ownerWindow) throw new Error('Sessions renderer requires an owner window');
		const workbench = sessions.add(await Workbench.create({
			createTextDocumentHost: documentClient ? services => {
				const editing = services.get(IChatEditingService);
				return services.createInstance(AppServerTextDocumentHost, documentClient!, editing.applyEdits.bind(editing));
			} : undefined,
			contributionIds: ['chat.edits.editorOverlay', 'workbench.contrib.dataChannels'],
			modeId,
			createStorageService: async storageOptions => new BrowserStorageService(storageOptions),
			createLogService: () => new LogService({ sinks: [new ConsoleLogSink()] }),
			profile,
			api: host?.api ?? createDisconnectedRendererApi(),
			workspaceSelection: () => host?.workspace ? selectionFromWorkspace(workspaceFromIdentifier(host.workspace)) : { type: 'current' },
			workspace: () => host?.workspace ? workspaceFromIdentifier(host.workspace) : { id: 'sessions', folders: [] },
			createUserDataFileSystemProvider: () => IndexedDBFileSystemProvider.create(ownerWindow.indexedDB, Schemas.vscodeUserData),
			configurationApi,
			initialConfigurationSnapshot,
			browserFileSystemProvider: browserFiles,
			createFileDialogService: services => {
				const common = {
					quickInput: () => services.get(IQuickInputService),
					fileService: () => services.get(IFileService),
					workspaceRoot: () => services.get(IWorkspaceContextService).getWorkspace().folders[0]?.uri,
				};
				const dialogs = () => services.get(IDialogService);
				if (host?.webWorkspaceClient) {
					return new FileDialogService({ ...common, kind: 'server', client: host.webWorkspaceClient }, dialogs);
				}
				return new FileDialogService({ ...common, kind: 'local', provider: browserFiles!, pickDirectory: startIn => (ownerWindow as unknown as Window & { showDirectoryPicker: (options?: { startIn?: FileSystemDirectoryHandle }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker(startIn ? { startIn } : undefined) }, dialogs);
			},
			createLifecycleService: services => services.createInstance(BrowserLifecycleService, { ownerWindow, onError: onUnexpectedError }),
			returnToWorkbench: () => {
				const location = container.ownerDocument.location;
				location.assign(new URL(profile.workbenchRelativePath, location.href).href);
			},
			createContextMenuService: createBrowserContextMenuService,
			createHostColorSchemeService: () => new BrowserHostColorSchemeService(ownerWindow),
			container,
		}));
		sessions.add(addDisposableListener(window, "pagehide", () => {
			void workbench.shutdown("pageHide").catch(onUnexpectedError).finally(() => sessions.dispose());
		}, { once: true }));
		if (connectedHost) sessions.add(connectedHost);
		await workbench.whenRestored;
	} catch (error) {
		sessions.dispose();
		throw error;
	}
}
