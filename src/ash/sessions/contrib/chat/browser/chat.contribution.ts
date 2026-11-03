import './agentHostDelegation.js';
import { AGENT_SESSIONS_SCOPED_INPUT_HISTORY_SETTING } from './sessionsChatHistory.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { NewChatWidget } from './newChatWidget.js';
import {
	FOCUS_NEW_SESSION_WORKSPACE_PICKER_KEYBINDING, FOCUS_NEW_SESSION_WORKSPACE_PICKER_WHEN,
	FOCUS_NEW_SESSION_ENVIRONMENT_PICKER_KEYBINDING, FOCUS_NEW_SESSION_ENVIRONMENT_PICKER_WHEN,
} from './newChatPickerKeybinding.js';
import { localize, localize2 } from '../../../../nls.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { NEW_SESSION_WELCOME_MESSAGES_SETTING, NEW_SESSION_WELCOME_NAME_SETTING, NEW_SESSION_WELCOME_PHRASES_SETTING } from '../common/constants.js';

import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { parseSessionIdentity } from '../../../services/sessions/common/sessionIdentity.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';

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

registerAction2(class FocusNewSessionWorkspacePickerAction extends Action2 {
	constructor() {
		super({
			id: 'sessions.focusNewSessionWorkspacePicker',
			title: localize2('sessions.focusNewSessionWorkspacePicker', 'Focus Workspace Picker'),
			f1: true,
			precondition: FOCUS_NEW_SESSION_WORKSPACE_PICKER_WHEN,
			keybinding: { weight: KeybindingWeight.SessionsContrib, primary: FOCUS_NEW_SESSION_WORKSPACE_PICKER_KEYBINDING },
		});
	}

	run(accessor: ServicesAccessor): void {
		const widget = accessor.get(IChatWidgetService).lastFocusedWidget;
		if (widget instanceof NewChatWidget) { widget.focusWorkspacePicker(); }
	}
});

registerAction2(class FocusNewSessionEnvironmentPickerAction extends Action2 {
	constructor() {
		super({
			id: 'sessions.focusNewSessionEnvironmentPicker',
			title: localize2('sessions.focusNewSessionEnvironmentPicker', 'Focus Environment Picker'),
			f1: true,
			precondition: FOCUS_NEW_SESSION_ENVIRONMENT_PICKER_WHEN,
			keybinding: { weight: KeybindingWeight.SessionsContrib, primary: FOCUS_NEW_SESSION_ENVIRONMENT_PICKER_KEYBINDING },
		});
	}

	run(accessor: ServicesAccessor): void {
		const widget = accessor.get(IChatWidgetService).lastFocusedWidget;
		if (widget instanceof NewChatWidget) { widget.focusEnvironmentPicker(); }
	}
});
