import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { GitHubIssueState, type GitHubRepository, type IGitHubService } from '../../../../platform/github/common/githubService.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { pickChatContextItem } from '../../../../workbench/contrib/chat/browser/actions/chatContext.js';
import * as chatInputStatePersistence from '../../../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { githubRemotes, readLocalRepositories } from '../../../../workbench/contrib/github/common/localRepository.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensionService.js';
import { ISessionProviderScopeService } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { Menus } from '../../../browser/menus.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { writeNewChatDraftState } from '../../chat/common/newChatDraftState.js';

const when = ContextKeyExpr.and(IsSessionsWindowContext.isEqualTo(true), SessionsWorkspaceModeContext.isEqualTo('code'));
const title = localize2({ bundle: 'ash.sessions', key: 'sessions.github.newFromPullRequest' }, 'New Session from Pull Request');

registerAction2(class NewSessionFromPullRequestAction extends Action2 {
	constructor() {
		super({
			id: 'sessions.newSessionFromPullRequest', title, f1: true, precondition: when,
			menu: { id: Menus.SessionsViewFilter, when, group: 'create' },
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const commands = accessor.get(ICommandService);
		const extensions = accessor.get(IExtensionService);
		const quickInput = accessor.get(IQuickInputService);
		const management = accessor.get(ISessionsManagementService);
		const sessions = accessor.get(ISessionsService);
		const scopes = accessor.get(ISessionProviderScopeService);
		const progress = accessor.get(IProgressService);
		const notifications = accessor.get(INotificationService);
		const storage = accessor.get(IStorageService);
		const scope = scopes.getScope();
		const workspace = accessor.get(ISessionsProvidersService).getProvider(scope.providerId)?.currentWorkspace();
		if (workspace?.type === 'ssh' || workspace?.type === 'remote' || workspace?.type === 'provider') {
			throw new Error(localize({ bundle: 'ash.sessions', key: 'sessions.github.localPullRequestWorkspace' }, 'Select a local execution host to create a session from a pull request.'));
		}
		const github = scope.services.host.github;
		const navigationRevision = sessions.navigationRevision;
		const [checkouts, accounts] = await Promise.all([
			extensions.activateByEvent('onCommand:git.getRepositoryContexts').then(() => readLocalRepositories(commands)),
			github.listAccounts(),
		]);
		scope.assertCurrent();
		const repositories = checkouts.filter(checkout => checkout.root.scheme === 'file').flatMap(checkout =>
			githubRemotes(checkout).flatMap(remote => {
				const identity = remote.identity!;
				return accounts.filter(account => account.status === 'ready' && account.host.toLowerCase() === identity.host.toLowerCase()).map(account => ({
					label: identity.owner + '/' + identity.repository,
					description: checkout.label + ' · ' + account.login + '@' + account.host,
					root: checkout.root.fsPath,
					remote: remote.name,
					repository: { accountId: account.id, host: identity.host, owner: identity.owner, name: identity.repository },
				}));
			}));
		if (!repositories.length) throw new Error(localize({ bundle: 'ash.sessions', key: 'sessions.github.noPullRequestRepository' }, 'Open a local GitHub checkout and connect a GitHub account to create a session from a pull request.'));

		const picker = new AbortController();
		const repositoryChoice = repositories.length === 1 ? repositories[0] : await pickChatContextItem(quickInput,
			localize({ bundle: 'ash.sessions', key: 'sessions.github.pickPullRequestRepository' }, 'Choose a GitHub checkout'), async query =>
			repositories.filter(item => (item.label + ' ' + item.description).toLowerCase().includes(query.trim().toLowerCase())), picker.signal)
			.then(result => result?.kind === 'item' ? result.item : undefined);
		if (!repositoryChoice) return;
		const repository = repositoryChoice.repository;
		const number = await pickPullRequest(quickInput, github, repository, picker.signal);
		if (number === undefined) return;

		using cancellation = new CancellationTokenSource();
		const snapshot = await progress.withProgress({
			location: ProgressLocation.Notification,
			title: localize({ bundle: 'ash.sessions', key: 'sessions.github.fetchingPullRequest' }, 'Reading pull request #{0}…', number), cancellable: true,
		}, () => readPullRequestSnapshot(github, repository, number, cancellation.token), () => cancellation.cancel()).catch(error => {
			if (!cancellation.token.isCancellationRequested) throw error;
			return undefined;
		});
		if (!snapshot || cancellation.token.isCancellationRequested) return;
		scope.assertCurrent();
		const account = accounts.find(account => account.id === repository.accountId);
		const current = (await github.listAccounts()).find(candidate => candidate.id === repository.accountId);
		if (current?.status !== 'ready' || current.credentialRevision !== account?.credentialRevision) {
			throw new Error(localize({ bundle: 'ash.sessions', key: 'sessions.github.pullRequestAccountChanged' }, 'The GitHub account changed while reading the pull request. Start again with the current account.'));
		}
		scope.assertCurrent();

		const label = '#' + number + ' ' + snapshot.title;
		const active = await progress.withProgress({
			location: ProgressLocation.Notification,
			title: localize({ bundle: 'ash.sessions', key: 'sessions.github.preparingPullRequestWorktree' }, 'Preparing a worktree for pull request #{0}…', number),
		}, () => management.startNewSession(label, {
			workspace: { type: 'local', root: repositoryChoice.root },
			providerId: scope.providerId,
			creation: {
				branchName: 'ash/pr-' + number + '-' + generateUuid(),
				worktreeStart: {
					remote: repositoryChoice.remote,
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
		if (sessions.navigationRevision === navigationRevision) await sessions.openThread(active.session.sessionId, active.threadId);
		const ready = localize({ bundle: 'ash.sessions', key: 'sessions.github.pullRequestSessionReady' }, 'Session ready. Pull request #{0} is checked out and attached.', number);
		notifications.status(ready);
		status(ready);
	}
});

async function pickPullRequest(quickInput: IQuickInputService, github: IGitHubService, repository: GitHubRepository, signal: AbortSignal): Promise<number | undefined> {
	interface PullRequestPick extends IQuickPickItem { readonly number?: number; readonly nextPage?: number; }
	let items: PullRequestPick[] = [];
	let page = 1;
	let nextPage: number | null = null;
	let loaded = 0;
	const selection = await pickChatContextItem<PullRequestPick>(quickInput,
		localize({ bundle: 'ash.sessions', key: 'sessions.github.pickPullRequest' }, 'Choose a pull request or enter its number'),
		async (query, token) => {
			const value = query.trim().toLowerCase();
			if (/^#?[1-9]\d*$/u.test(value)) {
				const number = Number(value.replace(/^#/u, ''));
				if (!Number.isSafeInteger(number)) return [];
				const pr = await github.readPullRequest(repository, number, token);
				return [{ label: '#' + pr.number + ' ' + pr.title, description: pr.headBranch, number: pr.number }];
			}
			if (loaded !== page) {
				const result = await github.listPullRequests(repository, GitHubIssueState.Open, page, token);
				if (token.isCancellationRequested) return [];
				items = [...items, ...result.items.map(pr => ({ label: '#' + pr.number + ' ' + pr.title, description: pr.headBranch, number: pr.number }))];
				loaded = page;
				nextPage = result.nextPage;
			}
			return [...items.filter(item => item.label.toLowerCase().includes(value)), ...(nextPage === null ? [] : [{
				label: localize({ bundle: 'ash.sessions', key: 'sessions.github.morePullRequests' }, 'Load more pull requests'), nextPage, alwaysShow: true,
			}])];
		}, signal, item => {
			if (item.nextPage === undefined) return true;
			page = item.nextPage;
			return false;
		});
	return selection?.kind === 'item' ? selection.item.number : undefined;
}

/** Bounds each collection separately so a long diff cannot displace the discussion. */
async function collectSnapshot<T, P>(first: P, read: (page: P) => Promise<{ readonly entries: readonly T[]; readonly next: P | null; readonly truncated?: boolean; }>, budget: number) {
	const entries: T[] = [];
	let page: P | null = first;
	let truncated = false;
	for (let count = 0; page !== null && count < 30; count++) {
		const result = await read(page);
		for (const entry of result.entries) {
			budget -= JSON.stringify(entry).length + 1;
			if (budget < 0) return { entries, truncated: true };
			entries.push(entry);
		}
		truncated ||= result.truncated === true;
		page = result.next;
	}
	return { entries, truncated: truncated || page !== null };
}

async function readPullRequestSnapshot(github: IGitHubService, repository: GitHubRepository, number: number, token: CancellationToken) {
	const pr = await github.readPullRequest(repository, number, token);
	const url = new URL(pr.url);
	if (url.protocol !== 'https:' || url.host.toLowerCase() !== repository.host.toLowerCase() || url.username || url.password
		|| url.pathname.toLowerCase() !== ('/' + repository.owner + '/' + repository.name + '/pull/' + number).toLowerCase()
		|| pr.number !== number || !/^[\da-f]{40}(?:[\da-f]{24})?$/u.test(pr.headCommit)) {
		throw new Error(localize({ bundle: 'ash.sessions', key: 'sessions.github.invalidPullRequestSnapshot' }, 'GitHub returned a pull request that does not match the selection.'));
	}
	const [files, discussion, reviews, reviewThreads] = await Promise.all([
		collectSnapshot(1, async page => {
			const response = await github.listPullRequestFiles(repository, number, page, token);

			return {
				entries: response.items.map(file => ({
					...file, patch: file.patch?.slice(0, 24_000) ?? null, patchTruncated: (file.patch?.length ?? 0) > 24_000,
				})),
				next: response.nextPage,
				truncated: response.limitReached,
			};
		}, 64_000),
		collectSnapshot(1, async page => {
			const response = await github.listComments(repository, number, page, token);
			return { entries: response.items, next: response.nextPage };
		}, 16_000),
		collectSnapshot(1, async page => {
			const response = await github.listPullRequestReviews(repository, number, page, token);
			return { entries: response.items, next: response.nextPage };
		}, 8_000),

		collectSnapshot('', async cursor => {
			const response = await github.listReviewThreads(repository, number, cursor || null, token);
			const entries = [];
			for (const thread of response.threads) {
				const additional = thread.comments.nextCursor === null ? undefined : await collectSnapshot(thread.comments.nextCursor, async cursor => {
					const comments = await github.readReviewThreadComments(repository, number, thread.id, cursor, token);
					return { entries: comments.comments, next: comments.nextCursor };
				}, 6_000);
				entries.push({
					path: thread.path, line: thread.line, side: thread.side, resolved: thread.resolved, outdated: thread.outdated,
					comments: [...thread.comments.comments, ...additional?.entries ?? []], truncated: additional?.truncated ?? false,
				});
			}
			return { entries, next: response.nextCursor };
		}, 20_000),
	]);
	const current = await github.readPullRequest(repository, number, token);
	if (current.headCommit !== pr.headCommit || current.baseBranch !== pr.baseBranch) {
		throw new Error(localize({ bundle: 'ash.sessions', key: 'sessions.github.pullRequestSnapshotChanged' }, 'Pull request #{0} changed while it was being read. Select it again.', number));
	}
	const content = JSON.stringify({ ...pr, body: pr.body.slice(0, 12_000), bodyTruncated: pr.body.length > 12_000, files, discussion, reviews, reviewThreads });
	return { title: pr.title, url: url.toString(), commit: pr.headCommit, content };
}
