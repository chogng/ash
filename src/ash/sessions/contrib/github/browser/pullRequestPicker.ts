import { localize } from '../../../../nls.js';
import { GitHubIssueState, type GitHubAccount, type GitHubRepository, type IGitHubService } from '../../../../platform/github/common/githubService.js';
import type { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { pickChatContextItem } from '../../../../workbench/contrib/chat/browser/actions/chatContext.js';
import { githubRemotes, type LocalRepository } from '../../../../workbench/contrib/github/common/localRepository.js';

interface IPullRequestRepositoryPick extends IQuickPickItem {
	readonly root: string;
	readonly remote: string;
	readonly repository: GitHubRepository;
}

export async function pickPullRequestRepository(
	quickInput: IQuickInputService,
	checkouts: readonly LocalRepository[],
	accounts: readonly GitHubAccount[],
	signal: AbortSignal,
): Promise<IPullRequestRepositoryPick | undefined> {
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
	if (!repositories.length) {
		throw new Error(localize({ bundle: 'ash.sessions', key: 'sessions.github.noPullRequestRepository' }, 'Open a local GitHub checkout and connect a GitHub account to create a session from a pull request.'));
	}

	if (repositories.length === 1) {
		return repositories[0];
	}

	const result = await pickChatContextItem(
		quickInput,
		localize({ bundle: 'ash.sessions', key: 'sessions.github.pickPullRequestRepository' }, 'Choose a GitHub checkout'),
		async query => repositories.filter(item => (item.label + ' ' + item.description).toLowerCase().includes(query.trim().toLowerCase())),
		signal,
	);
	return result?.kind === 'item' ? result.item : undefined;
}

export async function pickPullRequest(quickInput: IQuickInputService, github: IGitHubService, repository: GitHubRepository, signal: AbortSignal): Promise<number | undefined> {
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
