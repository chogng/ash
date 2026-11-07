import type { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { localize } from '../../../../../../nls.js';
import type { GitHubRepository, IGitHubService } from '../../../../../../platform/github/common/githubService.js';

/** Bounds each collection separately so a long diff cannot displace the discussion. */
async function collectSnapshot<T, P>(first: P, read: (page: P) => Promise<{ readonly entries: readonly T[]; readonly next: P | null; readonly truncated?: boolean; }>, budget: number): Promise<{ readonly entries: readonly T[]; readonly truncated: boolean; }> {
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

export interface IPullRequestContext {
	readonly title: string;
	readonly url: string;
	readonly commit: string;
	readonly content: string;
}

export async function getPullRequestContext(
	github: IGitHubService,
	repository: GitHubRepository,
	number: number,
	token: CancellationToken,
): Promise<IPullRequestContext> {
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
