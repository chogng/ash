import { addDisposableListener } from '../../../../../../../base/browser/dom.js';
import { setARIAContainer } from '../../../../../../../base/browser/ui/aria/aria.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { Range } from '../../../../../../../editor/common/core/range.js';
import { IBulkEditService } from '../../../../../../../editor/browser/services/bulkEditService.js';
import { ICodeEditorService } from '../../../../../../../editor/browser/services/codeEditorService.js';
import { setNlsMessages } from '../../../../../../../nls.js';
import { IAccessibleViewService } from '../../../../../../../platform/accessibility/browser/accessibleView.js';
import { IAccessibilitySignalService } from '../../../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { IConfigurationService } from '../../../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService } from '../../../../../../../platform/contextkey/browser/contextKeyService.js';
import { IDialogService } from '../../../../../../../platform/dialogs/common/dialogs.js';
import { FileService } from '../../../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../../../platform/files/common/files.js';
import { InstantiationService } from '../../../../../../../platform/instantiation/common/instantiationService.js';
import { BrowserLayoutService, ILayoutService } from '../../../../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../../../../platform/storage/common/storage.js';
import { INotificationService } from '../../../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../../../platform/quickinput/common/quickInput.js';
import { bindTestColorTheme } from '../../../../../../../../../test/fixtures/browser/themeFixture.js';
import { highContrastDarkColorTheme, lightColorTheme } from '../../../../../../../platform/theme/common/colorTheme.js';
import { registerCodeEditorServices } from '../../../../../../../editor/test/browser/testCodeEditor.js';
import { TestThemeService } from '../../../../../../../platform/theme/test/common/testThemeService.js';
import { IUriIdentityService } from '../../../../../../../platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from '../../../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { IEditorPartsService } from '../../../../../../browser/parts/editor/editorParts.js';
import { BulkEditService } from '../../../../../bulkEdit/browser/bulkEditService.js';
import { createBrowserEditorPart } from '../../../../../codeEditor/browser/browserEditorPart.js';
import { BrowserTextResourceStore } from '../../../../../codeEditor/browser/browserTextResourceStore.js';
import { ChatEditingEditorOverlay } from '../../../../browser/chatEditing/chatEditingEditorOverlay.js';
import { ChatEditingService } from '../../../../browser/chatEditing/chatEditingServiceImpl.js';
import { IChatEditingService } from '../../../../common/editing/chatEditingService.js';
import { CommandService } from '../../../../../../services/commands/common/commandService.js';
import { CodeEditorService } from '../../../../../../services/editor/browser/codeEditorService.js';
import { DialogService } from '../../../../../../services/dialogs/common/dialogService.js';
import { AccessibleViewService } from '../../../../../accessibility/browser/accessibleView.js';
import { productLanguagePackCatalogs } from '../../../../../../services/localization/common/localizationCatalogs.js';
import { TestNotificationService } from '../../../../../../../../../test/fixtures/browser/notificationFixture.js';
import { TestQuickInputService } from '../../../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { ITextModelResourceService } from '../../../../../../services/textmodelResolver/common/textModelResourceService.js';
import { BrowserTextModelService } from '../../../../../../services/textmodelResolver/browser/browserTextModelService.js';
import { IWorkingCopyService } from '../../../../../../services/workingCopy/common/workingCopyService.js';
import { BrowserWorkingCopyService } from '../../../../../../services/workingCopy/browser/browserWorkingCopyService.js';
import { BrowserStorageService } from '../../../../../../services/storage/browser/storageService.js';
import { ILifecycleService } from '../../../../../../services/lifecycle/common/lifecycle.js';
import { BrowserLifecycleService } from '../../../../../../services/lifecycle/browser/lifecycleService.js';
import { createTestEditorServices } from '../../../../../../test/common/testEditorServices.js';
import { MemoryTextFiles } from '../../../../../../../../../test/fixtures/browser/memoryTextFiles.js';
import { Event } from '../../../../../../../base/common/event.js';
import { DeferredPromise } from '../../../../../../../base/common/async.js';
import { IChatService, ChatHistoryConflictError, type RestoreChatCheckpointOptions } from '../../../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../../../../services/chat/common/chatSessionNavigationService.js';
import '../../../../../../browser/media/style.css';

type MoveChatHistoryOptions = Parameters<IChatService['moveHistory']>[0];

declare global {
	interface Window {
		ashChatEditingIntegration: {
			snapshot(): { entries: string[][]; texts: string[]; };
			prepareReload(): Promise<void>;
			checkpointState(): { requests: RestoreChatCheckpointOptions[]; opened: string[]; };
			switchChat(): void;
			finishRestore(): void;
			historyState(): { requests: MoveChatHistoryOptions[]; opened: string[]; };
			dirtyFile(): Promise<void>;
			setSaveFailure(fail: boolean): void;
			reviewState(): { resource: string; pendingSave: boolean; hunks: number; }[];
			diskTexts(): string[];
		};
	}
}

