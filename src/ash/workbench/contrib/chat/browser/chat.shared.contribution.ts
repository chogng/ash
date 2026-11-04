import './promptTimeline/promptTimeline.contribution.js';
import { BtwSlashCommandContribution } from './btwSlashCommand.js';
import './contextContrib/chatContext.contribution.js';
import { ChatSideChatProvider } from './chatSideChatProvider.js';
import { IChatSideChatService, ChatSideChatService } from '../common/chatSideChatService.js';
import { IChatSlashCommandService, ChatSlashCommandService } from '../common/participants/chatSlashCommands.js';
import { ChatQueuePickerRendering } from './widget/input/chatQueuePickerActionItem.js';
import { PanelChatAccessibilityHelp } from './actions/chatAccessibilityHelp.js';
import { registerChatExportActions } from './actions/chatImportExport.js';
import { registerChatSpeechToTextActions } from './actions/chatSpeechToTextActions.js';
import { registerChatDeveloperActions } from './actions/chatDeveloperActions.js';
import { AgentPluginsBrowseCommand } from './agentPluginsView.js';
import { UpdateAgentPluginsCommand } from './agentPluginCommands.js';
import { registerCreatePluginAction } from './actions/createPluginAction.js';
import { registerLanguageModelActions } from './actions/chatLanguageModelActions.js';
import { registerConfigureSpeechInstructionsActions } from './actions/configureVoiceInstructionsAction.js';
import { registerChatModelFeedbackSurveyActions } from './actions/chatModelFeedbackSurveyActions.js';
import { registerChatFileTreeActions } from './actions/chatFileTreeActions.js';
import { registerNewChatActions } from './actions/chatNewActions.js';
import { ExportAgentHostDebugLogsAction } from './actions/exportAgentHostDebugLogsAction.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ChatContextContributions } from './actions/chatContext.js';
import { IChatLayoutService } from '../common/widget/chatLayoutService.js';
import { ChatLayoutService } from './widget/chatLayoutService.js';
import { registerChatCopyActions } from './actions/chatCopyActions.js';
import { registerChatApprovalEnvironmentActions } from './actions/chatApprovalEnvironmentActions.js';
import { registerChatCodeBlockActions } from './actions/chatCodeblockActions.js';
import { registerChatToolActions } from './actions/chatToolActions.js';
import { registerChatTitleActions } from './actions/chatTitleActions.js';
import { registerChatElicitationActions } from './actions/chatElicitationActions.js';
import { registerChatExecuteActions } from './actions/chatExecuteActions.js';
import { registerChatQueueActions } from './actions/chatQueueActions.js';
import { registerChatPromptNavigationActions } from './actions/chatPromptNavigationActions.js';
import { registerChatAccessibilityActions } from './actions/chatAccessibilityActions.js';
import { registerChatFindActions } from './actions/chatFindActions.js';
import { ChatFindAccessibilityHelp } from './widget/chatFind/chatFindAccessibilityHelp.js';
import { isHTMLElement } from '../../../../base/browser/dom.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { registerEditorPane } from '../../../browser/editor.js';
import type { ChatDebugEditor } from './chatDebug/chatDebugEditor.js';
import { chatDebugEditorId } from './chatDebug/chatDebugEditorInput.js';
import { registerChatChangesActions } from './chatEditing/chatEditingActions.js';
import { registerAgentSessionActions } from './agentSessions/agentSessionsActions.js';
import { Extensions as WorkbenchExtensions, type IConfigurationMigrationRegistry } from '../../../common/configuration.js';
import { DEFAULT_LOCAL_TRANSCRIPTION_MODEL } from '../../../../platform/localTranscription/common/localTranscription.js';
import { parseBackend, parseLocalModel, parseCloudProvider, parseInputDevice, parseLanguage } from '../common/constants.js';
import { IChatSpeechToTextService, ChatSpeechToTextService, DICTATION_MODEL_SETTING } from './speechToText/chatSpeechToTextService.js';
import { IVoiceCodeTranscriptionClient, VoiceCodeTranscriptionClient } from './speechToText/voiceCodeTranscriptionClient.js';
import { IVoiceInputModeService, VoiceInputModeService } from './voiceInputMode/voiceInputMode.js';
import { IChatContextPickService, ChatContextPickService } from './attachments/chatContextPickService.js';
import { ChatAttachmentResolveService, IChatAttachmentResolveService } from './attachments/chatAttachmentResolveService.js';
import { ChatPasteTargetService } from './attachments/chatPasteTargetService.js';
import { IChatPasteTargetService } from './chat.js';
import { ChatContextKeys } from '../common/actions/chatContextKeys.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { agentsWindowGraphicConfiguration, ChatConfiguration, ChatInputConfiguration, ChatEditorConfiguration, autoAcceptDelaySetting } from '../common/constants.js';
import { AGENT_SESSIONS_PRESENTATION_SETTING, AgentSessionsPresentation } from '../common/chat.js';
import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILanguageModelToolsService } from '../common/tools/languageModelToolsService.js';
import { LanguageModelToolsService } from './tools/languageModelToolsService.js';
import { IChatWidgetService } from './chat.js';
import { SubscriptionUsageSettingsModel } from './subscriptionUsageSettingsModel.js';
import { ChatUsageSettingsModel } from './chatUsageSettingsModel.js';
import { registerSettingsSection } from '../../../services/preferences/browser/settingsSections.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ChatWidgetService } from './widget/chatWidgetService.js';
import { IQuickChatService } from './chat.js';
import { QuickChatService } from './widgetHosts/chatQuick.js';
import { registerQuickChatActions } from './actions/chatQuickInputActions.js';
import { CopyTextProvider } from './widget/input/editor/chatPasteProviders.js';
import { ChatAttachmentWidgetRegistry, IChatAttachmentWidgetRegistry } from './attachments/chatAttachmentWidgetRegistry.js';
import { ChatReferenceAttachmentWidgetContribution } from './attachments/chatReferenceAttachmentWidget.contribution.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import './chatManagement/chatManagement.contribution.js';
import { IChatEditingService } from '../common/editing/chatEditingService.js';
import './chatEditing/chatEditingEditorActions.js';
import { CodeMapperService, ICodeMapperService } from '../common/editing/chatCodeMapperService.js';
import { ChatEditingService } from './chatEditing/chatEditingServiceImpl.js';
import { DictationOnboardingService, IDictationOnboardingService } from './speechToText/dictationOnboarding.js';
import { ChatInputNoticeHubService, IChatInputNoticeHubService } from './widget/input/chatInputNoticeHub.js';
import { ChatInputNotificationService, IChatInputNotificationService } from './widget/input/chatInputNotificationService.js';
import { ChatInputEditor } from './widget/input/chatInputEditor.js';
import { ChatInputEditors } from './widget/input/chatInputEditorRegistry.js';
import { IChatDebugService } from '../common/chatDebugService.js';
import { AppServerChatDebugService } from './chatDebug/appServerChatDebugService.js';
import { ChatResponseResourceFileSystemProvider, ChatResponseResourceWorkbenchContribution, IChatResponseResourceFileSystemProvider } from '../common/widget/chatResponseResourceFileSystemProvider.js';
import { ChatEditingEditorOverlay } from './chatEditing/chatEditingEditorOverlay.js';
import { PromptLanguageFeaturesProvider } from './promptSyntax/promptFileContributions.js';
import { registerPromptActions } from './promptSyntax/promptFileActions.js';
import { registerSkillActions } from './promptSyntax/skillActions.js';
import { registerRunPromptActions } from './promptSyntax/runPromptAction.js';
import { registerAgentActions } from './promptSyntax/chatModeActions.js';
import { registerNewPromptFileActions } from './promptSyntax/newPromptFileActions.js';
import { ChatSetupContribution } from './chatSetup/chatSetupContributions.js';
import { ChatEntitlementService, IChatEntitlementService } from '../../../services/chat/common/chatEntitlementService.js';

