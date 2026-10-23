import { Extensions as WorkbenchExtensions, type IConfigurationMigrationRegistry } from '../../../common/configuration.js';
import { DEFAULT_LOCAL_TRANSCRIPTION_MODEL } from '../../../../platform/localTranscription/common/localTranscription.js';
import { parseBackend, parseLocalModel, parseCloudProvider, parseInputDevice, parseLanguage } from '../common/constants.js';
import { IChatSpeechToTextService, ChatSpeechToTextService, DICTATION_MODEL_SETTING } from './speechToText/chatSpeechToTextService.js';
import { IVoiceCodeTranscriptionClient, VoiceCodeTranscriptionClient } from './speechToText/voiceCodeTranscriptionClient.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ChatContextKeys } from '../common/actions/chatContextKeys.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { ChatInputConfiguration, ChatEditorConfiguration, autoAcceptDelaySetting } from '../common/constants.js';
import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILanguageModelToolsService } from '../common/tools/languageModelToolsService.js';
import { LanguageModelToolsService } from './tools/languageModelToolsService.js';
import { IChatWidgetService } from './chat.js';
import { ChatWidgetService } from './widget/chatWidgetService.js';

import { ChatSessionArchiveActionWording, ChatSessionArchiveActionWordingSettingId } from '../../../../platform/chat/common/sessionArchiveActions.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';

registerSingleton(IChatSpeechToTextService, ChatSpeechToTextService, InstantiationType.Delayed);
registerSingleton(IVoiceCodeTranscriptionClient, VoiceCodeTranscriptionClient, InstantiationType.Delayed);
registerSingleton(IChatWidgetService, ChatWidgetService, InstantiationType.Delayed);

registerSingleton(ILanguageModelToolsService, LanguageModelToolsService, InstantiationType.Delayed);

registerWorkbenchContribution('workbench.contrib.chatEnablement', WorkbenchPhase.BlockStartup, accessor => {
	const configuration = accessor.get(IConfigurationService);
	const enabled = ChatContextKeys.enabled.bindTo(accessor.get(IContextKeyService));
	const resources = new DisposableStore();
	const update = (): void => enabled.set(configuration.getValue<boolean>(ChatAIDisabledSettingId) !== true);
	update();
	resources.add(configuration.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration(ChatAIDisabledSettingId)) update();
	}));
	resources.add(toDisposable(() => enabled.reset()));
	return resources;
});

const configurationRegistry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);

configurationRegistry.registerConfiguration<boolean>({
	key: ChatAIDisabledSettingId,
	policy: { name: 'ChatAIDisabled' },
	defaultValue: false,
	scope: ConfigurationScope.WINDOW,
	schema: { type: 'boolean' },
	parse(value: unknown): boolean {
		if (typeof value === 'boolean') return value;
		throw new TypeError(localize('chat.ai.disabled.invalid', 'Disable AI features must be a boolean.'));
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('chat.ai.disabled.title', 'Disable AI features'); },
		get description() { return localize('chat.ai.disabled.description', 'Hide Chat in the Code window and prevent new built-in Chat requests in all windows. History and drafts are kept. Active voice conversations stop; already running work continues and can still be stopped.'); },
	},
});

configurationRegistry.registerConfiguration<ChatSessionArchiveActionWording>({
	key: ChatSessionArchiveActionWordingSettingId,
	defaultValue: ChatSessionArchiveActionWording.MarkAsDone,
	scope: ConfigurationScope.WINDOW,
	schema: { type: 'string', enum: ['archive', 'done'] },
	parse(value: unknown): ChatSessionArchiveActionWording {
		if (value === ChatSessionArchiveActionWording.Archive || value === ChatSessionArchiveActionWording.MarkAsDone) return value;
		throw new TypeError(localize('chatSession.wording.invalid', 'Choose Archive or Mark as Done for session actions.'));
	},
	setting: {
		valueType: 'select',
		get title() { return localize('chatSession.wording.title', 'Session action wording'); },
		get description() { return localize('chatSession.wording.description', 'Choose the labels for archiving and restoring sessions. Archiving interrupts running work; restoring makes the root conversation available again without resuming its work.'); },
		get options() {
			return [
				{ value: ChatSessionArchiveActionWording.Archive, label: localize('chatSession.archive', 'Archive') },
				{ value: ChatSessionArchiveActionWording.MarkAsDone, label: localize('chatSession.markAsDone', 'Mark as Done') },
			];
		},
	},
});