const parameters = new URLSearchParams(location.search);
const locale = parameters.get('locale') ?? 'en';
const catalog = productLanguagePackCatalogs.find(candidate => candidate.locale === locale)!;
setNlsMessages(locale, catalog.bundles);
await import('../../../../browser/chatEditing/chatEditingEditorActions.js');
await import('../../../../browser/chatEditing/chatEditingActions.js');

const resources = new DisposableStore();
const services = resources.add(new InstantiationService());
const first = URI.file('/workspace/first.txt');
const second = URI.file('/workspace/second.txt');
const disk = parameters.has('reopen') ? JSON.parse(localStorage.getItem('chatEditing.test-files')!) as string[] : ['original', 'original'];
const files = new MemoryTextFiles(first, disk[0]!);
resources.add(toDisposable(() => files.dispose()));
await files.save({ resource: second, text: disk[1]! }, new AbortController().signal);
resources.add(files.onDidChangeFiles(() => localStorage.setItem('chatEditing.test-files', JSON.stringify([files.read(first), files.read(second)]))));
services.registerInstance(IFileService, resources.add(new FileService()));
services.registerInstance(IUriIdentityService, resources.add(services.createInstance(UriIdentityService)));
const models = resources.add(services.createInstance(BrowserTextModelService, new BrowserTextResourceStore(files), {}));
services.registerInstance(ITextModelResourceService, models);
services.registerInstance(IWorkingCopyService, resources.add(services.createInstance(BrowserWorkingCopyService)));
services.registerInstance(IConfigurationService, resources.add(new InMemoryConfigurationService()));
services.registerInstance(IDialogService, resources.add(new DialogService()));
services.registerInstance(IBulkEditService, resources.add(services.createInstance(BulkEditService)));
services.registerInstance(IStorageService, resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'chat-editing', flushInterval: 0 })));
services.registerInstance(ILogService, { trace() { }, debug() { }, info() { }, warn() { }, error() { } });
const lifecycle = resources.add(services.createInstance(BrowserLifecycleService, { ownerWindow: window, onError: (error: unknown) => console.error(error) }));
services.registerInstance(ILifecycleService, lifecycle);
services.registerInstance(IAccessibilitySignalService, { playSignal: async () => { }, playSignalLoop: () => Disposable.None });
const notifications = resources.add(new TestNotificationService());
services.registerInstance(INotificationService, notifications);
resources.add(notifications.model.onDidAdd(item => { document.querySelector('#error')!.textContent = item.message; }));
services.registerInstance(IEditorPartsService, { activePane: undefined } as unknown as IEditorPartsService);
services.registerSingleton(ICodeEditorService, () => services.createInstance(CodeEditorService));
const contexts = resources.add(new ContextKeyService());
services.registerInstance(IQuickInputService, resources.add(new TestQuickInputService({ instantiationService: services, container: document.body, contextKeyService: contexts })));
const commands = resources.add(new CommandService(services));
const editing = resources.add(services.createInstance(ChatEditingService));
services.registerInstance(IChatEditingService, editing);
let activeChat = { sessionId: 'session', threadId: 'source' };
const restoreRequests: RestoreChatCheckpointOptions[] = [];
const historyRequests: MoveChatHistoryOptions[] = [];
let historySequence = 17;
let canRedo = false;
const opened: string[] = [];
const restoring = (parameters.has('restoreSlow') || parameters.has('historySlow')) ? new DeferredPromise<void>() : undefined;
services.registerInstance(IChatSessionNavigationService, {
	revision: 0,
	getActiveConversation: () => activeChat,
	getConversations: () => [], startVoiceConversation: async () => { throw new Error("Unexpected voice start"); }, appendToActiveDraft() { }, captureActiveDraft: async () => undefined,
	openConversation: async (sessionId, threadId) => { activeChat = { sessionId, threadId }; opened.push(threadId); },
});
// Durable message history is the external boundary of this UI fixture.
services.registerInstance(IChatService, {
	readHistoryState: async () => {
		if (parameters.has('historyReadConflict')) throw new ChatHistoryConflictError();
		if (parameters.has('historySlow')) await restoring?.p;
		return { sequence: historySequence, canUndo: !canRedo && !parameters.has('historyBusy'), canRedo };
	},
	readThread: async () => ({ directory: { type: 'local', root: '/workspace' } }),
	moveHistory: async (options: MoveChatHistoryOptions) => {
		historyRequests.push(options);
		if (parameters.has('historyConflict')) throw new ChatHistoryConflictError();
		historySequence++;
		canRedo = options.direction === 'undo';
	},
	readCheckpoints: async () => parameters.has('unavailable')
		? [{ itemId: 'message', turnId: 'turn', sourceThreadId: 'source', files: 'unavailable', unavailableReason: 'No Git snapshot' }]
		: [{ itemId: 'message', turnId: 'turn', sourceThreadId: 'source', files: 'git' }],
	restoreCheckpoint: async (options: RestoreChatCheckpointOptions) => {
		restoreRequests.push(options);
		if (restoring) { await restoring.p; }
		return { sessionId: 'session', threadId: 'restored' };
	},
} as unknown as IChatService);
resources.add(bindTestColorTheme(resources.add(new TestThemeService(locale === 'en' ? lightColorTheme : highContrastDarkColorTheme)), document.body));
setARIAContainer(document.body);