import { ChatSessionArchiveActionWording, ChatSessionArchiveActionWordingSettingId } from '../../../../platform/chat/common/sessionArchiveActions.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { chatUpvoteAnimationConfiguration } from '../common/chatResponseFeedback.js';

import { ChatStatusBarEntry } from './chatStatus/chatStatusEntry.js';
// Both renderer hosts use these primitives; each host owns session navigation and History actions.
registerSingleton(IChatEditingService, ChatEditingService, InstantiationType.Delayed);
registerSingleton(ICodeMapperService, CodeMapperService, InstantiationType.Delayed);
registerSingleton(IDictationOnboardingService, DictationOnboardingService, InstantiationType.Delayed);
registerSingleton(IVoiceInputModeService, VoiceInputModeService, InstantiationType.Delayed);
registerSingleton(IChatInputNoticeHubService, ChatInputNoticeHubService, InstantiationType.Delayed);
registerSingleton(IChatInputNotificationService, ChatInputNotificationService, InstantiationType.Delayed);
registerSingleton(IChatDebugService, AppServerChatDebugService, InstantiationType.Delayed);
registerSingleton(IChatResponseResourceFileSystemProvider, ChatResponseResourceFileSystemProvider, InstantiationType.Delayed);
registerWorkbenchContribution(ChatResponseResourceWorkbenchContribution.ID, WorkbenchPhase.BlockStartup, accessor => accessor.get(IInstantiationService).createInstance(ChatResponseResourceWorkbenchContribution));
registerWorkbenchContribution(ChatEditingEditorOverlay.ID, WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(ChatEditingEditorOverlay));
registerWorkbenchContribution(PromptLanguageFeaturesProvider.ID, WorkbenchPhase.BlockStartup, accessor => accessor.get(IInstantiationService).createInstance(PromptLanguageFeaturesProvider));
registerWorkbenchContribution('chat.promptActions', WorkbenchPhase.BlockStartup, () => registerPromptActions());
registerWorkbenchContribution('chat.skillActions', WorkbenchPhase.BlockStartup, () => registerSkillActions());
registerWorkbenchContribution('chat.runPromptActions', WorkbenchPhase.BlockStartup, () => registerRunPromptActions());
registerWorkbenchContribution('chat.agentActions', WorkbenchPhase.BlockStartup, () => registerAgentActions());
registerWorkbenchContribution('chat.newPromptFileActions', WorkbenchPhase.BlockStartup, () => registerNewPromptFileActions());
registerWorkbenchContribution('workbench.contrib.chatInputEditor', WorkbenchPhase.BlockStartup, accessor => {
	const instantiationService = accessor.get(IInstantiationService);
	return ChatInputEditors.register({ id: 'stanza', create: options => instantiationService.createInstance(ChatInputEditor, options) });
});

