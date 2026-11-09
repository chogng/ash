import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { basename, extUri } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { ISessionProviderScopeService } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import type { IActiveSessionThread, ISessionWorkspace } from '../../sessions/common/session.js';

export const IWorkspaceFolderLabelService = createServiceIdentifier<IWorkspaceFolderLabelService>('sessionsWorkspaceFolderLabelService');

export interface IWorkspaceFolderLabelService {
	getWorkspaceFolderLabel(checkout: ISessionWorkspace, source: ISessionWorkspace | null | undefined): string;
	readWorktreeLabel(active: IActiveSessionThread, token: CancellationToken): Promise<string | undefined>;
}

function worktreeSource(checkout: ISessionWorkspace, source: ISessionWorkspace | null | undefined): ISessionWorkspace | undefined {
	// Provider runtimes may expose a different path for the same checkout.
	if (!source || checkout.runtime || source.runtime || checkout.authorityId !== source.authorityId) return undefined;
	return extUri.isEqual(sessionWorkspaceUri(checkout), sessionWorkspaceUri(source)) ? undefined : source;
}

/** Resolves names for Sessions presentations while retaining the Thread's execution directory. */
export class SessionsWorkspaceFolderLabelService implements IWorkspaceFolderLabelService {
	constructor(@ISessionProviderScopeService private readonly scopes: ISessionProviderScopeService) { }

	getWorkspaceFolderLabel(checkout: ISessionWorkspace, source: ISessionWorkspace | null | undefined): string {
		return basename(sessionWorkspaceUri(worktreeSource(checkout, source) ?? checkout));
	}

	async readWorktreeLabel({ session, threadId }: IActiveSessionThread, token: CancellationToken): Promise<string | undefined> {
		const checkout = session.chats.find(chat => chat.threadId === threadId)?.workspace;
		const source = checkout && worktreeSource(checkout, session.workspace);
		if (!checkout || !source || token.isCancellationRequested) return undefined;

		const uri = sessionWorkspaceUri(checkout);
		let detail = basename(uri);
		try {
			const scope = this.scopes.getScope(session.sessionId);
			scope.assertCurrent();
			const host = scope.services.host;
			const generation = host.appServer.connectionGeneration;
			const repositories = await host.localGit.readRepositoryContexts({
				sessionId: scope.backendIdentity(session.sessionId),
				path: checkout.root,
			}, token);
			scope.assertCurrent();
			if (generation === host.appServer.connectionGeneration) {
				const head = repositories.find(repository =>
					extUri.isEqual(sessionWorkspaceUri({ ...checkout, root: repository.rootPath }), uri))?.head;
				if (head?.type === 'branch' && head.name) detail = head.name;
			}
		} catch {
			// An unavailable Git provider still leaves the checkout name available for display.
		}
		return token.isCancellationRequested ? undefined
			: localize('sessions.workspaceFolderLabel.worktree', '{0} ({1})', basename(sessionWorkspaceUri(source)), detail);
	}
}
