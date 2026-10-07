import { URI } from '../../../../base/common/uri.js';
import { extUriBiasedIgnorePathCase, basename } from '../../../../base/common/resources.js';
import { createSshRemoteWorkspaceUri } from '../../../../platform/remote/common/remote.js';
import type { IWorkspace, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { WorkspaceContextService } from '../../../../workbench/services/workspaces/browser/workspaceContextService.js';
import { ISessionsService } from '../../sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../sessions/common/sessionsManagement.js';
import type { ISession } from '../../sessions/common/session.js';

/** Explorer follows the selection; open editors retain access to their Session's directory. */
export class SessionsWorkspaceContextService extends WorkspaceContextService {
	private readonly retainedFolders = new Map<string, IWorkspaceFolder>();
	constructor(
		private readonly hostWorkspace: () => IWorkspace,
		@ISessionsService private readonly sessions: ISessionsService,
		@ISessionsManagementService private readonly management: ISessionsManagementService,
	) {
		super(hostWorkspace());
		this._register(sessions.onDidChange(() => this.updateSelection()));
		this.updateSelection();
	}

	public override getWorkspaceFolder(resource: URI): IWorkspaceFolder | null {
		const selected = super.getWorkspaceFolder(resource);
		if (selected) { return selected; }
		// A dirty editor can outlive the visible Session. Never retarget its writes on page switching.
		const folders = [...this.retainedFolders.values(), ...this.management.sessions.flatMap(session => {
			const folder = sessionFolder(session);
			return folder ? [folder] : [];
		})].sort((a, b) => b.uri.path.length - a.uri.path.length);
		const session = folders.find(folder => extUriBiasedIgnorePathCase.isEqualOrParent(resource, folder.uri));
		if (session) { return session; }
		return this.hostWorkspace().folders.find(folder => extUriBiasedIgnorePathCase.isEqualOrParent(resource, folder.uri)) ?? null;
	}

	private updateSelection(): void {
		const selected = this.sessions.activeSelection;
		if (selected?.kind === 'session') {
			const folder = sessionFolder(selected.active.session);
			if (folder) { this.retainedFolders.set(folder.uri.toString(), folder); }
			this.updateWorkspace({ id: selected.active.session.sessionId, folders: folder ? [folder] : [] });
			return;
		}
		const host = this.hostWorkspace();
		const target = selected?.kind === 'untitled' ? selected.session.workspace : undefined;
		if (target?.type === 'local' || target?.type === 'ssh') {
			const uri = target.type === 'local' ? URI.file(target.root) : createSshRemoteWorkspaceUri(target.host, target.root);
			this.updateWorkspace({ id: host.id, folders: host.folders.filter(folder => extUriBiasedIgnorePathCase.isEqual(folder.uri, uri)) });
			return;
		}
		this.updateWorkspace(host);
	}
}

function sessionFolder(session: ISession): IWorkspaceFolder | undefined {
	const workspace = session.workspace;
	if (!workspace) { return undefined; }
	const uri = workspace.authorityId === 'local' ? URI.file(workspace.root) : createSshRemoteWorkspaceUri(workspace.authorityId, workspace.root);
	// Bind the root into the folder identity: moving a Session must not redirect an already open file.
	return { id: `session:${encodeURIComponent(session.sessionId)}:${encodeURIComponent(workspace.root)}`, uri, name: basename(uri), index: 0 };
}