registerSingleton(IChatSpeechToTextService, ChatSpeechToTextService, InstantiationType.Delayed);
registerSingleton(IVoiceCodeTranscriptionClient, VoiceCodeTranscriptionClient, InstantiationType.Delayed);
registerSingleton(IChatWidgetService, ChatWidgetService, InstantiationType.Delayed);
registerSingleton(IChatLayoutService, ChatLayoutService, InstantiationType.Delayed);
registerSettingsSection({
	id: 'chat.subscriptionUsage', categoryId: 'chat-usage', model: new SyncDescriptor(SubscriptionUsageSettingsModel),
	accessibleViewProviderId: AccessibleViewProviderId.ChatUsage,
	accessibilityVerbositySettingId: AccessibilityVerbositySettingId.ChatUsage,
});
registerSettingsSection({
	id: 'chat.usage', categoryId: 'chat-usage', model: new SyncDescriptor(ChatUsageSettingsModel),
	accessibleViewProviderId: AccessibleViewProviderId.ChatUsage,
	accessibilityVerbositySettingId: AccessibilityVerbositySettingId.ChatUsage,
});
registerSingleton(IQuickChatService, QuickChatService, InstantiationType.Delayed);
registerQuickChatActions();
registerChatFindActions();
registerChatPromptNavigationActions();
registerChatExecuteActions();
registerChatSpeechToTextActions();
registerChatDeveloperActions();
registerAction2(AgentPluginsBrowseCommand);
registerAction2(UpdateAgentPluginsCommand);
registerCreatePluginAction();
registerLanguageModelActions();
registerConfigureSpeechInstructionsActions();
registerChatModelFeedbackSurveyActions();
registerChatFileTreeActions();
registerNewChatActions();
registerAction2(ExportAgentHostDebugLogsAction);
registerChatToolActions();
registerChatTitleActions();
registerChatExportActions();
registerChatCopyActions();
registerChatApprovalEnvironmentActions();
registerChatCodeBlockActions();
registerChatElicitationActions();
registerSingleton(IChatSideChatService, ChatSideChatService, InstantiationType.Delayed);
registerSingleton(IChatSlashCommandService, ChatSlashCommandService, InstantiationType.Delayed);
registerWorkbenchContribution(BtwSlashCommandContribution.ID, WorkbenchPhase.BlockStartup, accessor => accessor.get(IInstantiationService).createInstance(BtwSlashCommandContribution));
registerWorkbenchContribution(ChatSideChatProvider.ID, WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(ChatSideChatProvider));
registerChatQueueActions();
registerWorkbenchContribution(ChatQueuePickerRendering.ID, WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(ChatQueuePickerRendering));
registerChatAccessibilityActions();
AccessibleViewRegistry.register(new ChatFindAccessibilityHelp());
AccessibleViewRegistry.register(new PanelChatAccessibilityHelp());

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<AgentSessionsPresentation>({
	key: AGENT_SESSIONS_PRESENTATION_SETTING,
	defaultValue: AgentSessionsPresentation.Tabs,
	scope: ConfigurationScope.WINDOW,
	schema: { type: 'string', enum: Object.values(AgentSessionsPresentation) },
	parse(value: unknown): AgentSessionsPresentation {
		if (value === AgentSessionsPresentation.Tabs || value === AgentSessionsPresentation.List) return value;
		throw new TypeError(localize('chat.sessions.presentation.invalid', 'Invalid session display mode.'));
	},
	setting: {
		title: localize('chat.sessions.presentation.title', 'Session display'),
		description: localize('chat.sessions.presentation.description', 'Show opened sessions as tabs or switch conversations using a list. The list opens beside Chat when there is enough width.'),
		valueType: 'select',
		options: [
			{ value: AgentSessionsPresentation.Tabs, label: localize('chat.sessions.presentation.tabs', 'Tabs') },
			{ value: AgentSessionsPresentation.List, label: localize('chat.sessions.presentation.list', 'List') },
		],
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<'stacked' | 'sideBySide'>({
	key: ChatConfiguration.ChatViewSessionsOrientation,
	defaultValue: 'sideBySide',
	scope: ConfigurationScope.WINDOW,
	schema: { type: 'string', enum: ['stacked', 'sideBySide'] },
	parse(value: unknown): 'stacked' | 'sideBySide' {
		if (value === 'stacked' || value === 'sideBySide') return value;
		throw new TypeError(localize('chat.sessions.orientation.invalid', 'Invalid session list orientation.'));
	},
	setting: {
		title: localize('chat.sessions.orientation.title', 'Session list layout'),
		description: localize('chat.sessions.orientation.description', 'Show the session list above Chat or beside it when there is enough width.'),
		valueType: 'select',
		options: [
			{ value: 'stacked', label: localize('chat.sessions.orientation.stacked', 'Stacked') },
			{ value: 'sideBySide', label: localize('chat.sessions.orientation.sideBySide', 'Side by Side') },
		],
	},
});

Registry.as<IConfigurationMigrationRegistry>(WorkbenchExtensions.ConfigurationMigration).registerConfigurationMigrations([{
	key: ChatConfiguration.ChatViewSessionsOrientation,
	migrateFn(value, read) {
		if (value !== 'auto' && value !== 'stacked' && value !== 'sideBySide') return { value };
		// The old orientation also selected List mode; retain valid direction choices.
		const updates: [string, { value: unknown; }][] = [];
		if (read(AGENT_SESSIONS_PRESENTATION_SETTING) === undefined) updates.push([AGENT_SESSIONS_PRESENTATION_SETTING, { value: AgentSessionsPresentation.List }]);
		if (value === 'auto') updates.push([ChatConfiguration.ChatViewSessionsOrientation, { value: undefined }]);
		return updates;
	},
}]);
registerSingleton(IChatContextPickService, ChatContextPickService, InstantiationType.Delayed);
registerWorkbenchContribution(ChatContextContributions.ID, WorkbenchPhase.BlockStartup, accessor => accessor.get(IInstantiationService).createInstance(ChatContextContributions));
registerSingleton(IChatAttachmentResolveService, ChatAttachmentResolveService, InstantiationType.Delayed);
registerSingleton(IChatPasteTargetService, ChatPasteTargetService, InstantiationType.Delayed);
registerSingleton(IChatAttachmentWidgetRegistry, ChatAttachmentWidgetRegistry, InstantiationType.Delayed);

registerWorkbenchContribution(ChatReferenceAttachmentWidgetContribution.ID, WorkbenchPhase.BlockStartup, accessor =>
	accessor.get(IInstantiationService).createInstance(ChatReferenceAttachmentWidgetContribution));

registerSingleton(ILanguageModelToolsService, LanguageModelToolsService, InstantiationType.Delayed);

// Copy can happen before any composer exists. Its prepared clipboard data belongs
// to the window; receiving paste providers remain owned by each live input.
registerWorkbenchContribution('workbench.contrib.chatCopyText', WorkbenchPhase.BlockStartup, accessor => {
	return accessor.get(ILanguageFeaturesService).documentPasteEditProvider.register(
		{ scheme: '*', hasAccessToAllModels: true },
		accessor.get(IInstantiationService).createInstance(CopyTextProvider),
	);
});

registerSingleton(IChatEntitlementService, ChatEntitlementService, InstantiationType.Delayed);
registerWorkbenchContribution(ChatStatusBarEntry.ID, WorkbenchPhase.BlockRestore,
	accessor => accessor.get(IInstantiationService).createInstance(ChatStatusBarEntry));
registerWorkbenchContribution(ChatSetupContribution.ID, WorkbenchPhase.BlockStartup,
	accessor => accessor.get(IInstantiationService).createInstance(ChatSetupContribution));

const configurationRegistry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
configurationRegistry.registerConfiguration(agentsWindowGraphicConfiguration);
configurationRegistry.registerConfiguration(chatUpvoteAnimationConfiguration);

configurationRegistry.registerConfiguration<boolean>({
	key: ChatConfiguration.TipsEnabled,
	defaultValue: true,
	scope: ConfigurationScope.APPLICATION,
	schema: { type: 'boolean' },
	parse(value: unknown): boolean {
		if (typeof value === 'boolean') { return value; }
		throw new TypeError(localize('chat.tips.enabled.invalid', 'The Chat tips setting must be a boolean.'));
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('chat.tips.enabled.title', 'Show Chat tips'); },
		get description() { return localize('chat.tips.enabled.description', 'Show tips in new Code conversations in the Agents window.'); },
	},
});

configurationRegistry.registerConfiguration<boolean>({
	key: ChatConfiguration.AutoExpandToolFailures,
	defaultValue: true,
	scope: ConfigurationScope.WINDOW,
	schema: { type: 'boolean' },
	parse(value: unknown): boolean {
		if (typeof value === 'boolean') { return value; }
		throw new TypeError(localize('chat.tools.autoExpandFailuresInvalid', 'Expand failed command output must be a boolean.'));
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('chat.tools.autoExpandFailuresTitle', 'Expand failed command output'); },
		get description() { return localize('chat.tools.autoExpandFailures', 'Automatically expand terminal tool failures to show their error details.'); },
	},
});

configurationRegistry.registerConfiguration<'queue' | 'steer'>({
	key: ChatConfiguration.RequestQueueingDefaultAction,
	defaultValue: 'steer',
	scope: ConfigurationScope.WINDOW,
	schema: { type: 'string', enum: ['queue', 'steer'] },
	parse(value: unknown): 'queue' | 'steer' {
		if (value === 'queue' || value === 'steer') return value;
		throw new TypeError(localize('chat.queuePicker.invalidDefault', 'Choose queue or steer for follow-up messages.'));
	},
	setting: {
		valueType: 'select',
		get title() { return localize('chat.queuePicker.defaultTitle', 'Follow-up message action'); },
		get description() { return localize('chat.queuePicker.defaultDescription', 'Choose what Enter and the send button do while a task is running. Hold Alt to use the other action.'); },
		get options() {
			return [
				{ value: 'queue' as const, label: localize('chat.queuePicker.queue', 'Add to Queue') },
				{ value: 'steer' as const, label: localize('chat.queuePicker.steer', 'Steer with Message') },
			];
		},
	},
});

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
	defaultValue: ChatSessionArchiveActionWording.Archive,
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

/** Message typography leaves composer and code-editor preferences independent. */
configurationRegistry.registerConfiguration<string>({
	key: ChatConfiguration.FontFamily, defaultValue: 'default', scope: ConfigurationScope.WINDOW,
	schema: { type: 'string', maxLength: 256, pattern: '^[^\\r\\n\\u0000]*$' },
	parse(value: unknown): string {
		if (typeof value === 'string' && value.length <= 256 && !/[\r\n\0]/u.test(value)) return value;
		throw new TypeError(localize('chat.fontFamily.invalid', 'Message font must be a single-line string no longer than 256 characters.'));
	},
	setting: {
		valueType: 'text',
		get title() { return localize('chat.fontFamily.title', 'Font family'); },
		get description() { return localize('chat.fontFamily.description', 'Set the font for chat messages, including Markdown and link text. Use default or leave empty to follow the interface font. Input and code-block fonts are configured separately.'); },
		get placeholder() { return localize('chat.fontFamily.default', 'Interface font'); },
	},
});
configurationRegistry.registerConfiguration<number>({
	key: ChatConfiguration.FontSize, defaultValue: 13, agentsWindow: { default: 14 }, scope: ConfigurationScope.WINDOW,
	schema: { type: 'number', minimum: 6, maximum: 100 },
	parse(value: unknown): number {
		if (typeof value === 'number' && Number.isFinite(value) && value >= 6 && value <= 100) return value;
		throw new RangeError(localize('chat.fontSize.invalid', 'Message font size must be a number between 6 and 100.'));
	},
	setting: {
		valueType: 'number', minimum: 6, maximum: 100,
		get title() { return localize('chat.fontSize.title', 'Font size'); },
		get description() { return localize('chat.fontSize.description', 'Set the base text size in pixels for chat messages. Markdown headings keep their size hierarchy. Input and code-block sizes are configured separately.'); },
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
	agentsWindow: { default: 0 },
	scope: ConfigurationScope.APPLICATION,
	schema: { anyOf: [{ const: 0 }, { type: 'integer', minimum: 8, maximum: 80 }] },
	parse(value: unknown): number {
		if (typeof value === 'number' && Number.isInteger(value) && (value === 0 || value >= 8 && value <= 80)) return value;
		throw new RangeError(localize('chat.input.lineHeight.invalid', 'Chat input line height must be 0 or an integer between 8 and 80.'));
	},
	setting: {
		valueType: 'number', minimum: 0, maximum: 80,
		get title() { return localize('chat.input.lineHeight.title', 'Line height'); },
		get description() { return localize('chat.input.lineHeight.description', 'Set the message input line height in pixels. Use 0 to calculate it from the font size.'); },
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

registerAgentSessionActions();

registerChatChangesActions();

registerEditorPane({
	id: chatDebugEditorId,
	name: localize('chatDebugInputName', 'Agent Debug Logs'),
	canOpen: input => input.resource.scheme === 'ash-agent-trace' ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: async options => {
		if (!options.instantiationService) { throw new Error('Execution Trace requires Workbench services'); }
		const { ChatDebugEditor } = await import('./chatDebug/chatDebugEditor.js');
		return options.instantiationService.createInstance(ChatDebugEditor);
	},
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type,
		name: `agentTrace.${type}`,
		priority: 100,
		when: ContextKeyExpr.has('agentTraceFocused'),
		getProvider: accessor => {
			const activePane = accessor.get(IEditorPart).activePane;
			if (activePane?.id !== chatDebugEditorId) { return undefined; }
			const pane = activePane as ChatDebugEditor;
			const focused = accessor.get(ILayoutService).mainContainer.ownerDocument.activeElement;
			return new AccessibleContentProvider(AccessibleViewProviderId.AgentTrace, { type },
				() => type === AccessibleViewType.View ? pane.getAccessibleContent() : localize('agentTrace.helpText', 'Agent Debug Logs\nRead the selected conversation’s saved execution history. Threads contain Turns and execution events; child Threads are nested beneath their parent. Events preserve each Thread’s sequence. A targeted opening selects the requested Thread, Turn or event after its history loads; a missing target is reported. Display filters keep the located event’s details and report when it is hidden. Tab moves between search, the execution tree and detail tabs. Arrow keys, Home and End navigate the tree; Left and Right collapse or expand it. Detail tabs activate with Enter or Space. Overview is the default; Raw record opens a readonly editor on demand. Errors only shows failed Turns, model calls and tool results. Filtering searches identifiers and event contents. Refresh reads newer durable events. Enable request evidence in Execution trace settings, then restart the owning App Server. Model attempts include failures, cancellations and partial output. Input and Output load the selected saved body on demand; choose a body section to read it. Core requests and materialized requests remain distinct, as do complete responses and partial output. Requests are semantic ModelService input, not HTTP bytes. Relations follows recorded model, tool, Code Mode, terminal and child-agent links. More Actions contains Import, Export and Help. Accessible View includes filtered events outside the mounted tree viewport. Model evidence is placed at its recorded Thread prefix when available. Child Threads keep their own sequence. Relations also shows saved child result returns and joins; result-to-model input links require the loaded Core request body. Unknown associations stay unknown. Hiding or closing the editor stops polling and releases subscriptions. Export freezes all loaded events when clicked, including events hidden by the filter. Relationships exclude events and causal evidence outside that capture, with omissions listed in graph warnings. Only one export runs at a time. The last selected import wins even if an earlier file finishes later. Import opens a version 3 rollout trace from an evaluation or another saved capture. Closing the editor releases its live subscriptions. <keybinding:editor.action.accessibleView> reads the trace; Escape closes this help.') + '\n' + localize('chatDebug.navigationHelp', 'Home lists saved sessions from the current backend catalog. Search by title or Session ID and activate a session with Enter. Debug Views switches between Overview, Logs, Flow Chart and Cache Explorer. Flow Chart uses saved relationships; filter text is shared with Logs. Tab reaches graph nodes, Enter opens their saved event in Logs, and zoom controls change the graph scale. Cache Explorer compares requests from the same Thread and evidence boundary; Core and materialized requests are separate. Show Request in Logs locates the selected request. Missing or omitted request bodies stay unavailable. Refresh retries a failed request body read. Imports never read live payloads. Changed semantic requests do not establish a provider cache miss. Home and editor hiding release the previous live subscriptions.') + '\n' + localize('chatDebug.wireHelp', 'Wire Log records raw JSON-RPC frames on the selected App Server connection, including other sessions. Start New Capture begins a backend memory capture. Stop Capture freezes it; leaving the view also stops capture. A new capture replaces the stopped one, and disconnect clears it. Filter by method, type or ID, and choose the request direction. Tab reaches calls; Enter displays the original request and its paired response, latency and errors. Responses outside the capture remain unpaired. Frame truncation and dropped older frames are reported. Accessible View includes matching calls beyond Show More Frames. Imported traces never acquire live Wire Log frames.') + '\n' + localize('chatDebug.inspectionHelp', 'Session locations accept viewHint and filter; reopening preserves the target view and filter. Overview shows current backend session details; Reveal Chat Session opens Chat through its existing navigation owner. Logs supports Tree View and List View over the same event identities, Expand All, Collapse All and Copy Selected Row. These do not change backend history. Compare in Diff Editor opens an on-demand readonly request comparison within the same evidence boundary; hiding releases its computation and text models. Wire Log shows requests, error frames, unanswered calls in the capture and the slowest paired call. Export stops backend recording and reads every retained frame; display filters do not affect exports, and truncation and drop metadata are preserved.') + '\n' + localize('chatDebug.filterHelp', 'Use commas for alternative text terms and !term to exclude text. Use thread:ID and turn:ID for exact identities. after:YYYY-MM-DD and before:YYYY-MM-DD use inclusive UTC days; ISO timestamps require a time zone. Kind buttons independently show or hide models, tools, agents and other events. Clear filters restores all events. Capture overview is independent of display filters. Each token subtotal shows reported-call coverage; unknown is different from zero. Cached input is included in input tokens. Old imports without a matching backend overview show unknown metrics. In narrow windows, expanding the overview shows it with the event tree; choosing an event restores its details.') + '\n' + localize('chatDebug.timingHelp', 'Client timing starts at each model call. First text latency counts the first nonempty body delta, excluding reasoning, metadata and completed snapshots. Generation lasts from first text to call completion and includes transport and local processing. Text TPS estimates non-reasoning output tokens divided by generation duration, not server decode speed; single-chunk responses, tool calls, failures and missing details show unknown. Performance values and unknown reasons are produced by the backend and preserved in exports. Old captures without performance projections stay unknown; the viewer does not recalculate them.'),
				() => { if (isHTMLElement(focused) && focused.isConnected) { focused.focus(); } else { pane.focus(); } }, AccessibilityVerbositySettingId.AgentTrace);
		},
	});
}
