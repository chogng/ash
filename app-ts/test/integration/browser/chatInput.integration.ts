import { IFileSearchService } from '../../../src/ash/platform/search/common/fileSearch.js';
import { BrowserFileSearchService } from '../../../src/ash/platform/search/browser/browserFileSearchService.js';
import '../../../src/ash/base/browser/ui/styles.css';
import { URI } from '../../../src/ash/base/common/uri.js';
import { FileKind, IFileService } from '../../../src/ash/platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../src/ash/platform/workspace/common/workspace.js';
import { IEditorGroupsService } from '../../../src/ash/workbench/services/editor/common/editorGroupsService.js';
import { IWorkingCopyService } from '../../../src/ash/workbench/services/workingCopy/common/workingCopyService.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { QuickInputController } from '../../../src/ash/platform/quickinput/browser/quickInputController.js';
import { IChatContextPickService } from '../../../src/ash/workbench/services/chat/common/chatContextService.js';
import { ChatContextPickService } from '../../../src/ash/workbench/services/chat/browser/chatContextPickService.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { ActionWidgetService, IActionWidgetService } from '../../../src/ash/platform/actionWidget/browser/actionWidget.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import type { ModelCatalogEntry, ModelReasoningEffort } from '../../../src/ash/workbench/services/chat/common/modelCatalog.js';
import type { ModelRef } from '../../../src/ash/workbench/services/chat/common/chatService.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import '../../../src/ash/workbench/contrib/chat/browser/widget/media/chat.css';
import { ChatInputPart } from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import { ChatInputEditors } from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInputEditorRegistry.js';
import type { ChatInputDelegate, ChatInputState } from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInput.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { IContextViewService, type IContextMenuService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { NotificationService } from '../../../src/ash/workbench/services/notification/common/notificationService.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { ILanguageModelsService } from '../../../src/ash/workbench/contrib/chat/common/languageModels.js';
import { IDictationService } from '../../../src/ash/platform/dictation/common/dictationService.js';
import { ChatSpeechToTextService, IChatSpeechToTextService } from '../../../src/ash/workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { registerTestDictationOnboarding } from '../../../src/ash/workbench/test/common/testDictationServices.js';
import { formatNlsMessage, setNlsResolver } from '../../../src/ash/nls.js';
import { builtinLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { darkColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { EventType, Gesture } from '../../../src/ash/base/browser/touch.js';
import { addDisposableListener, stopEvent } from '../../../src/ash/base/browser/dom.js';

declare global {
	interface Window { ashChatInputIntegration: { refresh(): void; showQuestions(): void; showModels(): void; openModels(): void; denyAcceleration(id: string): void; setRetirement(retirement: ModelCatalogEntry['retirement']): void; dispose(): void; releaseFileSearch(index: number): void; }; }
}

const locale = new URLSearchParams(location.search).get('locale');
if (locale) {
	const catalog = builtinLanguagePackCatalogs.find(candidate => candidate.locale === locale)!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, parameters));
}
const resources = new DisposableStore();
resources.add(bindColorTheme(resources.add(new TestThemeService(darkColorTheme)), document.body));
if (new URLSearchParams(location.search).has('gestureAncestor')) {
	const main = document.querySelector('main')!;
	resources.add(Gesture.addTarget(main));
	resources.add(addDisposableListener(main, EventType.Tap, event => { stopEvent(event); document.querySelector('output')!.textContent = 'Ancestor tap'; }));
}
const services = resources.add(new InstantiationService());
services.registerSingleton(IActionWidgetService, () => services.createInstance(ActionWidgetService));
services.registerInstance(IContextViewService, resources.add(new BrowserContextViewService(document.body)));
const accessibleView = { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService;
services.registerInstance(IAccessibleViewService, accessibleView);
const modelChanged = resources.add(new Emitter<void>());
let selectedReasoningEffort: ModelReasoningEffort | undefined;
const modelOptions = new URLSearchParams(location.search).get('modelOptions');
const multipleAcceleration = new URLSearchParams(location.search).get('acceleration') === 'multiple';
let models: readonly ModelCatalogEntry[] = [{
	model: { provider: 'openai', model: 'test-model' }, displayName: 'Test Model',
	longContext: false, contextWindow: 272_000, defaultContextWindow: 272_000, maximumContextWindow: 872_000,
	description: 'A model for everyday tasks',
	supportedReasoningEfforts: [{ effort: 'low', description: 'Fast responses with lighter reasoning' }, { effort: 'high', description: 'Greater reasoning depth for complex problems' }],
	defaultReasoningEffort: 'low',
	selectedAcceleration: null, accelerationOptions: [{ id: 'priority', name: 'Fast', description: 'Faster responses, increased usage' }, ...(multipleAcceleration ? [{ id: 'ultrafast', name: 'Ultra Fast', description: 'Priority processing, increased usage' }] : [])],
}];
if (modelOptions === 'effort' || modelOptions === 'none') {
	models = models.map(entry => ({ ...entry, longContext: null }));
}
if (modelOptions === 'context' || modelOptions === 'none') {
	models = models.map(entry => ({ ...entry, supportedReasoningEfforts: [] }));
}
if (new URLSearchParams(location.search).get('modelSet') === 'multiple') {
	models = [...models, { ...models[0], model: { provider: 'openai', model: 'extended-model' }, displayName: 'Extended model with a longer display name for coding' }];
}
let selectedModel: ModelRef = models[0].model;
let automatic = false;
services.registerInstance(ILanguageModelsService, {
	readApprovalReviewModel: async () => ({ type: 'automatic' }),
	setApprovalReviewModel: async () => { },
	onDidChangeModels: modelChanged.event,
	setModelPreferences: async (model, update) => {
		models = models.map(entry => entry.model.provider === model.provider && entry.model.model === model.model ? {
			...entry,
			selectedAcceleration: update.acceleration !== undefined ? update.acceleration : entry.selectedAcceleration,
			longContext: update.longContext ?? entry.longContext,
			contextWindow: update.longContext === undefined ? entry.contextWindow : update.longContext ? entry.maximumContextWindow : entry.defaultContextWindow,
		} : entry);
		renderModels();
		modelChanged.fire();
	},
	listModels: async () => models,
	getDefaultNewChatModel: () => undefined,
	rememberSelectedModel: () => { },
	listModelCatalog: async () => models,
	listCustomModelProviders: async () => [],
	saveCustomModelProvider: async () => { },
	testProviderModel: async () => ({ type: 'passed' }),
	listModelProviders: async () => [],
	setModelProviderApiKey: async () => { },
	removeModelProviderApiKey: async () => { },
	listAdvisorModels: async () => [],
	refreshModels: async () => [],
	isModelVisible: () => true,
	setModelVisible: async () => { },
	discoverProviderModels: async () => [],
} satisfies ILanguageModelsService);
services.registerInstance(IConfigurationService, resources.add(new InMemoryConfigurationService()));
services.registerInstance(IDictationService, undefined);
services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
registerTestDictationOnboarding(services);
const notifications = resources.add(new NotificationService());
services.registerInstance(INotificationService, notifications);
const quickInput = resources.add(new QuickInputController(document.body));
services.registerInstance(IQuickInputService, quickInput);
const contextPicks = new ChatContextPickService();
services.registerInstance(IChatContextPickService, contextPicks);
resources.add(contextPicks.registerPicker({
	id: 'integration.context', label: 'Test source', isEnabled: () => true,
	providePicks: async query => {
		if (query === 'error') { throw new Error('Context source failed'); }
		return [{ label: 'Source context', attachment: { id: 'source', kind: 'source', name: 'Source context', resolve: async () => ({ name: 'Source context', content: 'Registered context content' }) } }];
	},
}));
const root = URI.file('/workspace');
const edited = URI.file('/workspace/edited.ts');
services.registerInstance(IWorkspaceContextService, { getWorkspace: () => ({ folders: [{ id: 'workspace', index: 0, uri: root, name: 'workspace' }] }) } as unknown as IWorkspaceContextService);
services.registerInstance(IEditorGroupsService, { groups: [{ inputs: [{ resource: edited }] }] } as unknown as IEditorGroupsService);
services.registerInstance(IWorkingCopyService, { get: (resource: URI) => resource.path === edited.path ? [{ backupKind: 'text', backup: () => 'Unsaved editor text' }] : [] } as unknown as IWorkingCopyService);
const fileSearchWaiters = new Map<number, () => void>();
let fileSearchReads = 0;
let fileSearchCompleted = 0;
const searchReads = document.createElement('output');
searchReads.setAttribute('aria-label', 'File search reads');
const searchCompleted = document.createElement('output');
searchCompleted.setAttribute('aria-label', 'Completed file search reads');
document.body.append(searchReads, searchCompleted);
services.registerInstance(IFileService, {
	readDirectory: async (resource: URI) => {
		if (resource.path === '/workspace' && new URLSearchParams(location.search).has('deferFileSearch')) {
			searchReads.textContent = String(++fileSearchReads);
			await new Promise<void>(resolve => fileSearchWaiters.set(fileSearchReads, resolve));
			searchCompleted.textContent = String(++fileSearchCompleted);
		}
		return resource.path === '/workspace' ? [
			{ resource: URI.file('/workspace/src'), name: 'src', kind: FileKind.Directory },
			{ resource: URI.file('/workspace/brief.txt'), name: 'brief.txt', kind: FileKind.File },
		] : [{ resource: URI.file('/workspace/src/nested.txt'), name: 'nested.txt', kind: FileKind.File }];
	},
	readFile: async (resource: URI) => ({ resource, content: 'Workspace file content', revision: '1' }),
} as unknown as IFileService);
services.registerInstance(IFileSearchService, services.createInstance(BrowserFileSearchService));
const submission = document.createElement('output');
submission.setAttribute('aria-label', 'Submission');
document.body.append(submission);
const errorOutput = document.createElement('output');
errorOutput.setAttribute('aria-label', 'Context error');
document.body.append(errorOutput);
resources.add(notifications.onDidAdd(item => { errorOutput.textContent = item.message; }));

const delegate: ChatInputDelegate = {
	send: async (_text, _mode, _skills, contexts) => {
		submission.textContent = JSON.stringify(await Promise.all((contexts ?? []).map(context => context.resolve())));
		if (new URLSearchParams(location.search).has('sendFailure')) { throw new Error('Send failed'); }
	}, executeCommand: async () => { }, executeServerCommand: async () => { }, interrupt: async () => { },
	selectModel: async model => {
		selectedModel = model;
		automatic = false;
		renderModels();
	}, selectReasoningEffort: async effort => {
		selectedReasoningEffort = effort;
		renderModels();
	}, selectAutomaticModel: async () => {
		automatic = true;
		renderModels();
	},
	listAgents: async () => [], selectAgent: () => { }, selectMode: () => { }, openModelSettings: async () => { },
	resolveInteraction: async response => { if (response.type === 'approval') document.querySelector('output')!.textContent = response.response.decision; },
};
const cowork = new URLSearchParams(location.search).get('surface') === 'cowork';
const part = resources.add(services.createInstance(ChatInputPart, document.querySelector('main')!, delegate, { showContextMenu: () => { }, hideContextMenu: () => { }, onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None } satisfies IContextMenuService, services.get(IContextViewService), accessibleView, notifications, ChatInputEditors, [], {
	modePicker: cowork ? 'hidden' : 'visible',
	modelPickerPosition: cowork ? 'trailing' : 'leading',
}));
const state: ChatInputState = {
	mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false,
	interaction: {
		requestId: 'approval', request: {
			type: 'approval', request: {
				reason: 'Review the requested actions', capabilities: [
					{ kind: 'fileRead', scope: '/workspace/file with spaces.ts' },
					{ kind: 'fileWrite', scope: String.raw`C:\Users\name\file.ts` },
					{ kind: 'fileWrite', scope: String.raw`\\server\share\file.ts` },
					{ kind: 'processSpawn', scope: 'pnpm test <script>' },
					{ kind: 'network', scope: 'https://api.example.test' },
					{ kind: 'credentialUse', scope: 'provider-key' },
					{ kind: 'externalMutation', scope: 'issue:42' },
					{ kind: 'systemConfiguration', scope: 'git.user.email' },
					{ kind: 'userInterface', scope: 'current window' },
					{ kind: 'fileWrite', scope: `/workspace/${'a'.repeat(160)}.ts` },
				],
			}
		}
	},
};
function renderModels(): void {
	part.render({ ...state, models, selectedModel, isAutomaticModel: automatic, selectedReasoningEffort, interaction: undefined });
}
part.render(state);
window.ashChatInputIntegration = {
	releaseFileSearch: index => {
		const release = fileSearchWaiters.get(index)!;
		fileSearchWaiters.delete(index);
		release();
	},
	setRetirement: retirement => {
		models = models.map(entry => ({ ...entry, retirement }));
		renderModels();
		modelChanged.fire();
	},
	denyAcceleration: id => {
		models = models.map(entry => ({ ...entry, accelerationOptions: entry.accelerationOptions!.filter(option => option.id !== id) }));
		part.render({ ...state, models, selectedModel: models[0].model, isAutomaticModel: false, interaction: undefined });
		modelChanged.fire();
	},
	showModels: renderModels,
	openModels: () => part.openModelSelector(),
	dispose: () => resources.dispose(),
	refresh: () => part.render({ ...state, queuedMessages: 1 }),
	showQuestions: () => part.render({
		...state, interaction: {
			requestId: 'questions', request: {
				type: 'userInput', request: {
					questions: [
						{ id: 'text', header: 'Answer', question: 'Your answer', allowFreeForm: true },
						{ id: 'choice', header: 'Choice', question: 'Your choice', allowFreeForm: false, options: [{ label: 'First', description: 'First option' }] },
					]
				}
			},
		}
	}),
};
part.setVisible(true);
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
