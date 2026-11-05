import { extUriBiasedIgnorePathCase, basename } from '../../../../base/common/resources.js';
import { sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import { buildAgentHostSessionWorkspace } from '../../../common/agentHostSessionWorkspace.js';
import type { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsWorkspaceContextService } from '../../../services/workspace/browser/workspaceContextService.js';
import type { ISession } from '../../../services/sessions/common/session.js';

/** Projects the selected conversation's directory into the window's Explorer workspace. */
export class WorkspaceFolderManagementContribution extends Disposable {
	static readonly ID = 'workbench.contrib.workspaceFolderManagement';

	constructor(
		@ISessionsWorkspaceContextService private readonly workspaceContext: ISessionsWorkspaceContextService,
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
			this.workspaceContext.updateWorkspace({ id: selected.active.session.sessionId, folders: folder ? [folder] : [] });
			return;
		}
		const host = this.workspaceContext.getHostWorkspace();
		const target = selected?.kind === 'untitled' ? selected.session.workspace : undefined;
		if (target?.type === 'local' || target?.type === 'ssh' || target?.type === 'provider') {
			const uri = sessionWorkspaceUri(buildAgentHostSessionWorkspace(target)!);
			if (target.type === 'provider') {
				// Drafts have no SessionDirectory authority yet; expose no writable Explorer root.
				this.workspaceContext.updateWorkspace({ id: host.id, folders: [] });
				return;
			}
			const known = host.folders.filter(folder => extUriBiasedIgnorePathCase.isEqual(folder.uri, uri));
			this.workspaceContext.updateWorkspace({ id: host.id, folders: known.length || target.type !== 'ssh' ? known : [{ id: `agent-host:${selected?.kind === 'untitled' ? selected.session.providerId ?? '' : ''}`, uri, name: basename(uri), index: 0 }] });
			return;
		}
		this.workspaceContext.updateWorkspace(host);
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
