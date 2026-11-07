import { CancellationToken } from '../../../../base/common/cancellation.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import type { GitHubRepository } from '../../../../platform/github/common/githubService.js';
import { ProgressLocation, type IProgressService } from '../../../../platform/progress/common/progress.js';
import type { IStorageService } from '../../../../platform/storage/common/storage.js';
import * as chatInputStatePersistence from '../../../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import type { IPullRequestContext } from '../../../../workbench/contrib/sessions/browser/github/fetchers/githubPullRequestContextFetcher.js';
import type { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import type { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { writeNewChatDraftState } from '../../chat/common/newChatDraftState.js';

interface IPullRequestSessionOptions {
	readonly root: string;
	readonly remote: string;
	readonly repository: GitHubRepository;
	readonly number: number;
	readonly snapshot: IPullRequestContext;
	readonly providerId: string;
	readonly navigationRevision: number;
}

export async function createAndOpenPullRequestSession(
	management: ISessionsManagementService,
	sessions: ISessionsService,
	progress: IProgressService,
	storage: IStorageService,
	{ root, remote, repository, number, snapshot, providerId, navigationRevision }: IPullRequestSessionOptions,
): Promise<void> {
	const label = '#' + number + ' ' + snapshot.title;
	const active = await progress.withProgress({
		location: ProgressLocation.Notification,
		title: localize({ bundle: 'ash.sessions', key: 'sessions.github.preparingPullRequestWorktree' }, 'Preparing a worktree for pull request #{0}…', number),
	}, () => management.startNewSession(label, {
		workspace: { type: 'local', root },
		providerId,
		creation: {
			branchName: 'ash/pr-' + number + '-' + generateUuid(),
			worktreeStart: {
				remote,
				remoteIdentity: repository.host + '/' + repository.owner + '/' + repository.name,
				reference: 'refs/pull/' + number + '/head',
				commit: snapshot.commit,
			},
			token: CancellationToken.None,
		},
	}));

	// The first message uses the existing draft path, including reload and failed sends.
	writeNewChatDraftState(storage, {
		mode: 'agent', text: '', contexts: [{
			id: 'initial-pr:' + active.threadId, kind: 'transcriptContext', name: label, content: snapshot.content, resource: snapshot.url,
		}]
	}, active.threadId, chatInputStatePersistence);
	if (sessions.navigationRevision === navigationRevision) {
		await sessions.openThread(active.session.sessionId, active.threadId);
	}
}
