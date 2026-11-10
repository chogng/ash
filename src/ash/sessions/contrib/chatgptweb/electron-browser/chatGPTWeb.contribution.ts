import { Lxicon } from '../../../../base/common/lxicons.js';
import { isNonEmptyString, isRecord } from '../../../../base/common/types.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Menus } from '../../../browser/menus.js';
import { SESSIONS_GENERAL_SETTINGS_TAG } from '../../../common/configuration.js';
import { ActivityBarItemContext, SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { registerChatGPTAccessibility } from './chatGPTAccessibility.js';
import { registerChatGPTResponseActions } from './chatGPTResponseActions.js';
import { registerReplyChatEditor } from '../../chat/browser/replyChatEditor.js';
import { IChatGPTNativeTransport, IChatGPTTransport } from '../common/chatGPTTransport.js';
import { ElectronChatGPTNativeTransport, ElectronChatGPTTransport } from './electronChatGPTTransport.js';
import { ChatGPTDraftModelSource, ChatGPTExperimentalContribution, experimentalChatGPTEditor, ChatGPTWebContribution, chatGPTReplyEditor, chatGPTScrollOptimization, chatGPTSelectedContext, SESSIONS_CHATGPT_DEFAULT_BACKEND, SHOW_CHATGPT_COMMAND, SHOW_PREFERRED_CHATGPT_COMMAND } from './chatGPTWeb.js';
import { ChatGPTNativeService, ChatGPTService, IChatGPTNativeService, IChatGPTService } from '../browser/chatGPTService.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IAccountService } from '../../../../platform/accounts/common/accountService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService } from '../../../../platform/progress/common/progress.js';
import { signInChatGPT } from '../browser/chatGPTLogin.js';
import { ChatGPTList, ChatGPTNativeList } from './chatGPTList.js';
import { experimentalChatGPTSelected, SHOW_EXPERIMENTAL_CHATGPT } from '../common/chatGPTNative.js';
import { canUseAshModels } from './chatGPTWidgetModel.js';
import { OPEN_ASH_CHAT_WITH_MODEL_COMMAND } from '../../chat/common/constants.js';
import { openAshChatWithModel } from '../../chat/electron-browser/actions/newChatModelAction.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';
import { SessionsViewRegistry } from '../../../common/views.js';
import { chatGPTEntityDetailsActiveContext, chatGPTEntityDetailsContainerId, chatGPTEntityDetailsViewId, ChatGPTEntityDetails, ChatGPTEntityDetailsView, IChatGPTEntityDetails, registerChatGPTEntityDetailsAccessibility } from './chatGPTEntityDetails.js';

export const chatGPTWorkspaceSource = {
	catalog: new SyncDescriptor(ChatGPTList),
	additionalCatalog: new SyncDescriptor(ChatGPTNativeList),
	draftModels: new SyncDescriptor(ChatGPTDraftModelSource),
	accessibility: chatGPTReplyEditor.accessibility,
	openCommand: SHOW_PREFERRED_CHATGPT_COMMAND,
	createDraft: (commands: ICommandService, origin: unknown) => commands.executeCommand<void>(SHOW_PREFERRED_CHATGPT_COMMAND, origin, true),
};

registerSingleton(IChatGPTService, ChatGPTService, InstantiationType.Delayed);
registerSingleton(IChatGPTTransport, ElectronChatGPTTransport, InstantiationType.Delayed);
registerSingleton(IChatGPTNativeService, ChatGPTNativeService, InstantiationType.Delayed);
registerSingleton(IChatGPTNativeTransport, ElectronChatGPTNativeTransport, InstantiationType.Delayed);
registerSingleton(IChatGPTEntityDetails, ChatGPTEntityDetails, InstantiationType.Delayed);
const entityDetailsTitle = localize('sessions.chatgpt.entityDetails', 'Entity details');
SessionsViewRegistry.registerStaticViewContainer({
	id: chatGPTEntityDetailsContainerId, title: entityDetailsTitle, localizationKey: { bundle: 'ash', key: 'sessions.chatgpt.entityDetails' },
	location: ViewContainerLocation.AuxiliaryBar, hideIfEmpty: true,
});
SessionsViewRegistry.registerStaticViews(chatGPTEntityDetailsContainerId, [{
	id: chatGPTEntityDetailsViewId, title: entityDetailsTitle, localizationKey: { bundle: 'ash', key: 'sessions.chatgpt.entityDetails' },
	ctorDescriptor: new SyncDescriptor(ChatGPTEntityDetailsView), canToggleVisibility: false, when: ContextKeyExpr.has(chatGPTEntityDetailsActiveContext),
}]);
registerChatGPTEntityDetailsAccessibility();
registerReplyChatEditor(chatGPTReplyEditor);
registerReplyChatEditor(experimentalChatGPTEditor);
registerChatGPTResponseActions();
Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.ChatGPT, defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError('ChatGPT accessibility verbosity must be boolean'); }
		return value;
	},
	setting: {
		valueType: 'boolean', title: localize('sessions.chatgpt.navigationVerbosity', 'ChatGPT accessibility help'),
		description: localize('sessions.chatgpt.navigationVerbosityDescription', 'Announce how to open accessibility help when ChatGPT receives focus.'),
	},
});

