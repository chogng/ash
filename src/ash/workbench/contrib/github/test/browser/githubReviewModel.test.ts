import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import type { AccountState, IAccountService } from '../../../../../platform/accounts/common/accountService.js';
import { GitHubNotificationFilter, GitHubForkBranches, type GitHubNotification, GitHubDiffSide, GitHubError, GitHubErrorCode, GitHubIssueState, GitHubReviewEvent, type GitHubPullRequest, type GitHubReviewThread, type IGitHubService } from '../../../../../platform/github/common/githubService.js';
import { GitHubReviewModel, isReviewLine } from '../../browser/githubReviewModel.js';

const pr: GitHubPullRequest = { number: 7, title: 'Review this', body: '', url: 'https://github.com/team/repo/pull/7', state: 'open', draft: false, mergedAt: null, headCommit: 'a'.repeat(40), headBranch: 'feature', headRepository: 'team/repo', baseBranch: 'main', mergeable: null, autoMerge: false };
function setup() {
	const accounts = new Emitter<AccountState>();
	const account: AccountState = { revision: 1n, accounts: [{ provider: 'github', accountId: 'alice', status: 'ready', credentialRevision: 1n }] };
	let current = pr;
	let submissions = 0;
	let failSubmission = false;
	const github: Partial<IGitHubService> = {
		listAccounts: async () => [{ id: 'alice', host: 'github.com', login: 'alice', status: 'ready', credentialRevision: 1n }],
		requestedReviewers: async () => ({ users: [], teams: [] }),
		readRepository: async () => ({ fullName: 'team/repo', defaultBranch: 'main', allowMergeCommit: true, allowSquashMerge: true, allowRebaseMerge: false, allowAutoMerge: true }),
		listPullRequests: async () => ({ items: [current], nextPage: 2 }),
		readPullRequest: async () => current,
		readReviewDiff: async () => ({ baseCommit: 'b'.repeat(40), files: { items: [{ filename: 'a.rs', previousFilename: null, status: 'modified', additions: 1, deletions: 1, changes: 2, patch: '@@ -1 +1 @@\n-old\n+new' }], nextPage: null, limitReached: false } }),
		readChecks: async () => ({ state: 'success', statuses: [], checks: [], nextPage: null }),
		listReviewThreads: async () => ({ threads: [], nextCursor: null }),
		listComments: async () => ({ items: [], nextPage: null }),
		listPullRequestReviews: async () => ({ items: [], nextPage: null }),
		reviewPullRequest: async () => { submissions++; if (failSubmission) { throw new GitHubError(GitHubErrorCode.SubmissionUncertain); } return { id: 1, commit: current.headCommit, body: 'Review', state: 'COMMENTED', url: `${pr.url}#review`, submittedAt: 'now' }; },
	};
	const accountService: IAccountService = { onDidChangeAccounts: accounts.event, onDidCompleteLogin: Event.None, read: async () => account, startLogin: async () => { throw new Error('Not used'); }, cancelLogin: async () => { }, logout: async () => { } };
	return { accounts, github, model: new GitHubReviewModel(github as IGitHubService, accountService), changeHead: () => { current = { ...pr, headCommit: 'c'.repeat(40) }; }, fail: () => { failSubmission = true; }, count: () => submissions };
}

test('review lines respect original and modified coordinates, hunk gaps and context', () => {
	const patch = '@@ -3,3 +3,3 @@\n context\n-removed\n+added\n context\n@@ -20 +21 @@\n-last\n+next';
	assert.equal(isReviewLine(patch, 4, GitHubDiffSide.Left), true);
	assert.equal(isReviewLine(patch, 4, GitHubDiffSide.Right), true);
	assert.equal(isReviewLine(patch, 10, GitHubDiffSide.Right), false);
	assert.equal(isReviewLine(patch, 20, GitHubDiffSide.Right), false);
	assert.equal(isReviewLine(patch, 21, GitHubDiffSide.Right), true);
	assert.equal(isReviewLine(null, 1, GitHubDiffSide.Left), false);
});

