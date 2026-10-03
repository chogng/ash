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
import { registerTestDictationOnboarding } from '../../../src/ash/workbench/test/common/testDictationServices.js';
import { IDictationService } from '../../../src/ash/platform/dictation/common/dictationService.js';
import { IChatSpeechToTextService } from '../../../src/ash/workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import '../../../src/ash/base/browser/ui/button/button.css';
import '../../../src/ash/base/browser/ui/inputbox/inputbox.css';
import '../../../src/ash/base/browser/ui/splitview/splitview.css';
import '../../../src/ash/base/browser/ui/sash/sash.css';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { DEFAULT_LOCAL_DICTATION_MODEL, DictationConfiguration } from '../../../src/ash/platform/dictation/common/dictationConfiguration.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { ILocalTranscriptionService, LocalTranscriptionModelState, type ILocalTranscriptionModelSnapshot, type ILocalTranscriptionModelStatus } from '../../../src/ash/platform/localTranscription/common/localTranscription.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { lightColorTheme, darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { LocalTranscriptionModelControls } from '../../../src/ash/workbench/contrib/localTranscription/browser/localTranscriptionModelControls.js';
import { WorkbenchConfigurationService } from '../../../src/ash/workbench/services/configuration/browser/configurationService.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { builtinLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { ChatInputEditor } from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInputEditor.js';
import { SlashCommandCatalog } from '../../../src/ash/workbench/contrib/chat/common/slashCommands.js';
import { SkillSelectorCatalog } from '../../../src/ash/workbench/contrib/chat/common/skillSelectors.js';
import { ChatSpeechToTextService } from '../../../src/ash/workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { DictationSession } from '../../../src/ash/workbench/contrib/chat/browser/speechToText/dictationSession.js';
import { setARIAContainer } from '../../../src/ash/base/browser/ui/aria/aria.js';
import '../../../src/ash/workbench/contrib/chat/browser/widget/media/chat.css';
import { ChatInputPart } from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import type { ChatInputEditorOptions } from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInputEditorRegistry.js';
import { NotificationService } from '../../../src/ash/workbench/services/notification/common/notificationService.js';
import type { IContextMenuService } from '../../../src/ash/platform/contextview/browser/contextView.js';

import type { ChatInputDelegate } from '../../../src/ash/workbench/contrib/chat/browser/widget/input/chatInput.js';
import { ILanguageModelsService } from '../../../src/ash/workbench/contrib/chat/common/languageModels.js';

declare global {
	interface Window {
		ashTableIntegration: {
			progress(): void;
			finish(): void;
			theme(name: string): void;
			dispose(): void;
			readonly operations: string[];
			startDictation(): Promise<void>;
			codeDictation(): Promise<void>;
			readonly codeText: string;
			freshIntroduction(): void;
			readonly microphone: string;
			readonly language: string;
			readonly starts: number;
			readonly stops: number;
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
	const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages(catalog.locale, catalog.bundles);
}

const resources = new DisposableStore();
const configuration = resources.add(new WorkbenchConfigurationService());
const services = resources.add(new InstantiationService());
services.registerInstance(IConfigurationService, configuration);
services.registerInstance(ILanguageModelsService, {
	onDidChangeModels: Event.None,
	listModels: async () => [], listModelCatalog: async () => [], refreshModels: async () => [],
	listAdvisorModels: async () => [], listModelProviders: async () => [], listCustomModelProviders: async () => [],
	getDefaultNewChatModel: () => undefined, rememberSelectedModel: () => {}, isModelVisible: () => true,
	setModelVisible: async () => {}, setModelPreferences: async () => {},
	readApprovalReviewModel: async () => ({ type: 'automatic' }), setApprovalReviewModel: async () => {},
	saveCustomModelProvider: async () => {}, testProviderModel: async () => ({ type: 'passed' }),
	setModelProviderApiKey: async () => {}, removeModelProviderApiKey: async () => {}, discoverProviderModels: async () => [],
});
const changed = resources.add(new Emitter<void>());
let models: ILocalTranscriptionModelSnapshot[] = [
	{ model: DEFAULT_LOCAL_DICTATION_MODEL, available: false, sizeBytes: 0 },
	{ model: 'imported-model', available: true, sizeBytes: 1024 * 1024 },
];
const operations: string[] = [];
let finish: ((state: LocalTranscriptionModelState.Ready | LocalTranscriptionModelState.Cancelled) => void) | undefined;
function publish(status: ILocalTranscriptionModelStatus): void {
	models = models.map(model => model.model === DEFAULT_LOCAL_DICTATION_MODEL ? { ...model, status } : model);
	changed.fire();
}
const backend: ILocalTranscriptionService = {
	_serviceBrand: undefined,
	isSupported: true,
	onDidChangeModels: changed.event,
	onDidChangeModelStatus: Event.None,
	onDidTranscribe: Event.None,
	onDidEnd: Event.None,
	getModelStatus: async model => models.find(value => value.model === model) ?? { model, available: false, sizeBytes: 0 },
	listModels: async () => models,
	prepareModel: model => {
		operations.push(`install:${model}`);
		publish({ state: LocalTranscriptionModelState.Checking });
		return { completed: new Promise(resolve => { finish = resolve; }), cancel: async () => backend.cancelModel(model), dispose() {}, [Symbol.dispose]() {} };
	},
	importModel: () => { throw new Error('Unused in this scenario'); },
	cancelModel: async model => {
		operations.push(`cancel:${model}`);
		publish({ state: LocalTranscriptionModelState.Cancelled });
		finish?.(LocalTranscriptionModelState.Cancelled);
	},
	deleteModel: async model => {
		operations.push(`uninstall:${model}`);
		models = models.filter(value => value.model !== model);
		changed.fire();
	},
	start: async () => {}, stop: async () => '', cancel: async () => {}, dispose() {}, [Symbol.dispose]() {},
};
services.registerInstance(ILocalTranscriptionService, backend);
const root = document.getElementById('models')!;
root.style.width = '760px';
const theme = resources.add(new TestThemeService(lightColorTheme));
resources.add(bindColorTheme(theme, document.body));
const controls = resources.add(services.createInstance(LocalTranscriptionModelControls, root));
controls.setVisible(true);
registerCodeEditorServices(services);
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
let captureReady = Promise.resolve();
let releaseCapture!: () => void;
let transcript!: (text: string, final: boolean) => void;
services.registerInstance(IDictationService, {
	onDidChangePreparation: Event.None, getOptions: async () => ({ inputDevices: [{ id: 'microphone-1', label: 'Test microphone', isDefault: true }], languages: ['en', 'zh'] }), getPreparation: async () => undefined, prepareModel: async () => {}, cancelPreparation: async () => {},
	start: async (onTranscript: (text: string, isFinal: boolean) => void) => { starts++; transcript = onTranscript; await captureReady; return { stop: async () => { stops++; } }; },
});
services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
registerTestDictationOnboarding(services);
services.registerInstance(IPreferencesService, { openSettings: async () => {} } as unknown as IPreferencesService);
services.registerInstance(IEditorService, { onDidVisibleEditorsChange: Event.None } as unknown as IEditorService);
services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
const codeContainer = document.createElement('div');
codeContainer.style.cssText = 'width:600px;height:220px';
document.body.append(codeContainer);
const codeModel = resources.add(new TextModel('before old after'));
const codeEditor = resources.add(services.createInstance(CodeEditorWidget, { container: codeContainer, model: codeModel, ariaLabel: 'Ordinary dictation editor' }));
codeEditor.setModel(codeModel);
codeEditor.layout({ width: 600, height: 220 });
services.get(IKeybindingService);

const dictationSession = resources.add(services.createInstance(DictationSession, editor, preview, () => true, async () => {}));
const contextViews = services.get(IContextViewService);
const notifications = resources.add(new NotificationService());
const secondInput = resources.add(services.createInstance(ChatInputPart, document.body, {} as ChatInputDelegate, {} as IContextMenuService, contextViews, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService, notifications, {
	create: (options: ChatInputEditorOptions) => services.createInstance(ChatInputEditor, options),
}, []));
secondInput.element.id = 'second-input';
secondInput.render({ mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'ready', canInterrupt: false, models: [], isAutomaticModel: true, slashCommands: [], skillSelectors: [], canSelectAgent: false });
window.ashTableIntegration = {
	codeDictation: async () => { codeEditor.focus(); await services.get(ICommandService).executeCommand('workbench.action.editorDictation.start'); },
	get codeText() { return codeModel.getValue(); },
	freshIntroduction: () => services.get(IStorageService).remove('dictation.introductionSeen', StorageScope.PROFILE),
	get microphone() { return configuration.getValue<string>(DictationConfiguration.inputDevice); },
	get language() { return configuration.getValue<string>(DictationConfiguration.language); },
	get starts() { return starts; },
	get stops() { return stops; },
	holdCapture: () => { captureReady = new Promise(resolve => { releaseCapture = resolve; }); },
	releaseCapture: () => releaseCapture(),
	secondDraft: async () => (await secondInput.captureDraft())?.draft.text ?? '',
	operations,
	startDictation: async () => { await dictationSession.action.run(); },
	stopDictation: () => services.get(IChatSpeechToTextService).stopAndTranscribe(),
	hideSecondInput: () => { secondInput.setVisible(false); secondInput.element.hidden = true; },
	transcript: (text, final) => transcript(text, final),
	get draft() { return editor.value; },
	progress: () => publish({ state: LocalTranscriptionModelState.Downloading, file: 'encoder.onnx', downloadedBytes: 1024 * 1024 }),
	finish: () => {
		models = models.map(model => model.model === DEFAULT_LOCAL_DICTATION_MODEL ? { ...model, available: true, sizeBytes: 2 * 1024 * 1024, status: { state: LocalTranscriptionModelState.Ready } } : model);
		changed.fire();
		finish?.(LocalTranscriptionModelState.Ready);
	},
	theme: name => theme.setColorTheme(({ dark: darkColorTheme, light: lightColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme })[name]!),
	dispose: () => resources.dispose(),
};
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
