import { Disposable } from '../../../base/common/lifecycle.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../nls.js';
import { IActionViewItemService } from '../../../platform/actions/browser/actionViewItemService.js';
import { Action2 } from '../../../platform/actions/common/actions.js';
import { AMBIENT_AGENT_HOST_AUTHORITY } from '../../../platform/agentHost/common/agentHostConnectionsService.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { buildOpenSessionLinkUri } from '../../../platform/agentHost/common/openSessionLink.js';
import { IRemoteAgentHostService, isSSHAgentHost } from '../../../platform/agentHost/common/remoteAgentHostService.js';
import { invoke } from '../../../platform/ipc/electron-browser/rendererIpc.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { createSshRemoteAuthority } from '../../../platform/remote/common/remote.js';
import { OPEN_IDE_SESSION_CHANNEL } from '../../../platform/window/common/window.js';
import { INativeHostService } from '../../../workbench/common/services.js';
import { IChatSessionNavigationService } from '../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { Menus } from '../../browser/menus.js';
import { OpenInAshTitleBarWidget } from '../../browser/widget/openInAshWidget.js';
import { SessionsWorkspaceModeContext } from '../../common/contextkeys.js';
import { buildAgentHostSessionWorkspace } from '../../common/agentHostSessionWorkspace.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID, sshAgentHostProviderId } from '../../common/agentHostSessionsProvider.js';
import { OPEN_ASH_WINDOW_COMMAND_ID } from '../../common/sessionCommands.js';
import { sessionWorkspaceUri } from '../../common/sessionWorkspace.js';
import { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import { chatExecutionWorkspace } from '../../services/sessions/common/session.js';
import { sessionProviderAuthority } from '../../services/sessions/common/sessionIdentity.js';

export class OpenAshWindowAction extends Action2 {
	public static readonly ID = OPEN_ASH_WINDOW_COMMAND_ID;

	constructor() {
		super({
			id: OpenAshWindowAction.ID,
			title: localize2({ bundle: 'ash', key: 'sessions.menu.openIde' }, 'Open IDE'),
			f1: true,
		});
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		// Main selects an IDE window without mistaking an auxiliary chat for one.
		await accessor.get(INativeHostService).openWindow({ forceReuseWindow: true });
	}
}

export class OpenSessionInAshAction extends Action2 {
	static readonly ID = 'agents.openSessionInAsh';

	constructor() {
		super({
			id: OpenSessionInAshAction.ID,
			title: localize2({ bundle: 'ash', key: 'sessions.menu.openIde' }, 'Open IDE'),
			icon: Lxicon.ashMark,
			menu: {
				id: Menus.TitleBarRightLayout,
				when: SessionsWorkspaceModeContext.isEqualTo('code'),
				group: 'navigation',
				order: 7,
			},
		});
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const selection = accessor.get(ISessionsService).activeSelection;
		const host = accessor.get(INativeHostService);
		const navigation = accessor.get(IChatSessionNavigationService);
		const notifications = accessor.get(INotificationService);
		const remoteHosts = accessor.get(IRemoteAgentHostService);
		const active = selection?.kind === 'session' ? selection.active : undefined;
		const draftWorkspace = selection?.kind === 'untitled' ? selection.session.workspace : undefined;
		const workspace = active
			? chatExecutionWorkspace(active.session, active.session.chats.find(chat => chat.threadId === active.threadId))
			: draftWorkspace && draftWorkspace.type !== 'current' && draftWorkspace.type !== 'multiple'
				? buildAgentHostSessionWorkspace(draftWorkspace) : undefined;
		// Only materialized Threads have an address that the IDE can open independently.
		const link = active && await navigation.prepareConversationLink!(active.session.sessionId, active.threadId);
		const workspaceAuthority = workspace?.authorityId;
		const sshWorkspace = workspaceAuthority?.startsWith('ssh+');
		// The IDE's ambient connection is the SSH host that owns this folder. Keep
		// the backend IDs and rebase the link only if the source provider is that host.
		const sameSshHost = sshWorkspace && link && remoteHosts.connections.some(({ connection }) =>
			isSSHAgentHost(connection) && createSshRemoteAuthority(connection.host).authority === workspaceAuthority
			&& sessionProviderAuthority(sshAgentHostProviderId(connection), LOCAL_AGENT_HOST_PROVIDER_ID) === link.connectionAuthority);
		const conversation = link && buildOpenSessionLinkUri(link.sessionId, link.threadId,
			sameSshHost ? AMBIENT_AGENT_HOST_AUTHORITY : link.connectionAuthority);
		const folder = workspace && (workspace.authorityId === 'local'
			|| (sshWorkspace && (!link || sameSshHost)))
			? sessionWorkspaceUri(workspace) : undefined;
		if (folder || conversation) {
			await invoke<void>(OPEN_IDE_SESSION_CHANNEL, { folder: folder?.toString(), conversation: conversation?.toString() });
		} else {
			await host.openWindow({ forceReuseWindow: true });
		}
		if (workspace && !folder) {
			notifications.info(localize({ bundle: 'ash.sessions', key: 'openInAsh.workspaceUnavailable' }, 'The IDE cannot open this conversation’s working directory.'));
		}
	}
}

export class OpenInAshWidgetContribution extends Disposable {
	static readonly ID = 'sessions.contrib.openInAshWidget';

	constructor(@IActionViewItemService presentations: IActionViewItemService) {
		super();
		this._register(presentations.register(Menus.TitleBarRightLayout, OpenSessionInAshAction.ID, (action, options) =>
			new OpenInAshTitleBarWidget(action, options)));
	}
}