/** Prompt typography belongs to the user's UI, independently of file and reply-code editors. */
configurationRegistry.registerConfiguration<string>({
	key: ChatInputConfiguration.fontFamily,
	defaultValue: '',
	scope: ConfigurationScope.APPLICATION,
	schema: { type: 'string', maxLength: 256, pattern: '^[^\\r\\n\\u0000]*$' },
	parse(value: unknown): string {
		if (typeof value === 'string' && value.length <= 256 && !/[\r\n\0]/u.test(value)) return value;
		throw new TypeError(localize('chat.input.fontFamily.invalid', 'Chat input font must be a single-line string no longer than 256 characters.'));
	},
	setting: {
		valueType: 'text',
		get title() { return localize('chat.input.fontFamily.title', 'Font family'); },
		get description() { return localize('chat.input.fontFamily.description', 'Set the font for messages you type. Leave empty to use the system UI font. This does not change replies or code blocks.'); },
		get placeholder() { return localize('chat.input.fontFamily.default', 'System default'); },
	},
});
configurationRegistry.registerConfiguration<number>({
	key: ChatInputConfiguration.fontSize,
	defaultValue: 13,
	agentsWindow: { default: 14 },
	scope: ConfigurationScope.APPLICATION,
	schema: { type: 'integer', minimum: 8, maximum: 40 },
	parse(value: unknown): number {
		if (typeof value === 'number' && Number.isInteger(value) && value >= 8 && value <= 40) return value;
		throw new RangeError(localize('chat.input.fontSize.invalid', 'Chat input font size must be an integer between 8 and 40.'));
	},
	setting: {
		valueType: 'number', minimum: 8, maximum: 40,
		get title() { return localize('chat.input.fontSize.title', 'Font size'); },
		get description() { return localize('chat.input.fontSize.description', 'Set the message input text size in pixels.'); },
	},
});
configurationRegistry.registerConfiguration<number>({
	key: ChatInputConfiguration.lineHeight,
	defaultValue: 20,
	scope: ConfigurationScope.APPLICATION,
	schema: { anyOf: [{ const: 0 }, { type: 'integer', minimum: 8, maximum: 80 }] },
	parse(value: unknown): number {
		if (typeof value === 'number' && Number.isInteger(value) && (value === 0 || value >= 8 && value <= 80)) return value;
		throw new RangeError(localize('chat.input.lineHeight.invalid', 'Chat input line height must be 0 or an integer between 8 and 80.'));
	},
	setting: {
		valueType: 'number', minimum: 0, maximum: 80,
		get title() { return localize('chat.input.lineHeight.title', 'Line height'); },
		get description() { return localize('chat.input.lineHeight.description', 'Set the message input line height in pixels. The default is 20. Use 0 to calculate it from the font size.'); },
	},
});

