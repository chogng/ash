import { ILanguageServerLifecycleService } from '../../../common/languageServerLifecycleService.js';
import { IPaneCompositePartService } from '../../../../panecomposite/browser/panecomposite.js';
import { IViewDescriptorService } from '../../../../../common/views.js';
import { IViewsService } from '../../../../views/common/viewsService.js';
import { ILanguageServerService } from '../../../../../../platform/language/common/languageServerService.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchKeybindingService } from '../../../../keybinding/browser/keybindingService.js';
import { BrowserKeyboardLayoutService } from '../../../../keybinding/browser/keyboardLayoutService.js';
import { ILayoutService, BrowserLayoutService } from '../../../../../../platform/layout/browser/layoutService.js';
import { IUserDataProfileService } from '../../../../userDataProfile/common/userDataProfile.js';
import { UserDataProfileService } from '../../../../userDataProfile/browser/userDataProfileService.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { CommandService } from '../../../../commands/common/commandService.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../../../../test/fixtures/browser/notificationFixture.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { addDisposableListener } from '../../../../../../base/browser/dom.js';
import { ILanguageFeaturesService } from '../../../../../../editor/common/services/languageFeatures.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';
import { StandaloneServices } from '../../../../../../editor/standalone/browser/standaloneServices.js';
import { IContextMenuService, IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IAccessibleViewService } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import * as stanza from '../../../../../../editor/editor.main.js';
import type { ServerNotification } from '../../../../../../../../.build/protocol/typescript/index.js';
import { createDisconnectedLanguageApi } from '../../../../../../platform/language/browser/languageApi.js';
import { TestWorkspaceService } from '../../../../configuration/test/common/testServices.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../../platform/workspace/common/workspaceTrust.js';
import { IServerEventApi } from '../../../../../../platform/agentHost/common/appServerApi.js';
import { AppServerLanguageProviders } from '../../../browser/appServerLanguageProviders.js';
import { AppServerLanguageServerStatusService } from '../../../browser/appServerLanguageServerStatusService.js';
import { ProgressService } from '../../../../progress/browser/progressService.js';
import { IProgressService } from '../../../../../../platform/progress/common/progress.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { DialogService } from '../../../../dialogs/common/dialogService.js';
import { IOutputService } from '../../../../output/common/output.js';
import { OutputService } from '../../../../../contrib/output/browser/outputServices.js';
import { IStatusbarService, StatusbarAlignment, type IStatusbarEntryAccessor } from '../../../../statusbar/browser/statusbar.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { StatusbarPart } from '../../../../../browser/parts/statusbar/statusbarPart.js';
import { createTestEditorServices, createTestFileService } from '../../../../../test/common/testEditorServices.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { bindTestColorTheme } from '../../../../../../../../test/fixtures/browser/themeFixture.js';

