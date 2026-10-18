import { extUriBiasedIgnorePathCase, basename } from '../../../../base/common/resources.js';
import { sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import { buildAgentHostSessionWorkspace } from '../../../common/agentHostSessionWorkspace.js';
import type { IWorkspace, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ISessionsService } from '../../sessions/browser/sessionsService.js';
import type { ISession } from '../../sessions/common/session.js';

/** Explorer follows the selection; filesystem routing is owned by the shared file provider. */
export class SessionsWorkspaceContextService extends Disposable {
	constructor(
		private readonly hostWorkspace: () => IWorkspace,
		private readonly updateWorkspace: (workspace: IWorkspace) => void,
		@ISessionsService private readonly sessions: ISessionsService,
	) {
		super();
		this._register(sessions.onDidChange(() => this.updateSelection()));
		this.updateSelection();
	}

	private updateSelection(): void {
		const selected = this.sessions.activeSelection;
		if (selected?.kind === 'session') {
			const folder = sessionFolder(selected.active.session, selected.active.threadId);
			this.updateWorkspace({ id: selected.active.session.sessionId, folders: folder ? [folder] : [] });
			return;
		}
		const host = this.hostWorkspace();
		const target = selected?.kind === 'untitled' ? selected.session.workspace : undefined;
		if (target?.type === 'local' || target?.type === 'ssh' || target?.type === 'provider') {
			const uri = sessionWorkspaceUri(buildAgentHostSessionWorkspace(target)!);
			if (target.type === 'provider') {
				// Drafts have no SessionDirectory authority yet; expose no writable Explorer root.
				this.updateWorkspace({ id: host.id, folders: [] }); return;
			}
			this.updateWorkspace({ id: host.id, folders: host.folders.filter(folder => extUriBiasedIgnorePathCase.isEqual(folder.uri, uri)) });
			return;
		}
		this.updateWorkspace(host);
	}
}

function sessionFolder(session: ISession, threadId?: string): IWorkspaceFolder | undefined {
	// Undefined Thread detail is not permission to use the source directory;
	// null is an authoritative Thread without a filesystem directory.
	const workspace = threadId ? session.chats.find(chat => chat.threadId === threadId)?.workspace : session.workspace;
	if (!workspace) { return undefined; }
	const uri = sessionWorkspaceUri(workspace);
	// Bind the root into the folder identity: moving a Session must not redirect an already open file.
	return { id: `session:${encodeURIComponent(session.sessionId)}:${encodeURIComponent(workspace.root)}`, uri, name: basename(uri), index: 0 };
}