/** Code-block preferences override the file editor's typography within Chat replies. */
configurationRegistry.registerConfiguration<string>({
	key: ChatEditorConfiguration.fontFamily, defaultValue: '', scope: ConfigurationScope.APPLICATION,
	schema: { type: 'string', maxLength: 256, pattern: '^[^\\r\\n\\u0000]*$' },
	parse(value: unknown): string {
		if (typeof value === 'string' && value.length <= 256 && !/[\r\n\0]/u.test(value)) return value;
		throw new TypeError(localize('chat.editor.fontFamily.invalid', 'Code block font must be a single-line string no longer than 256 characters.'));
	},
	setting: {
		valueType: 'text',
		get title() { return localize('chat.editor.fontFamily.title', 'Font family'); },
		get description() { return localize('chat.editor.fontFamily.description', 'Set the font for code blocks in replies. Leave empty to use the editor font.'); },
		get placeholder() { return localize('chat.editor.fontFamily.default', 'Use editor font'); },
	},
});
configurationRegistry.registerConfiguration<number>({
	key: ChatEditorConfiguration.fontSize, defaultValue: 0, scope: ConfigurationScope.APPLICATION,
	schema: { anyOf: [{ const: 0 }, { type: 'integer', minimum: 8, maximum: 40 }] },
	parse(value: unknown): number {
		if (typeof value === 'number' && Number.isInteger(value) && (value === 0 || value >= 8 && value <= 40)) return value;
		throw new RangeError(localize('chat.editor.fontSize.invalid', 'Code block font size must be 0 or an integer between 8 and 40.'));
	},
	setting: {
		valueType: 'number', minimum: 0, maximum: 40,
		get title() { return localize('chat.editor.fontSize.title', 'Font size'); },
		get description() { return localize('chat.editor.fontSize.description', 'Set the code block text size in pixels. Use 0 to follow the editor font size.'); },
	},
});
configurationRegistry.registerConfiguration<number>({
	key: ChatEditorConfiguration.lineHeight, defaultValue: 0, scope: ConfigurationScope.APPLICATION,
	schema: { anyOf: [{ const: 0 }, { type: 'integer', minimum: 8, maximum: 80 }] },
	parse(value: unknown): number {
		if (typeof value === 'number' && Number.isInteger(value) && (value === 0 || value >= 8 && value <= 80)) return value;
		throw new RangeError(localize('chat.editor.lineHeight.invalid', 'Code block line height must be 0 or an integer between 8 and 80.'));
	},
	setting: {
		valueType: 'number', minimum: 0, maximum: 80,
		get title() { return localize('chat.editor.lineHeight.title', 'Line height'); },
		get description() { return localize('chat.editor.lineHeight.description', 'Set the code block line height in pixels. Use 0 to follow the editor line height setting. When the editor uses automatic line height, it is calculated from the code block font size.'); },
	},
});
configurationRegistry.registerConfiguration<'on' | 'off'>({
	key: ChatEditorConfiguration.wordWrap, defaultValue: 'off', scope: ConfigurationScope.APPLICATION,
	schema: { type: 'string', enum: ['on', 'off'] },
	parse(value: unknown): 'on' | 'off' {
		if (value === 'on' || value === 'off') return value;
		throw new TypeError(localize('chat.editor.wordWrap.invalid', 'Code block word wrap must be on or off.'));
	},
	setting: {
		valueType: 'select',
		get title() { return localize('chat.editor.wordWrap.title', 'Word wrap'); },
		get description() { return localize('chat.editor.wordWrap.description', 'Wrap long code lines to fit the reply width. When off, scroll horizontally to read long lines.'); },
		get options() { return [{ value: 'off', label: localize('chat.editor.wordWrap.off', 'Off') }, { value: 'on', label: localize('chat.editor.wordWrap.on', 'On') }] as const; },
	},
});

configurationRegistry.registerConfiguration<number>({
	key: autoAcceptDelaySetting,
	defaultValue: 0,
	scope: ConfigurationScope.WINDOW,
	schema: { type: 'number', minimum: 0, maximum: 100 },
	parse: value => {
		if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
			throw new TypeError('chat.editing.autoAcceptDelay must be a number between 0 and 100');
		}
		return value;
	},
	setting: {
		valueType: 'number', minimum: 0, maximum: 100,
		get title() { return localize('chatEditing.autoAcceptTitle', 'Automatically accept Agent changes'); },
		get description() { return localize('chatEditing.autoAcceptDescription', 'Seconds to wait before accepting edits after the reply completes. Set to 0 to review changes manually. You can cancel the countdown to keep reviewing.'); },
	},
});

configurationRegistry.registerConfiguration<string>({
	key: 'dictation.inputDevice', defaultValue: '', parse: parseInputDevice,
});