test('refresh preserves an old draft and blocks submitting it on a changed commit', async () => {
	const fixture = setup(); using model = fixture.model; using accounts = fixture.accounts;
	await model.loadRepository('team', 'repo'); await model.openPullRequest(7);
	assert.equal(model.nextPage, 2);
	model.setReviewBody('Keep this draft');
	model.addComment({ path: 'a.rs', line: 1, side: GitHubDiffSide.Left, body: 'Explain deletion' });
	fixture.changeHead(); await model.openPullRequest(7);
	assert.equal(model.staleDraft, true); assert.equal(model.draft?.body, 'Keep this draft');
	await assert.rejects(model.submitReview(GitHubReviewEvent.Comment), (error: unknown) => error instanceof GitHubError && error.code === GitHubErrorCode.Conflict);
	assert.equal(fixture.count(), 0);
	model.discardDraft(); assert.equal(model.canWrite, true);
	await model.submitReview(GitHubReviewEvent.Approve); assert.equal(fixture.count(), 1);
});

test('uncertain submissions retain drafts and cannot be repeated by reloading', async () => {
	const fixture = setup(); using model = fixture.model; using accounts = fixture.accounts;
	await model.loadRepository('team', 'repo'); await model.openPullRequest(7);
	model.setReviewBody('Review'); fixture.fail(); await model.submitReview(GitHubReviewEvent.Comment);
	assert.equal(model.submissionUncertain, true); assert.equal(model.draft?.body, 'Review');
	await model.openPullRequest(7);
	await assert.rejects(model.submitReview(GitHubReviewEvent.Comment)); assert.equal(fixture.count(), 1);
});

test('a GitHub account change cancels reads and retires private drafts while other provider changes do not', async () => {
	const fixture = setup(); using model = fixture.model; using accounts = fixture.accounts;
	await model.loadRepository('team', 'repo'); await model.openPullRequest(7); model.setReviewBody('Private draft');
	accounts.fire({ revision: 2n, accounts: [{ provider: 'github', accountId: 'alice', status: 'ready', credentialRevision: 1n }, { provider: 'openai', accountId: 'other', status: 'ready', credentialRevision: 1n }] });
	assert.equal(model.draft?.body, 'Private draft');
	let release!: (value: GitHubPullRequest) => void;
	fixture.github.readPullRequest = () => new Promise(resolve => { release = resolve; });
	const loading = model.openPullRequest(7);
	accounts.fire({ revision: 3n, accounts: [{ provider: 'github', accountId: 'bob', status: 'ready', credentialRevision: 2n }] });
	release(pr); await loading;
	assert.equal(model.pullRequest, undefined); assert.equal(model.draft, undefined); assert.equal(model.pullRequests.length, 0); assert.equal(model.busy, false);
	assert.equal(model.accountEpoch, 1); assert.equal(model.filter, GitHubIssueState.Open);
});

test('loading later replies does not duplicate a reply posted before the last page was loaded', async () => {
	const fixture = setup(); using model = fixture.model; using accounts = fixture.accounts;
	const first = { id: 'first', body: 'First', url: pr.url, author: 'alice', canUpdate: false, canDelete: false };
	const reply = { ...first, id: 'reply', body: 'New reply' };
	const thread: GitHubReviewThread = { id: 'thread', path: 'a.rs', line: 1, side: GitHubDiffSide.Right, resolved: false, outdated: false, canResolve: true, comments: { comments: [first], nextCursor: 'next' } };
	fixture.github.listReviewThreads = async () => ({ threads: [thread], nextCursor: null });
	fixture.github.replyReviewThread = async () => reply;
	fixture.github.readReviewThreadComments = async () => ({ comments: [reply], nextCursor: null });
	await model.loadRepository('team', 'repo'); await model.openPullRequest(7);
	await model.reply(model.threads[0]!, 'New reply');
	await model.moreThreadComments(model.threads[0]!);
	assert.deepEqual(model.threads[0]!.comments.comments.map(comment => comment.id), ['first', 'reply']);
	assert.equal(model.threads[0]!.comments.nextCursor, null);
});

test('initial account selection follows the GitHub catalog and other account updates preserve its draft', async () => {
	const fixture = setup(); using model = fixture.model; using accounts = fixture.accounts;
	fixture.github.listAccounts = async () => ['bob', 'alice'].map(id => ({ id, host: 'github.com', login: id, status: 'ready', credentialRevision: 1n }));
	await model.loadRepository('team', 'repo'); await model.openPullRequest(7); model.setReviewBody('Bob draft');
	assert.equal(model.repository?.accountId, 'bob');
	accounts.fire({ revision: 2n, accounts: ['alice', 'bob'].map(accountId => ({ provider: 'github', accountId, status: 'ready', credentialRevision: 1n })) });
	assert.equal(model.draft?.body, 'Bob draft'); assert.equal(model.accountEpoch, 0);
	model.selectAccount('alice'); assert.equal(model.draft, undefined); assert.equal(model.accountEpoch, 1);
});

