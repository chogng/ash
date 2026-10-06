import { ActionWidgetService, IActionWidgetService } from '../../../src/ash/platform/actionWidget/browser/actionWidget.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import type { ModelCatalogEntry, ModelReasoningEffort } from '../../../src/ash/workbench/services/chat/common/modelCatalog.js';
import type { ModelRef } from '../../../src/ash/workbench/services/chat/common/chatService.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import '../../../src/ash/workbench/contrib/chat/browser/widget/media/chat.css';
import { ChatInputPart } from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import { ChatInputPart as CoworkChatInputPart } from '../../../src/ash/sessions/contrib/cowork/browser/widget/input/chatInputPart.js';
import '../../../src/ash/sessions/contrib/cowork/browser/widget/media/chat.css';
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
import { ChatSpeechToTextService as CoworkSpeechToTextService, IChatSpeechToTextService as ICoworkSpeechToTextService } from '../../../src/ash/sessions/contrib/cowork/browser/speechToText/chatSpeechToTextService.js';
import { DictationOnboardingService as CoworkDictationOnboardingService, IDictationOnboardingService as ICoworkDictationOnboardingService } from '../../../src/ash/sessions/contrib/cowork/browser/speechToText/dictationOnboarding.js';
import { registerTestDictationOnboarding } from '../../../src/ash/workbench/test/common/testDictationServices.js';
import { formatNlsMessage, setNlsResolver } from '../../../src/ash/nls.js';
import { builtinLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';

declare global {
	interface Window { ashChatInputIntegration: { refresh(): void; showQuestions(): void; showModels(): void; dispose(): void; }; }
}

const locale = new URLSearchParams(location.search).get('locale');
if (locale) {
	const catalog = builtinLanguagePackCatalogs.find(candidate => candidate.locale === locale)!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, parameters));
}
const resources = new DisposableStore();
const services = resources.add(new InstantiationService());
services.registerSingleton(IActionWidgetService, () => services.createInstance(ActionWidgetService));
services.registerInstance(IContextViewService, resources.add(new BrowserContextViewService(document.body)));
const accessibleView = { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService;
services.registerInstance(IAccessibleViewService, accessibleView);
const modelChanged = resources.add(new Emitter<void>());
let selectedReasoningEffort: ModelReasoningEffort | undefined;
const modelOptions = new URLSearchParams(location.search).get('modelOptions');
let models: readonly ModelCatalogEntry[] = [{
	model: { provider: 'openai', model: 'test-model' }, displayName: 'Test Model',
	contextWindowOptions: [272_000, 1_000_000], contextWindow: 272_000, defaultContextWindow: 272_000,
	description: 'A model for everyday tasks',
	supportedReasoningEfforts: [{ effort: 'low', description: 'Fast responses with lighter reasoning' }, { effort: 'high', description: 'Greater reasoning depth for complex problems' }],
	defaultReasoningEffort: 'low',
	supportsFast: true, fast: false, acceleration: { name: 'Fast', description: 'Faster responses, increased usage' },
}];
if (modelOptions === 'effort' || modelOptions === 'none') {
	models = models.map(entry => ({ ...entry, contextWindowOptions: [] }));
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
		models = models.map(entry => entry.model.provider === model.provider && entry.model.model === model.model ? { ...entry, fast: update.fast ?? entry.fast, contextWindow: update.contextWindow ?? entry.contextWindow } : entry);
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
services.registerSingleton(ICoworkSpeechToTextService, () => services.createInstance(CoworkSpeechToTextService));
services.registerSingleton(ICoworkDictationOnboardingService, () => services.createInstance(CoworkDictationOnboardingService));
const notifications = resources.add(new NotificationService());
const delegate: ChatInputDelegate = {
	send: async () => { }, executeCommand: async () => { }, executeServerCommand: async () => { }, interrupt: async () => { },
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
const inputPart = new URLSearchParams(location.search).get('surface') === 'cowork' ? CoworkChatInputPart : ChatInputPart;
const part = resources.add(services.createInstance<ChatInputPart | CoworkChatInputPart>(inputPart, document.querySelector('main')!, delegate, { showContextMenu: () => { }, hideContextMenu: () => { }, onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None } satisfies IContextMenuService, services.get(IContextViewService), accessibleView, notifications, ChatInputEditors, []));
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
	dispose: () => resources.dispose(),
	showModels: renderModels,
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