configurationRegistry.registerConfiguration<boolean>({
	key: 'dictation.enabled', defaultValue: true,
	parse(value: unknown): boolean { if (typeof value !== 'boolean') throw new TypeError('dictation.enabled must be boolean'); return value; },
	setting: { valueType: 'boolean', title: localize('dictation.enabled.title', 'Enable dictation'), description: localize('dictation.enabled.description', 'Use speech to enter text in messages, editors, and terminals.') },
});
configurationRegistry.registerConfiguration<boolean>({
	key: 'dictation.showButton', defaultValue: true,
	parse(value: unknown): boolean { if (typeof value !== 'boolean') throw new TypeError('dictation.showButton must be boolean'); return value; },
	setting: { valueType: 'boolean', title: localize('dictation.showButton.title', 'Show microphone button'), description: localize('dictation.showButton.description', 'Show the dictation button in message inputs. Dictation commands remain available.') },
});

configurationRegistry.registerConfiguration<boolean>({
	key: 'dictation.showTranscript', defaultValue: true,
	parse(value: unknown): boolean { if (typeof value !== 'boolean') throw new TypeError('dictation.showTranscript must be boolean'); return value; },
	setting: { valueType: 'boolean', title: localize('dictation.showTranscript.title', 'Show interim dictation text'), description: localize('dictation.showTranscript.description', 'Show the live transcript while speech is being recognized.') },
});

configurationRegistry.registerConfiguration<string>({
	key: 'dictation.language', defaultValue: 'auto', parse: parseLanguage,
});

configurationRegistry.registerConfiguration<'local' | 'cloud' | 'codex'>({
	key: 'dictation.backend',
	defaultValue: 'local',
	parse: parseBackend,
	setting: {
		valueType: 'select',
		title: localize({ bundle: 'ash', key: 'dictation.backend.title' }, 'Dictation service'),
		description: localize({ bundle: 'ash', key: 'dictation.backend.description' }, 'Choose local transcription, a cloud API, or your Codex subscription for voice input.'),
		options: [
			{ value: 'local', label: localize({ bundle: 'ash', key: 'dictation.backend.local' }, 'Local') },
			{ value: 'cloud', label: localize({ bundle: 'ash', key: 'dictation.backend.cloud' }, 'Cloud') },
			{ value: 'codex', label: localize({ bundle: 'ash', key: 'dictation.backend.codex' }, 'Codex subscription') },
		],
	},
});

configurationRegistry.registerConfiguration<'openAi' | 'xai'>({
	key: 'dictation.cloudProvider',
	defaultValue: 'openAi',
	parse: parseCloudProvider,
	setting: {
		valueType: 'select',
		title: localize({ bundle: 'ash', key: 'dictation.cloudProvider.title' }, 'Cloud dictation provider'),
		description: localize({ bundle: 'ash', key: 'dictation.cloudProvider.description' }, 'Choose the cloud transcription provider. Its API key is required.'),
		options: [
			{ value: 'openAi', label: 'OpenAI' },
			{ value: 'xai', label: 'xAI' },
		],
	},
});

configurationRegistry.registerConfiguration<string>({
	key: DICTATION_MODEL_SETTING,
	defaultValue: DEFAULT_LOCAL_TRANSCRIPTION_MODEL,
	parse: parseLocalModel,
	setting: {
		valueType: 'text',
		title: localize({ bundle: 'ash', key: 'dictation.model.title' }, 'Local dictation model'),
		description: localize({ bundle: 'ash', key: 'dictation.model.description' }, 'Model package ID in the Ash dictation-models directory.'),
		placeholder: DEFAULT_LOCAL_TRANSCRIPTION_MODEL,
	},
});

Registry.as<IConfigurationMigrationRegistry>(WorkbenchExtensions.ConfigurationMigration).registerConfigurationMigrations([{
	key: 'dictation.localModel',
	migrateFn(value, read) {
		const model = parseLocalModel(value);
		const target = read(DICTATION_MODEL_SETTING);
		if (target !== undefined && parseLocalModel(target) !== model) throw new Error(localize('dictation.modelMigrationConflict', 'Dictation model settings conflict. Keep the desired value in dictation.model and remove dictation.localModel.'));
		return target === undefined ? [[DICTATION_MODEL_SETTING, { value: model }], ['dictation.localModel', { value: undefined }]] : { value: undefined };
	},
}]);