registerChatGPTAccessibility(chatGPTReplyEditor.accessibility.focusContext, IChatGPTService);
registerChatGPTAccessibility(experimentalChatGPTEditor.accessibility.focusContext, IChatGPTNativeService, true);

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: chatGPTScrollOptimization, defaultValue: true, scope: ConfigurationScope.APPLICATION,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError('ChatGPT scrolling optimization must be boolean'); }
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('sessions.chatgpt.optimizeTitle', 'ChatGPT scrolling optimization'); },
		get description() { return localize('sessions.chatgpt.optimizeDescription', 'Experimentally skip offscreen rendering of completed ChatGPT replies. Turn off if scrolling or page content behaves unexpectedly.'); },
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<'chatgpt' | 'chatgptweb'>({
	key: SESSIONS_CHATGPT_DEFAULT_BACKEND,
	tags: [SESSIONS_GENERAL_SETTINGS_TAG],
	defaultValue: 'chatgpt',
	scope: ConfigurationScope.APPLICATION,
	parse(value: unknown) {
		if (value === 'chatgpt' || value === 'chatgptweb') return value;
		throw new TypeError('Expected chatgpt or chatgptweb for the default ChatGPT backend');
	},
	setting: {
		valueType: 'select',
		get title() { return localize('sessions.chatgpt.defaultBackend', 'Default ChatGPT entry'); },
		get description() { return localize('sessions.chatgpt.defaultBackendDescription', 'Choose which ChatGPT entry opens when you start a new chat. ChatGPT (Experimental) uses your existing Codex login.'); },
		get options() {
			return [
				{ value: 'chatgpt', label: localize('sessions.chatgpt.experimentalTitle', 'ChatGPT (Experimental)') },
				{ value: 'chatgptweb', label: localize('sessions.chatgpt.webTitle', 'ChatGPT Web') },
			] as const;
		},
	},
});

registerWorkbenchContribution(ChatGPTExperimentalContribution.ID, WorkbenchPhase.BlockRestore,
	services => services.get(IInstantiationService).createInstance(ChatGPTExperimentalContribution));

registerWorkbenchContribution(ChatGPTWebContribution.ID, WorkbenchPhase.BlockRestore,
	services => services.get(IInstantiationService).createInstance(ChatGPTWebContribution));

CommandsRegistry.register(OPEN_ASH_CHAT_WITH_MODEL_COMMAND, async (accessor, model: unknown) => {
	if (!isRecord(model) || !isNonEmptyString(model.provider) || !isNonEmptyString(model.model)) {
		throw new TypeError('Expected an Ash model reference');
	}
	const contextKeys = accessor.get(IContextKeyService);
	const configuration = accessor.get(IConfigurationService);
	const experimental = contextKeys.getValue(experimentalChatGPTSelected) === true;
	const selectedContext = experimental ? experimentalChatGPTSelected : chatGPTSelectedContext;
	const canOpen = () => contextKeys.getValue(SessionsWorkspaceModeContext.key) === 'chat'
		&& contextKeys.getValue(selectedContext) === true
		&& !configuration.getValue<boolean>('chat.disableAIFeatures');
	if (!canOpen()) return;
	const chat = accessor.get(experimental ? IChatGPTNativeService : IChatGPTService);
	const source = chat.state.get().localConversationId;
	const revision = chat.newDraftRevision;
	await openAshChatWithModel(accessor, { provider: model.provider, model: model.model }, () => {
		const state = chat.state.get();
		if (!canOpen() || state.localConversationId !== source || chat.newDraftRevision !== revision || !canUseAshModels(state)
			|| state.sending || state.managing || state.voice !== 'idle') return undefined;
		return state.draft;
	});
});

