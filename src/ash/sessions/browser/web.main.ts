import { AppToolsHost } from '../contrib/appTools/browser/appToolsHost.js';
import { AppServerAppToolsHost } from '../services/appTools/browser/appServerAppToolsHost.js';
import { IndexedDBFileSystemProvider } from '../../platform/files/browser/indexedDBFileSystemProvider.js';
import { Schemas } from '../../base/common/network.js';
import { AppServerProtocolClient } from '../../platform/agentHost/browser/appServerProtocolClient.js';
import { AppServerTextDocumentHost } from '../../workbench/services/textfile/browser/appServerTextDocumentHost.js';
import { IChatEditingService } from '../../workbench/contrib/chat/common/editing/chatEditingService.js';
import { HTMLFileSystemProvider } from '../../platform/files/browser/htmlFileSystemProvider.js';
import { IFileService } from '../../platform/files/common/files.js';
import { IDialogService } from '../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../platform/workspace/common/workspace.js';
import { FileDialogService } from '../../workbench/services/dialogs/browser/fileDialogService.js';
import { installBaseUiStyles } from "../../base/browser/ui/styles.js";
import { onUnexpectedError } from "../../base/common/errors.js";
import { Disposable } from "../../base/common/lifecycle.js";
import { createDisconnectedRendererApi } from "../../platform/agentHost/browser/rendererApi.js";
import { IndexedDbConfigurationApi } from '../../platform/configuration/browser/indexedDbConfigurationApi.js';
import { BrowserLifecycleService } from '../../workbench/services/lifecycle/browser/lifecycleService.js';
import { BrowserHostColorSchemeService } from '../../workbench/services/themes/browser/browserHostColorSchemeService.js';
import { BrowserContextMenuService } from "../../platform/contextview/browser/contextMenuService.js";
import { connectBrowserWorkbenchHost } from '../../workbench/browser/web.host.js';
import { workspaceFromIdentifier } from '../../platform/workspace/common/workspace.js';
import type { SessionsProfile } from "../common/sessionsProfile.js";
import type { Workbench } from './workbench.js';
import { createSessionsWorkbench } from './workbenchFactory.js';
import { TitlebarPart } from './parts/titlebar/titlebarPart.js';
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

/** Owns the browser services and Workbench created for one Sessions embedder. */
export class SessionsBrowserMain extends Disposable {
	constructor(private readonly container: HTMLElement, private readonly profile: SessionsProfile) {
		super();
	}

	public async open(): Promise<Workbench> {
		this.assertNotDisposed();
		const { container, profile } = this;
		try {
			let documentClient: AppServerProtocolClient | undefined;
			const connectedHost = await connectBrowserWorkbenchHost([client => { documentClient = client; return {}; }], true, true);
			if (connectedHost) { this._register(connectedHost); }
			installBaseUiStyles();
			const configurationApi = this._register(new IndexedDbConfigurationApi());
			const initialConfigurationSnapshot = await configurationApi.read();
			const host = globalThis.ashWebWorkbenchHost;
			const ownerWindow = container.ownerDocument.defaultView;
			if (!ownerWindow) throw new Error('Sessions renderer requires an owner window');
			const browserFiles = host?.webWorkspaceClient ? undefined : this._register(new HTMLFileSystemProvider(ownerWindow.indexedDB, ownerWindow));
			const workbench = this._register(await createSessionsWorkbench({
				createAppToolsHost: documentClient ? services => new AppServerAppToolsHost(documentClient!, services.createInstance(AppToolsHost, container.ownerDocument, undefined)) : undefined,
				createTextDocumentHost: documentClient ? services => {
					const editing = services.get(IChatEditingService);
					return services.createInstance(AppServerTextDocumentHost, documentClient!, editing.applyEdits.bind(editing));
				} : undefined,
				contributionIds: ['workbench.contrib.sessionsLayout', 'sessions.contrib.multiDiffSource', 'chat.edits.editorOverlay', 'workbench.contrib.dataChannels', 'workbench.contrib.githubLinkPresentations', 'workbench.contrib.chatAccessibilitySignals', 'workbench.contrib.voiceRecordingAccessibilitySignals', 'workbench.contrib.saveAccessibilitySignals'],
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
						return services.createInstance(FileDialogService, { ...common, kind: 'server', client: host.webWorkspaceClient }, dialogs);
					}
					return services.createInstance(FileDialogService, { ...common, kind: 'local', provider: browserFiles!, pickDirectory: (startIn?: FileSystemDirectoryHandle) => (ownerWindow as unknown as Window & { showDirectoryPicker: (options?: { startIn?: FileSystemDirectoryHandle; }) => Promise<FileSystemDirectoryHandle>; }).showDirectoryPicker(startIn ? { startIn } : undefined) }, dialogs);
				},
				createLifecycleService: services => services.createInstance(BrowserLifecycleService, { ownerWindow, onError: onUnexpectedError }),
				returnToWorkbench: () => {
					const location = container.ownerDocument.location;
					location.assign(new URL(profile.workbenchRelativePath, location.href).href);
				},
				createContextMenuService: services => services.createInstance(BrowserContextMenuService),
				createHostColorSchemeService: () => new BrowserHostColorSchemeService(ownerWindow),
				createTitlebarPart: (titlebarContainer, services) => services.createInstance(TitlebarPart, titlebarContainer, 'application-menu'),
				container,
			}));
			await workbench.whenRestored;
			return workbench;
		} catch (error) {
			this.dispose();
			throw error;
		}
	}
}
