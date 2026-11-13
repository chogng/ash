import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { NewChatInSessionsWindowAction, NewSessionFromNavigationAction } from './newSessionAction.js';
import { NewSessionFolderQuickPickAction } from './newSessionFolderQuickPickAction.js';
import { OpenSessionLinkOpenerContribution } from './openSessionLinkOpener.contribution.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { SessionSideChatEditor } from './sessionSideChatEditor.js';
import { SessionSideChatEditorInput } from './sessionSideChatEditorInput.js';
import './agentHostDelegation.js';
import './chatRunAnotherVersionActions.js';
import './chatCompareResultsActions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ChatViewFactory, IChatViewFactory } from './chatViewFactory.js';
import { ISessionsChatViewStateService, SessionsChatViewStateService } from './chatViewStateService.js';
import { AGENT_SESSIONS_SCOPED_INPUT_HISTORY_SETTING } from './sessionsChatHistory.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize, localize2 } from '../../../../nls.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { NEW_SESSION_WELCOME_MESSAGES_SETTING, NEW_SESSION_WELCOME_NAME_SETTING, NEW_SESSION_WELCOME_PHRASES_SETTING, OPEN_CHAT_CREATION_COMMAND_ID } from '../common/constants.js';

import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { isChatCreationKind } from '../../../common/chatCreation.js';
import { parseSessionIdentity } from '../../../services/sessions/common/sessionIdentity.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IChatTipService } from '../../../../workbench/contrib/chat/browser/chatTipService.js';

import { ChatInputArtifactPill } from './chatInputArtifactPill.js';
import { SessionsChatCopyActionRendering } from './chatCopyActionRendering.js';
import { NativeChatModelPreferences } from '../common/nativeChatModelPreferences.js';
import { INativeChatModelPreferencesService } from '../common/nativeChatModelPreferencesService.js';
import { NativeChatModelPreferencesService } from './nativeChatModelPreferencesService.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';

registerWorkbenchContribution(SessionsChatCopyActionRendering.ID, WorkbenchPhase.BlockStartup, accessor => accessor.get(IInstantiationService).createInstance(SessionsChatCopyActionRendering));

registerSingleton(IChatViewFactory, ChatViewFactory, InstantiationType.Delayed);
registerSingleton(ISessionsChatViewStateService, SessionsChatViewStateService, InstantiationType.Delayed);
registerSingleton(INativeChatModelPreferencesService, new SyncDescriptor(NativeChatModelPreferencesService, [NativeChatModelPreferences], true));

registerAction2(NewChatInSessionsWindowAction);
registerAction2(NewSessionFromNavigationAction);
registerAction2(NewSessionFolderQuickPickAction);

CommandsRegistry.register(OPEN_CHAT_CREATION_COMMAND_ID, async (accessor, kind) => {
	if (!isChatCreationKind(kind)) {
		throw new TypeError(localize('sessions.creator.invalidMode', 'Invalid Artifacts document mode.'));
	}
	const widgets = accessor.get(IChatWidgetService);
	const commands = accessor.get(ICommandService);
	const inCode = accessor.get(IContextKeyService).getValue(SessionsWorkspaceModeContext.key) === 'code';
	if (inCode && CommandsRegistry.hasCommand('sessions.open.new')) {
		await commands.executeCommand('sessions.open.new');
	} else {
		if (inCode) await commands.executeCommand('sessions.open.chat');
		await commands.executeCommand('sessions.newSession');
	}
	const input = widgets.lastFocusedWidget?.input;
	if (input) ChatInputArtifactPill.select(input, kind);
});

registerAction2(class ResetDismissedTipsAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.resetDismissedTips',
			title: localize2('chat.tip.resetDismissed', 'Reset Dismissed Tips'),
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IChatTipService).clearDismissedTips();
	}
});

// The window's host-aware opener must take precedence over the ambient Workbench opener.
registerWorkbenchContribution(OpenSessionLinkOpenerContribution.ID, WorkbenchPhase.BlockRestore,
	accessor => accessor.get(IInstantiationService).createInstance(OpenSessionLinkOpenerContribution));

registerEditorPane({
	id: SessionSideChatEditor.ID,
	name: localize({ bundle: 'ash', key: 'sessions.layout.sideChat' }, 'Side Chat'),
	canOpen: input => input instanceof SessionSideChatEditorInput ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => options.instantiationService!.createInstance(SessionSideChatEditor),
});

registerAction2(class NewChatInSessionAction extends Action2 {
	constructor() {
		super({
			id: 'sessions.chat.newInSession',
			title: localize2('sessions.nestedChat.action', 'New Chat in Current Session'),
			f1: true,
			precondition: SessionsWorkspaceModeContext.isEqualTo('code'),
		});
	}

	run(accessor: ServicesAccessor): void {
		if (accessor.get(IContextKeyService).getValue(SessionsWorkspaceModeContext.key) !== 'code') return;
		const views = accessor.get(ISessionsService);
		const selection = views.activeSelection;
		if (selection?.kind !== 'session' || selection.active.session.status !== 'active') return;
		const { session, threadId } = selection.active;
		const { providerId } = parseSessionIdentity(session.sessionId, LOCAL_AGENT_HOST_PROVIDER_ID);
		const provider = accessor.get(ISessionsProvidersService).getProvider(providerId);
		if (!provider || !provider.forkChat) return;
		views.openNewSession(localize('sessions.nestedChat.title', 'New Chat'), {
			sideBySide: true,
			providerId,
			forkSource: { sessionId: session.sessionId, threadId },
		});
	}
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).updateConfigurations({
	remove: [],
	add: [{
		id: 'sessions',
		title: localize('newSession.welcome.settingsTitle', 'New session welcome'),
		scope: ConfigurationScope.APPLICATION,
		properties: {
			[AGENT_SESSIONS_SCOPED_INPUT_HISTORY_SETTING]: {
				type: 'boolean', default: true,
				description: localize('sessions.chat.scopedInputHistory', 'Recall input history from the current Session in Code conversations.'),
			},
			[NEW_SESSION_WELCOME_PHRASES_SETTING]: {
				type: 'boolean', default: true,
				description: localize('sessions.chat.experimental.welcomePhrases', 'Show rotating welcome phrases above the new-session input.'),
			},
			[NEW_SESSION_WELCOME_NAME_SETTING]: {
				type: 'string', default: '',
				description: localize('sessions.chat.experimental.welcomeName', 'The name used in welcome phrases. Leave empty to omit the name.'),
			},
			[NEW_SESSION_WELCOME_MESSAGES_SETTING]: {
				type: 'object', default: { mode: 'append', phrases: [] }, additionalProperties: false,
				properties: {
					mode: { type: 'string', enum: ['append', 'replace'] },
					phrases: { type: 'array', items: { type: 'string' } },
				},
				description: localize('sessions.chat.experimental.welcomeMessages', 'Customize welcome phrases. Use mode "append" to add phrases or "replace" to use only your phrases. Use ${name} to position the welcome name.'),
			},
			'accessibility.verbosity.newSessionWelcome': {
				type: 'boolean', default: true,
				description: localize('newSession.welcome.verbosity', 'Announce the welcome phrase once when a new session is shown to a screen reader.'),
			},
		},
	}],
});