const chatNewSessionMenu = ContextKeyExpr.and(
	ActivityBarItemContext.isEqualTo('sessions.newSession'),
	ContextKeyExpr.notEquals(SessionsWorkspaceModeContext.key, 'code'),
);

registerAction2(class OpenChatGPT extends Action2 {
	constructor() {
		super({
			id: 'sessions.open.chatgpt', title: localize2('sessions.chatgpt.webTitle', 'ChatGPT Web'), icon: Lxicon.openai,
			toggled: ContextKeyExpr.has(chatGPTSelectedContext),
			menu: { id: Menus.ActivityBarContext, when: ContextKeyExpr.and(chatNewSessionMenu, ContextKeyExpr.has(experimentalChatGPTSelected)), group: 'navigation' },
			f1: true,
		});
	}
	public override async run(accessor: ServicesAccessor): Promise<void> { await accessor.get(ICommandService).executeCommand(SHOW_CHATGPT_COMMAND); }
});

registerAction2(class OpenExperimentalChatGPT extends Action2 {
	constructor() {
		super({
			id: 'sessions.open.experimentalChatgpt',
			title: localize2('sessions.chatgpt.experimentalTitle', 'ChatGPT (Experimental)'),
			icon: Lxicon.openai,
			precondition: ContextKeyExpr.not('config.chat.disableAIFeatures'),
			menu: {
				id: Menus.ActivityBarContext,
				when: ContextKeyExpr.and(chatNewSessionMenu, ContextKeyExpr.not(experimentalChatGPTSelected)),
				group: 'navigation',
			},
			f1: true,
		});
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand(SHOW_EXPERIMENTAL_CHATGPT);
	}
});

registerAction2(class ToggleChatGPTScrolling extends Action2 {
	constructor() {
		super({ id: 'sessions.chatgpt.toggleScrollOptimization', title: localize2('sessions.chatgpt.toggleOptimization', 'ChatGPT: Toggle Scrolling Optimization'), f1: true });
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const configuration = accessor.get(IConfigurationService);
		await configuration.updateValue(chatGPTScrollOptimization, !configuration.getValue<boolean>(chatGPTScrollOptimization));
	}
});

registerAction2(class ReloadChatGPT extends Action2 {
	constructor() {
		super({
			id: 'sessions.chatgpt.reload',
			title: localize2('sessions.chatgpt.reload', 'ChatGPT: Reload'),
			shortTitle: localize2('sessions.chatgpt.reloadShort', 'Reload'),
			menu: {
				id: Menus.ActivityBarContext,
				when: ContextKeyExpr.and(chatNewSessionMenu, ContextKeyExpr.or(ContextKeyExpr.has(chatGPTSelectedContext), ContextKeyExpr.has(experimentalChatGPTSelected))),
				group: 'navigation',
			},
			f1: true,
		});
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const experimental = accessor.get(IContextKeyService).getValue(experimentalChatGPTSelected) === true;
		await accessor.get(experimental ? IChatGPTNativeService : IChatGPTService).reload();
	}
});

const authenticationMenu = {
	id: Menus.ActivityBarContext,
	when: ContextKeyExpr.and(chatNewSessionMenu, ContextKeyExpr.has(chatGPTSelectedContext)),
	group: 'authentication',
};

registerAction2(class SignInChatGPT extends Action2 {
	constructor() {
		super({ id: 'sessions.chatgpt.signIn', title: localize2('sessions.chatgpt.signIn', 'ChatGPT: Sign In to Ash'), f1: true, menu: authenticationMenu });
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		await signInChatGPT(accessor.get(IAccountService), accessor.get(INotificationService), accessor.get(IProgressService));
	}
});

registerAction2(class UseCodexChatGPTLogin extends Action2 {
	constructor() {
		super({ id: 'sessions.chatgpt.useCodexLogin', title: localize2('sessions.chatgpt.useCodexLogin', 'ChatGPT: Use Codex Login'), f1: true, menu: authenticationMenu });
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IAccountService).startLogin({ type: 'chatGptWebCodex' });
	}
});

registerAction2(class SignOutChatGPT extends Action2 {
	constructor() {
		super({ id: 'sessions.chatgpt.signOut', title: localize2('sessions.chatgpt.signOut', 'ChatGPT: Sign Out of Ash'), f1: true, menu: authenticationMenu });
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IAccountService).logout('chatgpt-web');
	}
});
