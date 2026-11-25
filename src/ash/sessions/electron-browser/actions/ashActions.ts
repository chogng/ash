import { localize, localize2 } from '../../../nls.js';
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
import { IAppServerRemoteAgentService } from '../../../workbench/services/remote/common/appServerRemoteAgentService.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { SessionsWorkspaceModeContext } from '../../common/contextkeys.js';
import { buildAgentHostSessionWorkspace } from '../../common/agentHostSessionWorkspace.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID, sshAgentHostProviderId } from '../../common/agentHostSessionsProvider.js';
import { OPEN_ASH_WINDOW_COMMAND_ID } from '../../common/sessionCommands.js';
import { sessionWorkspaceUri } from '../../common/sessionWorkspace.js';
import { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
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
			title: localize2({ bundle: 'ash', key: 'sessions.menu.openConversationInIde' }, 'Open Conversation in IDE'),
			f1: true,
			precondition: SessionsWorkspaceModeContext.isEqualTo('code'),
		});
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const context = accessor.get(IContextKeyService);
		if (context.getValue(SessionsWorkspaceModeContext.key) !== 'code') return;
		const sessions = accessor.get(ISessionsService);
		const selection = sessions.activeSelection;
		const revision = sessions.navigationRevision;
		const host = accessor.get(INativeHostService);
		const navigation = accessor.get(IChatSessionNavigationService);
		const notifications = accessor.get(INotificationService);
		const remoteHosts = accessor.get(IRemoteAgentHostService);
		const remoteAgent = accessor.get(IAppServerRemoteAgentService);
		const active = selection?.kind === 'session' ? selection.active : undefined;
		// The owner validates backend coordinates and returns the current Thread
		// directory in the same read, including freshly restored SSH worktrees.
		const prepared = active && await navigation.prepareConversation!(active.session.sessionId, active.threadId);
		if (sessions.navigationRevision !== revision || context.getValue(SessionsWorkspaceModeContext.key) !== 'code') return;
		const link = prepared?.link;
		const draftWorkspace = selection?.kind === 'untitled' ? selection.session.workspace : undefined;
		const workspace = prepared
			? buildAgentHostSessionWorkspace(prepared.directory ?? undefined)
			: draftWorkspace && draftWorkspace.type !== 'current' && draftWorkspace.type !== 'multiple'
				? buildAgentHostSessionWorkspace(draftWorkspace) : undefined;
		const runtime = workspace?.runtime;
		const workspaceAuthority = workspace?.authorityId;
		const sshWorkspace = workspaceAuthority?.startsWith('ssh+');
		const ambientConnection = remoteAgent.connection;
		// The IDE's ambient connection is the SSH host that owns this folder. Keep
		// the backend IDs and rebase the link only if the source provider is that host.
		// The first Agents window inherits its IDE's host: its `local` link authority
		// names that ambient connection, not necessarily this computer.
		const sameSshHost = sshWorkspace && link && (link.connectionAuthority === AMBIENT_AGENT_HOST_AUTHORITY
			? ambientConnection?.kind === 'ssh' && ambientConnection.authority === workspaceAuthority
			: remoteHosts.connections.some(({ connection }) =>
				isSSHAgentHost(connection) && createSshRemoteAuthority(connection.host).authority === workspaceAuthority
				&& sessionProviderAuthority(sshAgentHostProviderId(connection), LOCAL_AGENT_HOST_PROVIDER_ID) === link.connectionAuthority));
		const conversation = link && buildOpenSessionLinkUri(link.sessionId, link.threadId,
			sameSshHost ? AMBIENT_AGENT_HOST_AUTHORITY : link.connectionAuthority);
		const container = runtime?.providerId === 'ash.dev-containers' && !runtime.hostAuthority
			&& ambientConnection?.kind === 'local' && link?.connectionAuthority === AMBIENT_AGENT_HOST_AUTHORITY;
		const folder = workspace && (runtime ? container : workspace.authorityId === 'local'
			|| (sshWorkspace && (!link || sameSshHost)))
			? sessionWorkspaceUri(workspace) : undefined;
		// A folderless ambient link would be interpreted by Main on the local
		// backend. Never send another host's unqualified IDs to that fallback.
		const unavailableAmbientLink = link && link.connectionAuthority === AMBIENT_AGENT_HOST_AUTHORITY
			&& ambientConnection?.kind !== 'local' && !sameSshHost;
		if (unavailableAmbientLink || (workspace && !folder)) {
			notifications.info(localize({ bundle: 'ash.sessions', key: 'openInAsh.workspaceUnavailable' }, 'The IDE cannot open this conversation’s working directory.'));
		}
		if (unavailableAmbientLink) return;
		if (folder || conversation) {
			await invoke<void>(OPEN_IDE_SESSION_CHANNEL, { folder: folder?.toString(), conversation: conversation?.toString() });
		} else {
			await host.openWindow({ forceReuseWindow: true });
		}
	}
}
