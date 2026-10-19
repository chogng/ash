import { registerTestCodeEditorFeatures } from '../../fixtures/codeEditorFeatures.js';
const codeFeatures = registerTestCodeEditorFeatures();
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { NotificationService } from '../../../src/ash/workbench/services/notification/common/notificationService.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { addDisposableListener } from '../../../src/ash/base/browser/dom.js';
import { ILanguageFeaturesService } from '../../../src/ash/editor/common/services/languageFeatures.js';
import { IModelService } from '../../../src/ash/editor/common/services/model.js';
import { StandaloneServices } from '../../../src/ash/editor/standalone/browser/standaloneServices.js';
import * as stanza from '../../../src/ash/editor/editor.main.js';
import type { ServerNotification } from '../../../.build/protocol/typescript/index.js';
import { createDisconnectedLanguageApi } from '../../../src/ash/platform/language/browser/languageApi.js';
import { TestWorkspaceService } from '../../../src/ash/workbench/services/configuration/test/common/testServices.js';
import { AppServerLanguageProviders } from '../../../src/ash/workbench/services/language/browser/appServerLanguageProviders.js';
import { AppServerLanguageServerStatusService } from '../../../src/ash/workbench/services/language/browser/appServerLanguageServerStatusService.js';
import { ProgressService } from '../../../src/ash/workbench/services/progress/browser/progressService.js';
import { IProgressService } from '../../../src/ash/platform/progress/common/progress.js';
import { IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { DialogService } from '../../../src/ash/workbench/services/dialogs/common/dialogService.js';
import { IOutputService } from '../../../src/ash/workbench/services/output/common/output.js';
import { OutputService } from '../../../src/ash/workbench/contrib/output/browser/outputServices.js';
import { IStatusbarService } from '../../../src/ash/workbench/services/statusbar/browser/statusbar.js';
import { StatusbarPart } from '../../../src/ash/workbench/browser/parts/statusbar/statusbarPart.js';
import { createTestEditorServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { bindTestColorTheme } from './themeFixture.js';

const store = new DisposableStore();
const changes = store.add(new Emitter<ServerNotification>());
const workspace = store.add(new TestWorkspaceService({ id: 'workspace', uri: stanza.URI.file('/project') }));
const statusServices = store.add(createTestEditorServices());
statusServices.registerSingleton(ICommandService, () => new CommandService(statusServices));
statusServices.registerSingleton(INotificationService, () => new NotificationService());
statusServices.registerInstance(ILanguageFeaturesService, StandaloneServices.get(ILanguageFeaturesService));
statusServices.registerInstance(IModelService, StandaloneServices.get(IModelService));
statusServices.registerSingleton(IDialogService, () => statusServices.createInstance(DialogService));
statusServices.registerSingleton(IOutputService, () => statusServices.createInstance(OutputService));
statusServices.registerSingleton(IProgressService, () => statusServices.createInstance(ProgressService));
const statusHost = document.createElement('section');
document.body.append(statusHost);
store.add(toDisposable(() => statusHost.remove()));
store.add(bindTestColorTheme(statusServices.get(IThemeService), statusHost));
store.add(statusServices.createInstance(StatusbarPart, statusHost, statusServices.get(IStatusbarService)));
const languageStatus = store.add(statusServices.createInstance(AppServerLanguageServerStatusService, { subscribe: (listener: (event: ServerNotification) => void) => changes.event(listener) }));
let revealedChannel: string | undefined;
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
store.add(new AppServerLanguageProviders(api, { checkWorkspaceTrust: false }, features, workspace, {
	onDidChangeTrust: Event.None,
	getUriTrustInfo: async () => { throw new Error('Backend-authorized requests must not inspect host grants'); },
	getWorkspaceTrustInfo: async () => undefined,
}, { subscribe: listener => changes.event(listener) }));
for (const [id, value] of [['install', true], ['uninstall', false]] as const) {
	store.add(addDisposableListener(document.getElementById(id)!, 'click', () => {
		installed = value;
		changes.fire({ method: 'extensions/changed', params: { instanceId: 'browser-test', generation: ++generation } });
	}));
}

declare global {
	interface Window {
		languageIntegration: { registered(): boolean; requests(): number; focus(): void; progress(percentage: number, done?: boolean): void; revealedChannel(): string | undefined; disposeProgress(): void; dispose(): void; };
	}
}
window.languageIntegration = {
	registered: () => features.completionProvider.getProvider('ash.appServer.completions')?.languageIds.includes('python') ?? false,
	requests: () => requests,
	focus: () => { editor.setPosition(new stanza.Position(1, 4)); editor.focus(); },
	progress: (percentage, done = false) => changes.fire({ method: 'language/serverProgress', params: { server: 'rust-analyzer', token: 'index', title: 'Indexing', message: 'Reading workspace', percentage, done } }),
	revealedChannel: () => revealedChannel,
	disposeProgress: () => languageStatus.dispose(),
	dispose: () => store.dispose(),
};
