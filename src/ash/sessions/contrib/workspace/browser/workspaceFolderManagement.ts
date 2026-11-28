import { extUriBiasedIgnorePathCase, basename } from '../../../../base/common/resources.js';
import { sessionWorkspaceUri, type IActiveSessionThread } from '../../../../workbench/services/sessions/common/session.js';
import { buildAgentHostSessionWorkspace } from '../../../../workbench/contrib/sessions/common/agentHostSessionWorkspace.js';
import { sessionWorkspaceFolderId, type IWorkspace, type IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsWorkspaceContextService } from '../../../services/workspace/browser/workspaceContextService.js';
import { IWorkspaceFolderLabelService } from '../../../services/workspaceFolderLabel/browser/workspaceFolderLabelService.js';

/** Projects the selected conversation's directory into the window's Explorer workspace. */
export class WorkspaceFolderManagementContribution extends Disposable {
	static readonly ID = 'workbench.contrib.workspaceFolderManagement';

	private draftFolder: { readonly hostId: string; readonly folder: IWorkspaceFolder; readonly workspace: Promise<IWorkspace>; } | undefined;

	constructor(
		@ISessionsWorkspaceContextService private readonly workspaceContext: ISessionsWorkspaceContextService,
		@ISessionsService private readonly sessions: ISessionsService,
		@IWorkspaceFolderLabelService private readonly folderLabels: IWorkspaceFolderLabelService,
	) {
		super();
		this._register(sessions.onDidChange(() => this.updateSelection()));
		this.updateSelection();
	}

	private updateSelection(): void {
		const selected = this.sessions.activeSelection;
		const target = selected?.kind === 'untitled' ? selected.session.workspace : undefined;
		if (target?.type !== 'local') this.draftFolder = undefined;
		if (selected?.kind === 'session') {
			const folder = this.sessionFolder(selected.active);
			this.workspaceContext.updateWorkspace({ id: selected.active.session.sessionId, folders: folder ? [folder] : [] });
			return;
		}
		const host = this.workspaceContext.getHostWorkspace();
		if (target?.type === 'local' || target?.type === 'ssh' || target?.type === 'provider') {
			const uri = sessionWorkspaceUri(buildAgentHostSessionWorkspace(target)!);
			if (target.type === 'provider') {
				// Drafts have no SessionDirectory authority yet; expose no writable Explorer root.
				this.workspaceContext.updateWorkspace({ id: host.id, folders: [] });
				return;
			}
			const known = host.folders.filter(folder => extUriBiasedIgnorePathCase.isEqual(folder.uri, uri));
			if (target.type === 'local' && !known.length && this.workspaceContext.bindLocalWorkspaceFolder) {
				const empty = { id: host.id, folders: [] };
				if (!this.draftFolder || this.draftFolder.hostId !== host.id || !extUriBiasedIgnorePathCase.isEqual(this.draftFolder.folder.uri, uri)) {
					const hash = new StringSHA1();
					hash.update(uri.toString());
					const folder = { id: `draft:${hash.digest()}`, uri, name: basename(uri), index: 0 };
					const workspace: Promise<IWorkspace> = this.workspaceContext.bindLocalWorkspaceFolder(folder).then(bound => {
						if (!bound && this.draftFolder?.workspace === workspace) {
							this.draftFolder = undefined;
						}
						return bound ? { id: host.id, folders: [folder] } : empty;
					}, error => {
						if (!this.isDisposed && this.draftFolder?.workspace === workspace) {
							this.draftFolder = undefined;
							onUnexpectedError(error);
						}
						return empty;
					});
					this.draftFolder = { hostId: host.id, folder, workspace };
				}
				this.workspaceContext.updateWorkspace(empty, this.draftFolder.workspace);
				return;
			}
			this.draftFolder = undefined;
			this.workspaceContext.updateWorkspace({ id: host.id, folders: known.length || target.type !== 'ssh' ? known : [{ id: `agent-host:${selected?.kind === 'untitled' ? selected.session.providerId ?? '' : ''}`, uri, name: basename(uri), index: 0 }] });
			return;
		}
		this.workspaceContext.updateWorkspace(host);
	}

	private sessionFolder({ session, threadId }: IActiveSessionThread): IWorkspaceFolder | undefined {
		// Wait for the Thread to publish its directory before projecting an Explorer root.
		const workspace = session.chats.find(chat => chat.threadId === threadId)?.workspace;
		if (!workspace) return undefined;
		return {
			// Moving a Session must not redirect an already open file.
			id: sessionWorkspaceFolderId(session.sessionId, workspace.root),
			uri: sessionWorkspaceUri(workspace),
			name: this.folderLabels.getWorkspaceFolderLabel(workspace, session.workspace),
			index: 0,
		};
	}
}
