import { basename } from '../../../../base/common/resources.js';
import { selectionFromResource } from '../../../common/agentHostSessionWorkspace.js';
import { sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import type { SessionExecutionTarget } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

/** Supplies workspace choices from the current host's active Session catalog. */
export class SessionWorkspaceFallback {
	constructor(@ISessionsManagementService private readonly sessions: ISessionsManagementService) { }

	getWorkspaces(
		providerId: string | undefined,
		known: Set<string>,
		accepts: (target: SessionExecutionTarget) => boolean,
	): readonly { readonly label: string; readonly target: SessionExecutionTarget; }[] {
		const candidates = this.sessions.sessions
			.filter(session => session.status === 'active' && session.providerId === providerId)
			.map(session => ({
				workspace: session.workspace,
				lastActivity: session.chats.reduce((latest, chat) => Math.max(latest, chat.updatedAt?.getTime() ?? 0), session.management?.statusChangedAtUnixMs ?? 0),
			}))
			.sort((a, b) => b.lastActivity - a.lastActivity);
		return candidates.flatMap(({ workspace }) => {
			if (!workspace || workspace.runtime) return [];
			const resource = sessionWorkspaceUri(workspace);
			const key = resource.toString();
			if (known.has(key)) return [];
			let target: SessionExecutionTarget;
			try { target = selectionFromResource(resource); }
			catch { return []; }
			if (!accepts(target)) return [];
			known.add(key);
			return [{ label: basename(resource) || workspace.root, target }];
		});
	}
}