const store = new DisposableStore();
const changes = store.add(new Emitter<ServerNotification>());
const workspace = store.add(new TestWorkspaceService({ id: 'workspace', uri: stanza.URI.file('/project') }));
const statusServices = store.add(createTestEditorServices());
statusServices.registerInstance(IContextMenuService, StandaloneServices.get(IContextMenuService));
statusServices.registerInstance(IContextViewService, StandaloneServices.get(IContextViewService));
statusServices.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
statusServices.registerSingleton(ICommandService, () => new CommandService(statusServices));
statusServices.registerSingleton(INotificationService, () => new TestNotificationService());
statusServices.registerInstance(ILanguageFeaturesService, StandaloneServices.get(ILanguageFeaturesService));
statusServices.registerInstance(IModelService, StandaloneServices.get(IModelService));
statusServices.registerSingleton(IDialogService, () => statusServices.createInstance(DialogService));
statusServices.registerSingleton(IOutputService, () => statusServices.createInstance(OutputService));
statusServices.registerInstance(IViewsService, { getViewProgressIndicator: () => undefined } as unknown as IViewsService);
statusServices.registerInstance(IViewDescriptorService, { getViewContainerById: () => undefined, getViewDescriptorById: () => undefined } as unknown as IViewDescriptorService);
statusServices.registerInstance(IPaneCompositePartService, { getProgressIndicator: () => undefined } as unknown as IPaneCompositePartService);
statusServices.registerSingleton(IProgressService, () => statusServices.createInstance(ProgressService));
const statusHost = document.createElement('section');
document.body.append(statusHost);
store.add(toDisposable(() => statusHost.remove()));
statusServices.registerInstance(ILayoutService, store.add(new BrowserLayoutService({ root: statusHost })));
// Status Bar traversal dispatches through the owning window's keybinding service.
const keybindingServices = store.add(statusServices.createChild());
const profile = new UserDataProfileService();
keybindingServices.registerInstance(IUserDataProfileService, profile);
const keybindingFiles = store.add(createTestFileService(store.add(new InMemoryFileSystemProvider()), [profile.currentProfile.keybindingsResource.scheme]));
keybindingServices.registerInstance(IFileService, keybindingFiles);
await keybindingFiles.createDirectory(profile.currentProfile.location);
await keybindingFiles.writeFile({ resource: profile.currentProfile.keybindingsResource, content: '[]' }, { create: true, overwrite: true });
const keyboardLayout = store.add(new BrowserKeyboardLayoutService({ navigator }));
const keybindings = store.add(keybindingServices.createInstance(WorkbenchKeybindingService, {
	ownerDocument: document,
	commandService: statusServices.get(ICommandService),
	contextKeyService: statusServices.get(IContextKeyService),
	keyboardLayoutService: keyboardLayout,
}));
await keybindings.initialize();
statusServices.registerInstance(IKeybindingService, keybindings);
store.add(bindTestColorTheme(statusServices.get(IThemeService), statusHost));
store.add(statusServices.createInstance(StatusbarPart, statusHost));
statusServices.registerInstance(IServerEventApi, { subscribe: listener => changes.event(listener) });
statusServices.registerInstance(ILanguageServerService, {
	read: async () => ({ revision: 0, configurations: {}, servers: [] }),
	control: async () => { throw new Error('Unexpected language-server process control'); },
	configure: async () => { throw new Error('Unexpected language-server configuration'); },
	removeConfiguration: async () => { throw new Error('Unexpected language-server configuration removal'); },
});
const languageStatus = store.add(statusServices.createInstance(AppServerLanguageServerStatusService));
let revealedChannel: string | undefined;
let peer: IStatusbarEntryAccessor | undefined;
store.add(statusServices.get(IOutputService).onDidRequestShowChannel(request => { revealedChannel = request.channel.label; }));
store.add(stanza.languages.registerLanguages([{ description: { id: 'python', extensions: ['.py'] } }]));
const model = store.add(stanza.editor.createModel('pri', 'python', stanza.URI.file('/project/main.py')));
const editor = store.add(stanza.editor.create(document.querySelector<HTMLElement>('#editor')!, { model }));
const features = StandaloneServices.get(ILanguageFeaturesService);
let installed = false;
let generation = 0;
let requests = 0;
const api = createDisconnectedLanguageApi(operation => { throw new Error(`Unexpected operation: ${operation}`); });
api.servers = async () => ({ servers: installed ? [{ id: 'pyright', languageIds: ['python'] }] : [] });
api.foldingRanges = async ({ document }) => ({ revision: document.revision, ranges: [] });
api.linkedEditingRanges = async ({ document }) => ({ revision: document.revision, ranges: [], wordPattern: null });
api.semanticTokens = async ({ document }) => ({ revision: document.revision, resultId: null, tokens: [] });
api.documentSymbols = async ({ document }) => ({ revision: document.revision, symbols: [] });
api.documentColors = async ({ document }) => ({ revision: document.revision, colors: [] });
api.codeLenses = async ({ document }) => ({ revision: document.revision, lenses: [] });
api.documentLinks = async ({ document }) => ({ revision: document.revision, links: [] });
api.inlayHints = async ({ document }) => ({ revision: document.revision, hints: [] });
api.completions = async params => {
	requests += 1;
	return {
		revision: params.document.revision, isIncomplete: false, canResolve: false,
		items: [{
			label: 'print_from_server', kind: 'function', insertText: 'print_from_server', insertTextFormat: 'plainText',
			range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 3 } },
			detail: null, documentation: null, filterText: null, sortText: null, preselect: null,
			commitCharacters: [], additionalTextEdits: [], command: null, providerData: null,
		}],
	};
};
const providerServices = store.add(statusServices.createChild());
providerServices.registerInstance(IWorkspaceContextService, workspace);
providerServices.registerInstance(IWorkspaceTrustManagementService, {
	onDidChangeTrust: Event.None,
	getUriTrustInfo: async () => { throw new Error('Backend-authorized requests must not inspect host grants'); },
	getWorkspaceTrustInfo: async () => undefined,
});
providerServices.registerInstance(IServerEventApi, { subscribe: listener => changes.event(listener) });
providerServices.registerInstance(ILanguageServerLifecycleService, { start() {}, withActivity: (_document, _signal, operation) => operation() });
const languageProviders = store.add(providerServices.createInstance(AppServerLanguageProviders, api, { checkWorkspaceTrust: false }));
languageProviders.start();
for (const [id, value] of [['install', true], ['uninstall', false]] as const) {
	store.add(addDisposableListener(document.getElementById(id)!, 'click', () => {
		installed = value;
		changes.fire({ method: 'extensions/changed', params: { instanceId: 'browser-test', generation: ++generation } });
		if (installed) changes.fire({
			method: 'language/serverCapabilities', params: {
				server: 'pyright', languageIds: ['python'], features: ['completion'],
				completionTriggerCharacters: [], onTypeFormattingTriggerCharacters: [], signatureHelpTriggerCharacters: [], signatureHelpRetriggerCharacters: [],
			},
		});
	}));
}

declare global {
	interface Window {
		languageIntegration: { registered(): boolean; requests(): number; focus(): void; progress(percentage: number, done?: boolean): void; updatePeer(percentage: number): void; revealedChannel(): string | undefined; disposeProgress(): void; dispose(): void; };
	}
}
window.languageIntegration = {
	registered: () => features.completionProvider.getProvider('ash.appServer.completions')?.languageIds.includes('python') ?? false,
	requests: () => requests,
	focus: () => { editor.setPosition(new stanza.Position(1, 4)); editor.focus(); },
	progress: (percentage, done = false) => changes.fire({ method: 'language/serverProgress', params: { server: 'rust-analyzer', token: 'index', title: 'Indexing', message: 'Reading workspace', percentage, done } }),
	updatePeer(percentage) {
		const statusbar = statusServices.get(IStatusbarService);
		const entry = { icon: Lxicon.sync, text: `Sync ${percentage}%`, showProgress: true, run() { } };
		if (peer) peer.update(entry);
		else {
			store.add(statusbar.addEntry({ text: 'main', run() { } }, { id: 'test.branch', alignment: StatusbarAlignment.Right, priority: 1, compactGroup: 'test.git' }));
			peer = store.add(statusbar.addEntry(entry, { id: 'test.sync', alignment: StatusbarAlignment.Right, compactGroup: 'test.git' }));
		}
	},
	revealedChannel: () => revealedChannel,
	disposeProgress: () => languageStatus.dispose(),
	dispose: () => store.dispose(),
};