test('opening without a backend does not cache a failed account initialization', async () => {
	const fixture = setup(); using model = fixture.model; using accounts = fixture.accounts;
	const list = fixture.github.listAccounts!; fixture.github.listAccounts = async () => { throw new GitHubError(GitHubErrorCode.Unavailable); };
	await model.initialize(); assert.equal(model.selectedAccount, undefined);
	fixture.github.listAccounts = list; await model.loadRepository('team', 'repo');
	assert.equal(model.repository?.accountId, 'alice'); assert.equal(model.pullRequests.length, 1);
});


test('an account change cancels inbox reads and does not display a late private notification', async () => {
	const fixture = setup(); using model = fixture.model; using accounts = fixture.accounts;
	await model.initialize();
	let release!: (value: { items: GitHubNotification[]; nextPage: number | null; }) => void;
	fixture.github.listNotifications = () => new Promise(resolve => { release = resolve; });
	const reading = model.loadNotifications(GitHubNotificationFilter.All);
	await Promise.resolve();
	accounts.fire({ revision: 2n, accounts: [{ provider: 'github', accountId: 'alice', credentialRevision: 2n, status: 'ready' }] });
	release({ items: [{ id: '1', title: 'Private', subjectType: 'Issue', reason: 'mention', unread: true, updatedAt: 'now', repository: { host: 'github.com', owner: 'team', name: 'repo' }, url: 'https://github.com/team/repo/issues/7' }], nextPage: null });
	await reading;
	assert.deepEqual({ items: model.notifications, selected: model.selectedNotification, busy: model.busy }, { items: [], selected: undefined, busy: false });
});

test('a fork with an uncertain result cannot be submitted again after repository reload', async () => {
	const fixture = setup(); using model = fixture.model; using accounts = fixture.accounts;
	let calls = 0;
	fixture.github.createFork = async () => { calls++; throw new GitHubError(GitHubErrorCode.SubmissionUncertain); };
	await model.loadRepository('team', 'repo');
	const fork = { organization: null, name: 'my-fork', branches: GitHubForkBranches.All };
	await model.createFork(fork); await model.loadRepository('team', 'repo'); await model.createFork(fork);
	assert.deepEqual({ calls, uncertain: model.submissionUncertain, fork: model.fork }, { calls: 1, uncertain: true, fork: undefined });
});

test('Codex requests post one PR comment, paginate discussion results and reject an unseen head', async () => {
	const fixture = setup(); using model = fixture.model; using accounts = fixture.accounts;
	const comment = { id: 12, body: '@codex review', url: `${pr.url}#comment`, updatedAt: 'now' };
	const writes: unknown[] = [];
	fixture.github.createComment = async (repository, number, body) => { writes.push({ repository, number, body }); return comment; };
	fixture.github.listComments = async (_repository, _number, page) => ({ items: page === 1 ? [] : [comment, { ...comment, id: 13, body: 'Review result' }], nextPage: page === 1 ? 2 : null });
	await model.loadRepository('team', 'repo'); await model.openPullRequest(7);
	await model.requestCodexReview();
	assert.deepEqual(writes, [{ repository: { accountId: 'alice', host: 'github.com', owner: 'team', name: 'repo' }, number: 7, body: '@codex review' }]);
	await assert.rejects(model.requestCodexReview());
	await model.morePullRequestComments();
	assert.deepEqual(model.pullRequestComments.map(comment => comment.id), [12, 13]);
	await model.openPullRequest(7); fixture.changeHead(); await model.requestCodexReview();
	assert.equal(writes.length, 1); assert.equal(model.ready, false);
});

test('uncertain Codex comment submissions stay blocked after refreshing the PR', async () => {
	const fixture = setup(); using model = fixture.model; using accounts = fixture.accounts;
	let writes = 0;
	fixture.github.createComment = async () => { writes++; throw new GitHubError(GitHubErrorCode.SubmissionUncertain); };
	await model.loadRepository('team', 'repo'); await model.openPullRequest(7); await model.requestCodexReview();
	assert.equal(model.submissionUncertain, true);
	await model.openPullRequest(7); await assert.rejects(model.requestCodexReview());
	assert.equal(writes, 1);
});
