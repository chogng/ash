import { BrowserImageEditorService } from '../../../src/ash/workbench/services/imageEditor/browser/browserImageEditorService.js';
import { IImageEditorService } from '../../../src/ash/workbench/services/imageEditor/common/imageEditorService.js';
import { IHostService } from '../../../src/ash/workbench/services/host/browser/host.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { FileService } from '../../../src/ash/platform/files/common/fileService.js';
import { TestHostService } from '../../../src/ash/workbench/services/host/test/browser/testHostService.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { SearchSettingsModel } from '../../../src/ash/workbench/contrib/search/browser/searchSettingsModel.js';
import { SettingsSectionRenderer } from '../../../src/ash/workbench/contrib/preferences/browser/settingsSectionRenderer.js';
import { AccessibleViewProviderId, AccessibilityVerbositySettingId } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { IContentSearchConfigurationService } from '../../../src/ash/platform/search/common/search.js';
import { IAppServerRemoteAgentService } from '../../../src/ash/workbench/services/remote/common/appServerRemoteAgentService.js';
import { DEFAULT_LOCAL_TRANSCRIPTION_MODEL } from '../../../src/ash/platform/localTranscription/common/localTranscription.js';
import { IChatSpeechToTextService, ChatSpeechToTextService } from '../../../src/ash/workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import '../../../src/ash/workbench/contrib/accessibility/browser/accessibilityConfiguration.js';
import { IExtensionService } from '../../../src/ash/workbench/services/extensions/common/extensionService.js';
import { TestExtensionService } from '../../../src/ash/workbench/test/common/testExtensionServices.js';
import { ExtensionResourceLoaderService } from '../../../src/ash/platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import { MainThreadSpeech } from '../../../src/ash/workbench/api/browser/mainThreadSpeech.js';
import type { IExtensionHostApi, ExtensionHostFleetSnapshot, JsonValue } from '../../../src/ash/platform/agentHost/common/extensionHostApi.js';
import { IMessageHistoryService } from '../../../src/ash/platform/messageHistory/common/messageHistory.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../src/ash/platform/quickinput/test/browser/testQuickInputService.js';
import '../../../src/ash/workbench/contrib/chat/browser/chat.shared.contribution.js';
import '../../../src/ash/workbench/contrib/codeEditor/browser/dictation/editorDictation.js';
import '../../../src/ash/workbench/contrib/chat/browser/actions/chatSpeechToTextActions.js';
import { IPreferencesService } from '../../../src/ash/workbench/services/preferences/common/preferences.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { IKeybindingService } from '../../../src/ash/platform/keybinding/common/keybinding.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { CodeEditorWidget } from '../../../src/ash/editor/browser/widget/codeEditor/codeEditorWidget.js';
import { TextModel } from '../../../src/ash/editor/common/model/textModel.js';
import { IStorageService, StorageScope } from '../../../src/ash/platform/storage/common/storage.js';
import { IContextViewService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { registerTestDictationOnboarding, createTestDictationBackend, installTestDictationAudio } from '../../../src/ash/workbench/test/common/testDictationServices.js';
import { IVoiceCodeTranscriptionBackendService } from '../../../src/ash/platform/renderer/common/dictation.js';
import { ISpeechService, SPEECH_LANGUAGE_CONFIG } from '../../../src/ash/workbench/contrib/speech/common/speechService.js';
import '../../../src/ash/base/browser/ui/button/button.css';
import '../../../src/ash/base/browser/ui/inputbox/inputbox.css';
import '../../../src/ash/base/browser/ui/splitview/splitview.css';
import '../../../src/ash/base/browser/ui/sash/sash.css';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { DictationConfiguration } from '../../../src/ash/workbench/contrib/chat/common/constants.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { ILocalTranscriptionModelService, DictationModelState, type ILocalTranscriptionModelSnapshot, type IDictationModelStatus } from '../../../src/ash/platform/localTranscription/common/localTranscription.js';
import { bindTestColorTheme } from './themeFixture.js';
import { lightColorTheme, darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { noFileIconTheme } from '../../../src/ash/platform/theme/common/themeService.js';
import { IResourceIconRenderer } from '../../../src/ash/workbench/browser/labels.js';
import { LocalTranscriptionModelControls } from '../../../src/ash/workbench/contrib/preferences/browser/localTranscriptionModelControls.js';
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../src/ash/workbench/services/configuration/test/common/testServices.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { productLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { ChatInputEditor } from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInputEditor.js';
import { SlashCommandCatalog } from '../../../src/ash/workbench/contrib/chat/common/slashCommands.js';
import { SkillSelectorCatalog } from '../../../src/ash/workbench/contrib/chat/common/skillSelectors.js';
import { SpeechService } from '../../../src/ash/workbench/contrib/speech/browser/speechService.js';
import { DictationInput } from '../../../src/ash/workbench/contrib/chat/browser/speechToText/dictationInputController.js';
import { setARIAContainer } from '../../../src/ash/base/browser/ui/aria/aria.js';
import '../../../src/ash/workbench/contrib/chat/browser/widget/media/chat.css';
import { ChatInputPart } from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import { IChatAttachmentResolveService } from '../../../src/ash/workbench/contrib/chat/browser/attachments/chatAttachmentResolveService.js';
import type { ChatInputEditorOptions } from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInputEditorRegistry.js';
import { TestNotificationService } from './notificationFixture.js';
import type { IContextMenuService } from '../../../src/ash/platform/contextview/browser/contextView.js';

import type { ChatInputDelegate } from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInput.js';
import { ILanguageModelsService } from '../../../src/ash/workbench/contrib/chat/common/languageModels.js';
import { ISecretStorageStatusService, type SecretStorageStatus, type SecretStorageMode } from '../../../src/ash/platform/secrets/common/secrets.js';
import { IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { DialogService } from '../../../src/ash/workbench/services/dialogs/common/dialogService.js';
import { BrowserDialogHandler } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.js';
import { DialogHandlerContribution } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.web.contribution.js';
import { ModelSettingsRenderer } from '../../../src/ash/workbench/contrib/preferences/browser/modelSettingsRenderer.js';
import { SettingsTreeModel, type SettingsSectionReference } from '../../../src/ash/workbench/contrib/preferences/browser/settingsTreeModels.js';
import { SettingsTree } from '../../../src/ash/workbench/contrib/preferences/browser/settingsTree.js';

declare global {
	interface Window {
		ashTableIntegration: {
			showCredentialSettings(): void;
			showSearchSettings(): void;
			readonly searchSaved: readonly string[];
			setCredentialStorage(status: SecretStorageStatus): void;
			setCredentialStorageMode(mode: SecretStorageMode): void;
			readonly credentialOperations: readonly string[];
			progress(): void;
			finish(): void;
			theme(name: string): void;
			dispose(): void;
			readonly operations: string[];
			extensionSpeech(admitted: boolean, lazy?: boolean): Promise<void>;
			holdSpeechActivation(): void;
			releaseSpeechActivation(): void;
			readonly speechActivations: number;
			readonly extensionStarts: number;
			readonly extensionLanguage: string | undefined;
			setSpeechLanguage(language: string): Promise<void>;
			readonly speechFlags: readonly boolean[];
			cancelSpeechCommand(): Promise<void>;
			toggleDictationCommand(): Promise<void>;
			setDictationButton(visible: boolean): Promise<void>;
			startDictation(): Promise<void>;
			codeDictation(): Promise<void>;
			readonly codeText: string;
			freshIntroduction(): void;
			showIntroduction(): Promise<void>;
			readonly microphone: string;
			readonly language: string;
			readonly starts: number;
			readonly stops: number;
			readonly audioPackets: number;
			readonly analysing: boolean;
			holdCapture(): void;
			releaseCapture(): void;
			transcript(text: string, final: boolean): void;
			readonly draft: string;
			stopDictation(): Promise<string | undefined>;
			hideSecondInput(): void;
			secondDraft(): Promise<string>;
		};
	}
}

if (new URLSearchParams(location.search).get('locale') === 'zh-CN') {
	const catalog = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages(catalog.locale, catalog.bundles);
}

const resources = new DisposableStore();
if (!new URLSearchParams(location.search).has('realAudio')) resources.add(installTestDictationAudio(window));
const configuration = resources.add(new WorkbenchConfigurationService({ source: '{"dictation.backend":"cloud"}' }));
const services = resources.add(new InstantiationService());
services.registerInstance(IFileService, resources.add(new FileService()));
services.registerInstance(IEditorService, { onDidVisibleEditorsChange: Event.None, onDidActiveEditorChange: Event.None } as unknown as IEditorService);
const notifications = resources.add(new TestNotificationService());
services.registerInstance(INotificationService, notifications);
services.registerInstance(IHostService, new TestHostService());
services.registerSingleton(IImageEditorService, () => services.createInstance(BrowserImageEditorService));
const modelChanges = resources.add(new Emitter<void>());
let credentialStorage: SecretStorageStatus = 'available';
let credentialStorageMode: SecretStorageMode | undefined;
const credentialOperations: string[] = [];
let credentialSettings = false;
services.registerInstance(IMessageHistoryService, undefined);
services.registerSingleton(IQuickInputService, () => new TestQuickInputService({ instantiationService: services, container: document.body }));
services.registerInstance(IConfigurationService, configuration);
services.registerInstance(ISecretStorageStatusService, {
	readState: async () => ({ status: credentialStorage, mode: credentialStorageMode }),
	authorizeAccess: async () => { credentialOperations.push('authorize'); credentialStorage = 'available'; return { status: credentialStorage, mode: credentialStorageMode }; },
	setStorageMode: async mode => { credentialOperations.push(mode); credentialStorageMode = mode; credentialStorage = 'available'; return { status: credentialStorage, mode }; },
});
const dialogs = resources.add(new DialogService());
resources.add(new DialogHandlerContribution(dialogs.model, new BrowserDialogHandler(document.body)));
services.registerInstance(IDialogService, dialogs);
services.registerInstance(ILanguageModelsService, {
	onDidChangeModels: modelChanges.event,
	listModels: async () => [], listModelCatalog: async () => [], refreshModels: async () => [],
	listAdvisorModels: async () => [], listModelProviders: async () => credentialSettings ? [{ connection: 'openai', provider: 'openai', displayName: 'OpenAI API', access: 'apiKey', active: true, configured: true, ready: true, apiKeyPolicy: 'required', apiKeyConfigured: true }] : [], listCustomModelProviders: async () => [],
	getDefaultNewChatModel: () => undefined, rememberSelectedModel: async () => { }, isModelVisible: () => true,
	readModelDefaults: async () => ({ revision: 1, model: null, reasoningEffort: null }), saveReasoningEffort: async () => { },
	setModelVisible: async () => { }, setModelPreferences: async () => { },
	readApprovalReviewModel: async () => ({ type: 'automatic' }), setApprovalReviewModel: async () => { },
	saveCustomModelProvider: async () => { }, testProviderModel: async () => ({ type: 'passed' }),
	setModelProviderApiKey: async () => { }, removeModelProviderApiKey: async () => { }, discoverProviderModels: async () => [],
});
const changed = resources.add(new Emitter<void>());
let models: ILocalTranscriptionModelSnapshot[] = [
	{ model: DEFAULT_LOCAL_TRANSCRIPTION_MODEL, available: false, sizeBytes: 0 },
	{ model: 'imported-model', available: true, sizeBytes: 1024 * 1024 },
];
const operations: string[] = [];
let finish: ((state: DictationModelState.Ready | DictationModelState.Cancelled) => void) | undefined;
function publish(status: IDictationModelStatus): void {
	models = models.map(model => model.model === DEFAULT_LOCAL_TRANSCRIPTION_MODEL ? { ...model, status } : model);
	changed.fire();
}
const backend: ILocalTranscriptionModelService = {
	getCacheDirectory: async () => "C:/models",
	_serviceBrand: undefined,
	isSupported: true,
	onDidChangeModels: changed.event,
	getModel: async model => models.find(value => value.model === model) ?? { model, available: false, sizeBytes: 0 },
	listModels: async () => models,
	prepareModel: model => {
		operations.push(`install:${model}`);
		publish({ state: DictationModelState.Checking });
		return { completed: new Promise(resolve => { finish = resolve; }), cancel: async () => backend.cancelModel(model), dispose() { }, [Symbol.dispose]() { } };
	},
	importPackage: () => { throw new Error('Unused in this scenario'); },
	cancelModel: async model => {
		operations.push(`cancel:${model}`);
		publish({ state: DictationModelState.Cancelled });
		finish?.(DictationModelState.Cancelled);
	},
	deleteModel: async model => {
		operations.push(`uninstall:${model}`);
		models = models.filter(value => value.model !== model);
		changed.fire();
	},
};
services.registerInstance(ILocalTranscriptionModelService, backend);
const root = document.getElementById('models')!;
root.style.width = '760px';
const theme = resources.add(new TestThemeService(lightColorTheme));
resources.add(bindTestColorTheme(theme, document.body));
const controls = resources.add(services.createInstance(LocalTranscriptionModelControls, root));
controls.setVisible(true);
const unexpectedAttachment = async (): Promise<never> => { throw new Error('The dictation fixture must not resolve attachments'); };
services.registerInstance(IChatAttachmentResolveService, {
	_serviceBrand: undefined,
	resolveUntitledEditorAttachContext: unexpectedAttachment,
	resolveSymbolsAttachContext: unexpectedAttachment,
	resolveSourceControlHistoryItemAttachContext: () => { throw new Error('The dictation fixture must not resolve attachments'); },
	resolveEditorAttachContext: unexpectedAttachment,
	resolveResourceAttachContext: unexpectedAttachment,
	resolveImageEditorAttachContext: unexpectedAttachment,
	resolveImageAttachContext: unexpectedAttachment,
});
registerCodeEditorServices(services);
services.registerInstance(IResourceIconRenderer, { onDidChangeResourceIcons: Event.None, getFileIconTheme: () => noFileIconTheme, renderFileIcon() { } });
setARIAContainer(document.body);
const inputContainer = document.createElement('div');
inputContainer.style.width = '600px';
document.body.append(inputContainer);
const editor = resources.add(services.createInstance(ChatInputEditor, { container: inputContainer, ariaLabel: 'Dictation draft', placeholder: '', slashCommands: new SlashCommandCatalog([], []), skills: new SkillSelectorCatalog() }));
const preview = document.createElement('div');
preview.id = 'dictation-preview';
document.body.append(preview);
let starts = 0;
let stops = 0;
let audioPackets = 0;
let captureReady = Promise.resolve();
let releaseCapture!: () => void;
let transcript!: (text: string, final: boolean) => void;
let declaredSpeech = false;
let speechActivations = 0;
let activationReady = Promise.resolve();
let releaseSpeechActivation!: () => void;
const speechManifest = JSON.stringify({ name: 'speech', publisher: 'example', version: '1.0.0', contributes: { speechProviders: [{ name: 'example.recognition', description: 'Recognition' }] } });
const speechExtensions = resources.add(new TestExtensionService({
	list: async () => {
		if (!declaredSpeech) return { generation: 1, extensions: [], diagnostics: [] };
		const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(speechManifest)))].map(value => value.toString(16).padStart(2, '0')).join('');
		return { generation: 2, diagnostics: [], extensions: [{ id: 'example.speech', name: 'speech', publisher: 'example', version: '1.0.0', displayName: 'Recognition', sourceKind: 'user', manifestJson: speechManifest, manifestSha256: `sha256:${digest}`, packageSha256: `sha256:${'b'.repeat(64)}` }] };
	},
	resources: new ExtensionResourceLoaderService(async () => { throw new Error('Speech metadata must not read resources'); }),
}));
services.registerInstance(IExtensionService, speechExtensions);
const transcriptionBackend = createTestDictationBackend(resources, {
	getOptions: async () => ({ inputDevices: [{ id: 'microphone-1', label: 'Test microphone', isDefault: true }], languages: ['en', 'zh'] }), start: async (_options, onTranscript: (text: string, isFinal: boolean) => void) => { starts++; transcript = onTranscript; await captureReady; return { stop: async () => { stops++; }, cancel: async () => { stops++; } }; },
});
transcriptionBackend.pushAudio = async (_resourceId, audio) => {
	if (!audio || atob(audio).length % 2 !== 0) throw new Error('Invalid PCM16 from renderer');
	audioPackets++;
};
services.registerInstance(IVoiceCodeTranscriptionBackendService, new URLSearchParams(location.search).has('extensionOnly') ? undefined : transcriptionBackend);
services.registerSingleton(ISpeechService, () => services.createInstance(SpeechService));
if (!services.has(IChatSpeechToTextService)) services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
registerTestDictationOnboarding(services);
services.registerInstance(IPreferencesService, { openSettings: async () => { } } as unknown as IPreferencesService);
services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
const codeContainer = document.createElement('div');
codeContainer.style.cssText = 'width:600px;height:220px';
document.body.append(codeContainer);
const codeModel = resources.add(new TextModel('before old after'));
const codeEditor = resources.add(services.createInstance(CodeEditorWidget, { container: codeContainer, model: codeModel, ariaLabel: 'Ordinary dictation editor' }));
codeEditor.setModel(codeModel);
codeEditor.layout({ width: 600, height: 220 });
services.get(IKeybindingService);

const dictationSession = resources.add(services.createInstance(DictationInput, editor, preview, () => true, async () => { }, 'chat'));
const contextViews = services.get(IContextViewService);
const secondInput = resources.add(services.createInstance(ChatInputPart, document.body, {} as ChatInputDelegate, {} as IContextMenuService, contextViews, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService, notifications, {
	create: (options: ChatInputEditorOptions) => services.createInstance(ChatInputEditor, options),
}, [], { modePicker: 'visible', modelPickerPosition: 'leading' }));
secondInput.element.id = 'second-input';
secondInput.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
let extensionStarts = 0;
let extensionLanguage: string | undefined;
let extensionEmit: ((text: string, final: boolean) => void) | undefined;
const speechEvents = new Map<string, JsonValue[]>();
const speechSnapshot = (admitted: boolean): ExtensionHostFleetSnapshot => ({
	generation: 1, extensions: [{
		id: 'example.speech', version: '1', packageDigest: `sha256:${'a'.repeat(64)}`, runtimeApiVersion: 1,
		incarnation: 1, activationGeneration: 1, lifecycle: 'ready', failure: undefined, stderr: '', outputEvents: [],
		registrations: admitted ? [{ registrationId: 'speech', kind: 'speechProvider', registrationGeneration: 1, identifier: 'example.recognition' }] : [],
	}]
});
const speechApi: IExtensionHostApi = {
	onDidChange: Event.None, onConnectionState: Event.None,
	getConnectionState: async () => 'ready', isAvailable: async () => true,
	list: async () => speechSnapshot(true), start: async () => speechSnapshot(true), reconcile: async () => speechSnapshot(true), activateByEvent: async () => speechSnapshot(true),
	registerClientHandler: () => ({ dispose() { } }),
	invoke: async (request, signal): Promise<JsonValue> => {
		signal.throwIfAborted();
		const payload = request.payload as { readonly sessionId: string; readonly kind?: string; readonly language?: string; };
		if (request.operation === 'createSpeechSession') {
			if (payload.kind !== 'speechToText') throw new Error('Only transcription is used in this UI fixture');
			extensionStarts++;
			extensionLanguage = payload.language;
			speechEvents.set(payload.sessionId, [{ status: 1 }]);
			extensionEmit = (text, final) => speechEvents.get(payload.sessionId)?.push({ status: final ? 3 : 2, text });
			return {};
		}
		if (request.operation === 'closeSpeechSession') { speechEvents.delete(payload.sessionId); return {}; }
		if (request.operation === 'readSpeechSession') return { events: speechEvents.get(payload.sessionId)?.splice(0) ?? [], closed: !speechEvents.has(payload.sessionId) };
		throw new Error('Unexpected speech operation');
	},
};
const speechBridge = resources.add(new MainThreadSpeech(1000, speechApi, services.get(ISpeechService)));
resources.add(speechExtensions.registerActivationHandler(async (event, signal) => {
	if (event !== 'onSpeech' || !declaredSpeech) return;
	speechActivations++;
	await activationReady;
	signal?.throwIfAborted();
	speechBridge.update(speechSnapshot(true));
}));
const searchSaved: string[] = [];
window.ashTableIntegration = {
	get searchSaved() { return searchSaved; },
	showSearchSettings: () => {
		let engine: 'tgrep' | 'ripgrep' = 'tgrep';
		let revision = 1;
		services.registerInstance(IContentSearchConfigurationService, {
			read: async () => ({ revision, engine }),
			configure: async (next, expected) => {
				if (expected !== revision) throw new Error('stale revision');
				engine = next;
				revision++;
				searchSaved.push(next);
			},
		});
		services.registerInstance(IAppServerRemoteAgentService, { onDidChangeConnection: Event.None, onDidChangeConnectionState: Event.None } as IAppServerRemoteAgentService);
		const root = document.createElement('div');
		root.id = 'search-settings';
		document.body.append(root);
		const model = resources.add(services.createInstance(SearchSettingsModel));
		const renderer = resources.add(services.createInstance(SettingsSectionRenderer, root, model, AccessibleViewProviderId.ContentSearchSettings, AccessibilityVerbositySettingId.ContentSearchSettings));
		const node = renderer.getNodes()[0].children![0].element;
		if (node.kind !== 'item' || !('rendererId' in node.value)) throw new Error('Missing search settings');
		root.append(renderer.renderItem(node.value));
		renderer.setVisible(true);
	},
	showCredentialSettings: () => {
		credentialSettings = true;
		const root = document.createElement('div');
		root.id = 'credential-settings';
		document.body.append(root);
		const content = resources.add(services.createInstance(ModelSettingsRenderer, root));
		const model = resources.add(new SettingsTreeModel<SettingsSectionReference>());
		resources.add(new SettingsTree(root, {
			model, rootClassName: 'ash-models-settings', groupClassName: 'ash-settings-content-group', groupDescriptionClassName: 'ash-settings-group-description', itemsClassName: 'ash-settings-list', renderGroupHeader: header => content.renderItem(header), renderItem: item => content.renderItem(item.value),
		}));
		resources.add(content.onDidChange(() => model.setChildren(content.getNodes())));
		content.setVisible(true);
	},
	setCredentialStorage: status => { credentialStorage = status; modelChanges.fire(); },
	setCredentialStorageMode: mode => { credentialStorageMode = mode; modelChanges.fire(); },
	credentialOperations,
	extensionSpeech: async (admitted, lazy = false) => {
		if (!lazy && !declaredSpeech) { speechBridge.update(speechSnapshot(admitted)); if (!admitted) extensionEmit = undefined; return; }
		declaredSpeech = admitted && lazy;
		await speechExtensions.reload();
		speechBridge.update(speechSnapshot(admitted && !lazy));
		if (!admitted) extensionEmit = undefined;
	},
	holdSpeechActivation: () => { activationReady = new Promise(resolve => { releaseSpeechActivation = resolve; }); },
	releaseSpeechActivation: () => releaseSpeechActivation(),
	get speechActivations() { return speechActivations; },
	get extensionStarts() { return extensionStarts; },
	get extensionLanguage() { return extensionLanguage; },
	setSpeechLanguage: language => configuration.updateValue(SPEECH_LANGUAGE_CONFIG, language),
	get speechFlags() {
		const context = services.get(IContextKeyService).getContext();
		return ['hasSpeechProvider', 'speechToTextInProgress', 'textToSpeechInProgress'].map(key => context.getValue(key) === true);
	},
	cancelSpeechCommand: () => services.get(ICommandService).executeCommand('workbench.action.chat.cancelSpeechToText'),
	toggleDictationCommand: () => services.get(ICommandService).executeCommand('workbench.action.chat.toggleSpeechToText'),
	setDictationButton: visible => configuration.updateValue('dictation.showButton', visible),
	codeDictation: async () => { codeEditor.focus(); await services.get(ICommandService).executeCommand('workbench.action.editorDictation.start'); },
	get codeText() { return codeModel.getValue(); },
	freshIntroduction: () => services.get(IStorageService).remove('dictation.introductionSeen', StorageScope.PROFILE),
	showIntroduction: () => services.get(ICommandService).executeCommand('workbench.action.chat.showSpeechToTextIntroduction'),
	get microphone() { return configuration.getValue<string>(DictationConfiguration.inputDevice); },
	get language() { return configuration.getValue<string>(DictationConfiguration.language); },
	get starts() { return starts; },
	get stops() { return stops; },
	get audioPackets() { return audioPackets; },
	get analysing() { return !!services.get(IChatSpeechToTextService).analyserNode; },
	holdCapture: () => { captureReady = new Promise(resolve => { releaseCapture = resolve; }); },
	releaseCapture: () => releaseCapture(),
	secondDraft: async () => (await secondInput.captureDraft())?.draft.text ?? '',
	operations,
	startDictation: async () => { await dictationSession.action.run(); },
	stopDictation: () => services.get(IChatSpeechToTextService).stopAndTranscribe(),
	hideSecondInput: () => { secondInput.setVisible(false); secondInput.element.hidden = true; },
	transcript: (text, final) => { if (extensionEmit) extensionEmit(text, final); else transcript?.(text, final); },
	get draft() { return editor.value; },
	progress: () => publish({ state: DictationModelState.Downloading, file: 'encoder.onnx', downloadedBytes: 1024 * 1024 }),
	finish: () => {
		models = models.map(model => model.model === DEFAULT_LOCAL_TRANSCRIPTION_MODEL ? { ...model, available: true, sizeBytes: 2 * 1024 * 1024, status: { state: DictationModelState.Ready } } : model);
		changed.fire();
		finish?.(DictationModelState.Ready);
	},
	theme: name => theme.setColorTheme(({ dark: darkColorTheme, light: lightColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme })[name]!),
	dispose: () => resources.dispose(),
};
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