async function write(resource: URI, threadId: string, text: string): Promise<void> {
	using reference = await models.acquire({ resource }, new AbortController().signal);
	await editing.applyEdits({ entries: [{ kind: 'textDocument', resource, edits: [{ range: Range.lift(reference.model.getFullModelRange()), text }] }] }, new AbortController().signal, { threadId, turnId: 'turn' });
}

if (!parameters.has('reopen')) {
	await write(first, 'first-chat', 'first change');
	await write(second, 'second-chat', 'second change');
	if (parameters.has('shared')) { await write(first, 'second-chat', 'shared change'); }
}
await editing.finishTurn({ threadId: 'readiness', turnId: 'readiness' }, 'completed');
let saveFailure = parameters.has('saveFailure');
const saveFile = files.save.bind(files);
files.save = async (request, signal) => {
	if (saveFailure) { throw new Error('Injected review save failure'); }
	return saveFile(request, signal);
};

for (const [selector, command] of [['#reject', 'chatEditing.rejectAll'], ['#review', 'chatEditing.reviewChanges'], ['#checkpoint', 'workbench.action.chat.restoreCheckpoint'], ['#undo', 'workbench.action.chat.undoEdit'], ['#redo', 'workbench.action.chat.redoEdit']] as const) {
	resources.add(addDisposableListener(document.querySelector(selector)!, 'click', () => {
		void commands.executeCommand(command).catch(error => {
			document.querySelector('#error')!.textContent = String(error.message);
		});
	}));
}
if (parameters.has('editor')) {
	const editorServices = resources.add(createTestEditorServices(undefined, services));
	registerCodeEditorServices(editorServices);
	editorServices.registerInstance(ILayoutService, resources.add(new BrowserLayoutService({ root: document.body })));
	editorServices.registerSingleton(IAccessibleViewService, () => editorServices.createInstance(AccessibleViewService));
	resources.add(editorServices.createInstance(ChatEditingEditorOverlay));
	const reference = resources.add(await models.acquire({ resource: first }, new AbortController().signal));
	const container = document.createElement('div');
	container.id = 'review-editor';
	container.style.width = '240px';
	container.style.height = '260px';
	document.body.append(container);
	resources.add(toDisposable(() => container.remove()));
	resources.add(createBrowserEditorPart(editorServices, {
		container, model: reference.model, ariaLabel: first.path, automaticLayout: true,
		minimap: { enabled: false }, lineNumbers: 'off', glyphMargin: false,
	}));
}

window.ashChatEditingIntegration = {
	historyState: () => ({ requests: historyRequests, opened }),
	setSaveFailure: fail => { saveFailure = fail; },
	reviewState: () => editing.entries.map(entry => ({ resource: entry.modifiedURI.path, pendingSave: entry.hasPendingSave, hunks: entry.hunks.length })),
	diskTexts: () => [first, second].map(resource => files.read(resource)),
	dirtyFile: async () => {
		const reference = resources.add(await models.acquire({ resource: first }, new AbortController().signal));
		resources.add(services.get(IWorkingCopyService).register({
			...reference, backupKind: 'text',
			get isDirty() { return reference.isDirty; },
			onDidChangeContent: Event.map(reference.model.onDidChangeContent, () => undefined),
			backup: () => reference.model.getText(),
			restoreBackup: text => reference.model.applyEdits([{ range: reference.model.getFullModelRange(), text }]),
		}));
		reference.model.applyEdits([{ range: reference.model.getFullModelRange(), text: 'unsaved user text' }]);
	},
	checkpointState: () => ({ requests: restoreRequests, opened }),
	switchChat: () => { activeChat = { sessionId: 'other-session', threadId: 'other-thread' }; },
	finishRestore: () => { void restoring?.complete(); },
	prepareReload: () => lifecycle.shutdown('reload'),
	snapshot: () => ({
		entries: editing.entries.map(entry => entry.resources.map(resource => resource.path)),
		texts: [first, second].map(resource => models.getModel(resource)?.getText() ?? files.read(resource)),
	}),
};
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
