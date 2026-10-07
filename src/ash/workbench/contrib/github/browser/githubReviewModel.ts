import { distinct } from '../../../../base/common/arrays.js';
import { CancellationTokenSource, type CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IAccountService, type AccountState } from '../../../../platform/accounts/common/accountService.js';
import { GitHubNotificationFilter, type GitHubComment, type GitHubNotification, type GitHubCreateFork, type GitHubFork, GitHubDiffSide, GitHubError, GitHubErrorCode, GitHubIssueState, IGitHubService, type GitHubAccount, type GitHubRequestedReviewers, type GitHubReviewComment, GitHubReviewerChange, type GitHubChecks, type GitHubCreateIssue, type GitHubCreatePullRequest, type GitHubIssueDetails, type GitHubIssueSummary, type GitHubMergeMethod, type GitHubPullRequest, type GitHubPullRequestFile, type GitHubPullRequestReview, type GitHubRepository, type GitHubRepositoryInfo, type GitHubReviewCommentInput, type GitHubReviewEvent, type GitHubReviewThread, type GitHubReviewThreadState, type GitHubUpdateIssue, type GitHubUpdatePullRequest } from '../../../../platform/github/common/githubService.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

export interface ReviewDraft {
	readonly commit: string;
	body: string;
	comments: GitHubReviewCommentInput[];
	uncertain: boolean;
}

export interface GitHubComposeDraft {
	readonly repositoryKey: string;
	readonly mode: 'pullRequests' | 'issues';
	readonly number: number | null;
	title: string;
	body: string;
	head: string;
	base: string;
	labels: string;
	assignees: string;
	draft: boolean;
}

export const IGitHubReviewModel = createServiceIdentifier<GitHubReviewModel>('githubReviewModel');
export type IGitHubReviewModel = GitHubReviewModel;

/** Window-owned drafts survive closing a review tab, but never cross a GitHub account change. */
export class GitHubReviewModel extends Disposable {
	private readonly change = this._register(new Emitter<void>());
	public readonly onDidChange = this.change.event;
	private operation = new CancellationTokenSource();
	private readonly drafts = new Map<string, ReviewDraft>();
	private accountRevision = -1n;
	private accountIdentity: string | undefined;
	private initialization: Promise<void> | undefined;
	private catalogGeneration = 0;
	public accounts: readonly GitHubAccount[] = [];
	public selectedAccount: GitHubAccount | undefined;
	public requestedReviewers: GitHubRequestedReviewers = { users: [], teams: [] };
	public repository: GitHubRepository | undefined;
	public repositoryInfo: GitHubRepositoryInfo | undefined;
	public mode: 'pullRequests' | 'issues' | 'notifications' = 'pullRequests';
	public notificationFilter = GitHubNotificationFilter.Unread;
	public notifications: readonly GitHubNotification[] = [];
	public selectedNotification: GitHubNotification | undefined;
	public notificationsReadAccepted = false;
	public fork: GitHubFork | undefined;
	public filter = GitHubIssueState.Open;
	public pullRequests: readonly GitHubPullRequest[] = [];
	public issues: readonly GitHubIssueSummary[] = [];
	public nextPage: number | null = null;
	public pullRequest: GitHubPullRequest | undefined;
	public issue: GitHubIssueDetails | undefined;
	public files: readonly GitHubPullRequestFile[] = [];
	public nextFilesPage: number | null = null;
	public filesLimitReached = false;
	public baseCommit: string | undefined;
	public reviews: readonly GitHubPullRequestReview[] = [];
	public nextReviewsPage: number | null = null;
	public threads: readonly GitHubReviewThread[] = [];
	public nextThreadsCursor: string | null = null;
	public checks: GitHubChecks | undefined;
	public nextCommentsPage: number | null = null;
	public pullRequestComments: readonly GitHubComment[] = [];
	public codexReviewRequested = false;
	public busy = false;
	public ready = false;
	public error: unknown;
	public accountEpoch = 0;
	public submissionUncertain = false;
	public compose: GitHubComposeDraft | undefined;

	constructor(
		@IGitHubService private readonly github: IGitHubService,
		@IAccountService private readonly accountService: IAccountService,
	) {
		super();
		this._register(accountService.onDidChangeAccounts(state => {
			this.accountChanged(state);
			void this.refreshAccounts().catch(error => { this.error = error; this.change.fire(); });
		}));
		this._register(toDisposable(() => { this.catalogGeneration++; this.operation.dispose(true); this.drafts.clear(); }));
	}

	public initialize(): Promise<void> {
		return this.initialization ??= (async () => {
			try { this.accountChanged(await this.accountService.read()); await this.refreshAccounts(); }
			catch (error) { this.initialization = undefined; this.error = error; this.change.fire(); }
		})();
	}
	public async refreshAccounts(): Promise<void> {
		const generation = ++this.catalogGeneration;
		const accounts = await this.github.listAccounts();
		if (generation !== this.catalogGeneration || this.isDisposed) { return; }
		this.accounts = accounts;
		this.selectedAccount = accounts.find(account => account.id === this.selectedAccount?.id) ?? (this.selectedAccount ? undefined : accounts[0]);
		if (this.selectedAccount) { this.accountIdentity = `${this.selectedAccount.id}/${this.selectedAccount.credentialRevision}/${this.selectedAccount.status}`; }
		this.change.fire();
	}
	public selectAccount(id: string): void {
		const account = this.accounts.find(account => account.id === id);
		if (!account || account.id === this.selectedAccount?.id) { return; }
		this.clearAccountContent(); this.selectedAccount = account; this.repository = undefined;
		this.accountIdentity = `${account.id}/${account.credentialRevision}/${account.status}`; this.change.fire();
	}
	public async connectToken(host: string, token: string): Promise<void> {
		await this.run(async cancellation => {
			const account = await this.github.connectToken(host, token, cancellation);
			if (!cancellation.isCancellationRequested) { await this.refreshAccounts(); this.selectAccount(account.id); }
		});
	}
	public async logoutSelectedAccount(): Promise<void> {
		const account = this.selectedAccount;
		if (account) { await this.accountService.logout('github', account.id); }
	}
	private clearAccountContent(): void {
		this.notifications = []; this.selectedNotification = undefined; this.notificationsReadAccepted = false; this.fork = undefined;
		this.accountEpoch++; this.submissionUncertain = false; this.nextPage = null; this.compose = undefined;
		this.cancelLoading(); this.drafts.clear(); this.clearSelection(); this.pullRequests = []; this.issues = []; this.repositoryInfo = undefined;
	}

	public get draft(): ReviewDraft | undefined { return this.pullRequest ? this.drafts.get(this.draftKey(this.pullRequest.number)) : undefined; }
	public get repositoryKey(): string | undefined { const repo = this.repository; return repo ? `${repo.host}/${repo.owner}/${repo.name}`.toLowerCase() : undefined; }
	public setCompose(draft: GitHubComposeDraft | undefined): void { this.compose = draft; this.change.fire(); }
	public get staleDraft(): boolean { return !!this.draft && (this.draft.body.length > 0 || this.draft.comments.length > 0) && this.draft.commit !== this.pullRequest?.headCommit; }
	public get canWrite(): boolean { return this.ready && !this.busy && !this.submissionUncertain && !this.draft?.uncertain && !this.staleDraft && this.pullRequest?.state === 'open' && !this.pullRequest.mergedAt; }

	public async loadRepository(owner: string, name: string, mode: 'pullRequests' | 'issues' = this.mode === 'notifications' ? 'pullRequests' : this.mode, filter = this.filter): Promise<void> {
		await this.initialize();
		if (this.busy) { return; }
		const account = this.selectedAccount;
		if (!account || account.status !== 'ready') { throw new GitHubError(GitHubErrorCode.AuthenticationRequired); }
		this.repository = { host: account.host, accountId: account.id, owner: owner.trim(), name: name.trim() };
		this.mode = mode;
		this.filter = filter;
		this.repositoryInfo = undefined;
		this.fork = undefined;
		this.nextPage = null;
		this.pullRequests = [];
		this.issues = [];
		this.clearSelection();
		await this.run(async token => {
			const repository = this.requireRepository();
			const info = await this.github.readRepository(repository, token);
			if (token.isCancellationRequested) { return; }
			this.repositoryInfo = info;
			if (mode === 'pullRequests') {
				const page = await this.github.listPullRequests(repository, filter, 1, token);
				if (token.isCancellationRequested) { return; }
				this.pullRequests = page.items; this.nextPage = page.nextPage;
			} else {
				const page = await this.github.listIssues(repository, filter, '', 1, token);
				if (token.isCancellationRequested) { return; }
				this.issues = page.items; this.nextPage = page.nextPage;
			}
		});
	}

	public async loadNotifications(filter = this.notificationFilter): Promise<void> {
		await this.initialize();
		const account = this.selectedAccount;
		if (!account || account.status !== 'ready') { throw new GitHubError(GitHubErrorCode.AuthenticationRequired); }
		if (this.busy) { return; }
		this.mode = 'notifications'; this.notificationFilter = filter; this.notifications = []; this.nextPage = null;
		this.compose = undefined; this.clearSelection(); this.notificationsReadAccepted = false;
		await this.run(async token => {
			const result = await this.github.listNotifications(account.id, filter, 1, token);
			if (!token.isCancellationRequested) { this.notifications = result.items; this.nextPage = result.nextPage; }
		});
	}
	public selectNotification(notification: GitHubNotification): void { this.selectedNotification = notification; this.change.fire(); }
	public async markNotificationRead(): Promise<void> {
		const account = this.selectedAccount; const notification = this.selectedNotification;
		if (!account || !notification) { return; }
		await this.run(async token => {
			await this.github.markNotificationRead(account.id, notification.id, token);
			if (!token.isCancellationRequested) {
				this.notifications = this.notifications.map(row => row.id === notification.id ? { ...row, unread: false } : row);
				this.selectedNotification = this.notifications.find(row => row.id === notification.id);
			}
		}, undefined, true);
	}
	public async markNotificationsRead(): Promise<void> {
		const account = this.selectedAccount;
		if (!account) { return; }
		await this.run(async token => {
			await this.github.markNotificationsRead(account.id, token);
			if (token.isCancellationRequested) { return; }
			this.notificationsReadAccepted = true;
			// GitHub can acknowledge this operation before processing all notifications.
			const result = await this.github.listNotifications(account.id, this.notificationFilter, 1, token);
			if (!token.isCancellationRequested) { this.notifications = result.items; this.nextPage = result.nextPage; this.selectedNotification = undefined; }
		}, undefined, true);
	}
	public async createFork(fork: GitHubCreateFork): Promise<void> {
		const repository = this.requireRepository();
		await this.run(async token => {
			const result = await this.github.createFork(repository, fork, token);
			if (!token.isCancellationRequested) { this.fork = result; }
		}, undefined, true);
	}

	public async moreItems(): Promise<void> {
		const page = this.nextPage;
		if (page === null) { return; }
		await this.run(async token => {
			if (this.mode === 'notifications') {
				const account = this.selectedAccount;
				if (!account) { throw new GitHubError(GitHubErrorCode.AuthenticationRequired); }
				const result = await this.github.listNotifications(account.id, this.notificationFilter, page, token);
				if (!token.isCancellationRequested) { this.notifications = distinct([...this.notifications, ...result.items], row => row.id); this.nextPage = result.nextPage; }
			} else if (this.mode === 'pullRequests') {
				const result = await this.github.listPullRequests(this.requireRepository(), this.filter, page, token);
				if (token.isCancellationRequested) { return; }
				this.pullRequests = distinct([...this.pullRequests, ...result.items], item => item.number); this.nextPage = result.nextPage;
			} else {
				const result = await this.github.listIssues(this.requireRepository(), this.filter, '', page, token);
				if (token.isCancellationRequested) { return; }
				this.issues = distinct([...this.issues, ...result.items], item => item.number); this.nextPage = result.nextPage;
			}
		});
	}

	public async openPullRequest(number: number): Promise<void> {
		if (this.busy) { return; }
		this.clearSelection();
		await this.run(async token => {
			const repository = this.requireRepository();
			const pr = await this.github.readPullRequest(repository, number, token);
			if (token.isCancellationRequested) { return; }
			this.pullRequest = pr; this.change.fire();
			const [diff, checks, threads, reviews, requestedReviewers, comments] = await Promise.all([
				this.github.readReviewDiff(repository, number, pr.headCommit, 1, token),
				this.github.readChecks(repository, pr.headCommit, 1, token),
				this.github.listReviewThreads(repository, number, null, token),
				this.github.listPullRequestReviews(repository, number, 1, token),
				this.github.requestedReviewers(repository, number, token),
				this.github.listComments(repository, number, 1, token),
			]);
			if (token.isCancellationRequested) { return; }
			this.baseCommit = diff.baseCommit; this.files = diff.files.items; this.nextFilesPage = diff.files.nextPage; this.filesLimitReached = diff.files.limitReached;
			this.checks = checks; this.threads = threads.threads; this.nextThreadsCursor = threads.nextCursor;
			this.reviews = reviews.items; this.nextReviewsPage = reviews.nextPage; this.requestedReviewers = requestedReviewers; this.pullRequestComments = comments.items; this.nextCommentsPage = comments.nextPage; this.ready = true;
		});
	}

	public async requestCodexReview(): Promise<void> {
		if (!this.canWrite || this.codexReviewRequested || this.repository?.host !== 'github.com') { throw new GitHubError(GitHubErrorCode.Conflict); }
		const repository = this.requireRepository(); const pr = this.requirePullRequest();
		await this.run(async token => {
			const current = await this.github.readPullRequest(repository, pr.number, token);
			if (token.isCancellationRequested) { return; }
			if (current.headCommit !== pr.headCommit || current.state !== 'open' || current.mergedAt) { throw new GitHubError(GitHubErrorCode.Conflict); }
			// This requests the official Connector; a posted comment does not prove the cloud review started.
			const comment = await this.github.createComment(repository, pr.number, '@codex review', token);
			if (!token.isCancellationRequested) { this.pullRequestComments = distinct([...this.pullRequestComments, comment], row => row.id); this.codexReviewRequested = true; }
		}, undefined, true);
	}

	public async morePullRequestComments(): Promise<void> {
		const page = this.nextCommentsPage; const pr = this.pullRequest;
		if (page === null || !pr) { return; }
		await this.run(async token => {
			const result = await this.github.listComments(this.requireRepository(), pr.number, page, token);
			if (!token.isCancellationRequested) { this.pullRequestComments = distinct([...this.pullRequestComments, ...result.items], row => row.id); this.nextCommentsPage = result.nextPage; }
		});
	}

	public async openIssue(number: number): Promise<void> {
		if (this.busy) { return; }
		this.clearSelection();
		await this.run(async token => {
			const [issue, comments] = await Promise.all([this.github.readIssue(this.requireRepository(), number, token), this.github.listComments(this.requireRepository(), number, 1, token)]);
			if (token.isCancellationRequested) { return; }
			this.issue = { ...issue, comments: comments.items }; this.nextCommentsPage = comments.nextPage; this.ready = true;
		});
	}

	public setReviewBody(body: string): void {
		if (!this.pullRequest || this.busy || this.staleDraft || this.draft?.uncertain) { return; }
		this.ensureDraft().body = body;
	}

	public addComment(comment: GitHubReviewCommentInput): void {
		if (!this.canWrite || (this.draft?.comments.length ?? 0) >= 100 || !comment.body.trim() || !isReviewLine(this.files.find(file => file.filename === comment.path)?.patch, comment.line, comment.side)) {
			throw new GitHubError(GitHubErrorCode.InvalidInput);
		}
		this.ensureDraft().comments.push(comment); this.change.fire();
	}

	public removeComment(index: number): void {
		if (this.busy || this.draft?.uncertain) { return; }
		this.draft?.comments.splice(index, 1); this.change.fire();
	}

	public discardDraft(): void {
		if (this.busy || !this.pullRequest) { return; }
		this.drafts.delete(this.draftKey(this.pullRequest.number)); this.change.fire();
	}

	public async submitReview(event: GitHubReviewEvent): Promise<void> {
		if (!this.canWrite || (this.pullRequest?.draft && event !== 'comment')) { throw new GitHubError(GitHubErrorCode.Conflict); }
		const pr = this.requirePullRequest();
		const draft = this.ensureDraft();
		await this.run(async token => {
			const result = await this.github.reviewPullRequest(this.requireRepository(), pr.number, { commit: draft.commit, event, body: draft.body, comments: draft.comments }, token);
			if (token.isCancellationRequested) { return; }
			this.drafts.delete(this.draftKey(pr.number)); this.reviews = [result, ...this.reviews];
			const threads = await this.github.listReviewThreads(this.requireRepository(), pr.number, null, token);
			if (!token.isCancellationRequested) { this.threads = threads.threads; this.nextThreadsCursor = threads.nextCursor; }
		}, draft);
	}

	public async merge(method: GitHubMergeMethod, auto: boolean): Promise<void> {
		if (!this.canWrite || this.pullRequest?.draft) { throw new GitHubError(GitHubErrorCode.Conflict); }
		const pr = this.requirePullRequest();
		await this.run(async token => {
			const repository = this.requireRepository();
			if (auto) { await this.github.enableAutoMerge(repository, pr.number, { commit: pr.headCommit, method }, token); }
			else { const result = await this.github.mergePullRequest(repository, pr.number, { commit: pr.headCommit, method }, token); if (!result.merged) { throw new GitHubError(GitHubErrorCode.Conflict); } }
			const current = await this.github.readPullRequest(repository, pr.number, token);
			if (!token.isCancellationRequested) { this.pullRequest = current; }
		}, undefined, true);
	}

	public async moreFiles(): Promise<void> {
		const page = this.nextFilesPage;
		if (page === null) { return; }
		await this.run(async token => {
			const pr = this.requirePullRequest();
			const diff = await this.github.readReviewDiff(this.requireRepository(), pr.number, pr.headCommit, page, token);
			if (token.isCancellationRequested) { return; }
			if (diff.baseCommit !== this.baseCommit) { throw new GitHubError(GitHubErrorCode.Conflict); }
			this.files = [...this.files, ...diff.files.items]; this.nextFilesPage = diff.files.nextPage; this.filesLimitReached = diff.files.limitReached;
		});
	}

	public async moreChecks(): Promise<void> {
		const previous = this.checks;
		if (!previous?.nextPage) { return; }
		await this.run(async token => {
			const result = await this.github.readChecks(this.requireRepository(), this.requirePullRequest().headCommit, previous.nextPage!, token);
			if (!token.isCancellationRequested) { this.checks = { ...result, checks: [...previous.checks, ...result.checks], statuses: result.statuses }; }
		});
	}

	public async moreReviews(): Promise<void> {
		const page = this.nextReviewsPage;
		if (page === null) { return; }
		await this.run(async token => {
			const result = await this.github.listPullRequestReviews(this.requireRepository(), this.requirePullRequest().number, page, token);
			if (!token.isCancellationRequested) { this.reviews = distinct([...this.reviews, ...result.items], item => item.id); this.nextReviewsPage = result.nextPage; }
		});
	}

	public async moreThreads(): Promise<void> {
		const cursor = this.nextThreadsCursor;
		if (!cursor) { return; }
		await this.run(async token => {
			const result = await this.github.listReviewThreads(this.requireRepository(), this.requirePullRequest().number, cursor, token);
			if (!token.isCancellationRequested) { this.threads = distinct([...this.threads, ...result.threads], thread => thread.id); this.nextThreadsCursor = result.nextCursor; }
		});
	}

	public async moreThreadComments(thread: GitHubReviewThread): Promise<void> {
		if (!thread.comments.nextCursor) { return; }
		await this.run(async token => {
			const result = await this.github.readReviewThreadComments(this.requireRepository(), this.requirePullRequest().number, thread.id, thread.comments.nextCursor, token);
			if (!token.isCancellationRequested) { this.replaceThread({ ...thread, comments: { comments: distinct([...thread.comments.comments, ...result.comments], comment => comment.id), nextCursor: result.nextCursor } }); }
		});
	}

	public async reply(thread: GitHubReviewThread, body: string): Promise<void> {
		await this.run(async token => {
			const comment = await this.github.replyReviewThread(this.requireRepository(), this.requirePullRequest().number, thread.id, body, token);
			if (!token.isCancellationRequested) { this.replaceThread({ ...thread, comments: { ...thread.comments, comments: [...thread.comments.comments, comment] } }); }
		}, undefined, true);
	}

	public async resolve(thread: GitHubReviewThread, state: GitHubReviewThreadState): Promise<void> {
		await this.run(async token => {
			await this.github.resolveReviewThread(this.requireRepository(), this.requirePullRequest().number, thread.id, state, token);
			if (!token.isCancellationRequested) { this.replaceThread({ ...thread, resolved: state === 'resolved' }); }
		}, undefined, true);
	}

	public async runLocalOperation(work: () => Promise<void>): Promise<void> { await this.run(() => work()); }

	public async changeReviewers(change: GitHubReviewerChange, users: readonly string[], teams: readonly string[]): Promise<void> {
		await this.run(async token => {
			const result = await this.github.changeReviewers(this.requireRepository(), this.requirePullRequest().number, change, users, teams, token);
			if (!token.isCancellationRequested) { this.requestedReviewers = result; }
		}, undefined, true);
	}
	public async editReviewComment(thread: GitHubReviewThread, comment: GitHubReviewComment, body: string): Promise<void> {
		if (!comment.canUpdate) { throw new GitHubError(GitHubErrorCode.PermissionDenied); }
		await this.run(async token => {
			const updated = await this.github.updateReviewComment(this.requireRepository(), this.requirePullRequest().number, comment.id, body, token);
			if (!token.isCancellationRequested) { this.replaceThread({ ...thread, comments: { ...thread.comments, comments: thread.comments.comments.map(item => item.id === comment.id ? updated : item) } }); }
		}, undefined, true);
	}
	public async deleteReviewComment(thread: GitHubReviewThread, comment: GitHubReviewComment): Promise<void> {
		if (!comment.canDelete) { throw new GitHubError(GitHubErrorCode.PermissionDenied); }
		await this.run(async token => {
			await this.github.deleteReviewComment(this.requireRepository(), this.requirePullRequest().number, comment.id, token);
			if (!token.isCancellationRequested) {
				const comments = thread.comments.comments.filter(item => item.id !== comment.id);
				if (comments.length === 0 && !thread.comments.nextCursor) { this.threads = this.threads.filter(item => item.id !== thread.id); }
				else { this.replaceThread({ ...thread, comments: { ...thread.comments, comments } }); }
			}
		}, undefined, true);
	}

	public async moreIssueComments(): Promise<void> {
		const issue = this.issue;
		const page = this.nextCommentsPage;
		if (!issue || page === null) { return; }
		await this.run(async token => {
			const result = await this.github.listComments(this.requireRepository(), issue.number, page, token);
			if (!token.isCancellationRequested) { this.issue = { ...issue, comments: distinct([...issue.comments, ...result.items], comment => comment.id) }; this.nextCommentsPage = result.nextPage; }
		});
	}

	public async commentOnIssue(body: string): Promise<void> {
		const issue = this.issue;
		if (!issue) { return; }
		await this.run(async token => {
			const result = await this.github.createComment(this.requireRepository(), issue.number, body, token);
			if (!token.isCancellationRequested) { this.issue = { ...issue, comments: [...issue.comments, result] }; }
		}, undefined, true);
	}

	public async createPullRequest(request: GitHubCreatePullRequest): Promise<void> {
		await this.run(async token => {
			const result = await this.github.createPullRequest(this.requireRepository(), request, token);
			if (!token.isCancellationRequested) { this.pullRequests = [result, ...this.pullRequests]; }
		}, undefined, true);
	}
	public async createIssue(issue: GitHubCreateIssue): Promise<void> {
		await this.run(async token => {
			const result = await this.github.createIssue(this.requireRepository(), issue, token);
			if (!token.isCancellationRequested) { this.issues = [result, ...this.issues]; }
		}, undefined, true);
	}
	public async updateItem(number: number, mode: 'pullRequests' | 'issues', update: GitHubUpdateIssue & GitHubUpdatePullRequest): Promise<void> {
		await this.run(async token => {
			if (mode === 'pullRequests') {
				const previous = this.pullRequest;
				const result = await this.github.updatePullRequest(this.requireRepository(), number, update, token);
				if (!token.isCancellationRequested) {
					if (previous?.number === number) {
						if (result.headCommit !== previous.headCommit || result.baseBranch !== previous.baseBranch) { this.ready = false; this.files = []; this.baseCommit = undefined; }
						this.pullRequest = result;
					}
					this.pullRequests = this.pullRequests.map(item => item.number === result.number ? result : item);
				}
			} else {
				const result = await this.github.updateIssue(this.requireRepository(), number, update, token);
				if (!token.isCancellationRequested) {
					if (this.issue?.number === number) { this.issue = { ...result, comments: this.issue.comments }; }
					this.issues = this.issues.map(item => item.number === result.number ? result : item);
				}
			}
		}, undefined, true);
	}

	public acknowledgeSubmission(): void { this.submissionUncertain = false; if (this.draft?.uncertain) { this.discardDraft(); } this.change.fire(); }

	public cancelLoading(): void { this.operation.dispose(true); this.operation = new CancellationTokenSource(); this.busy = false; }

	private async run(work: (token: CancellationToken) => Promise<void>, submittedDraft?: ReviewDraft, write = false): Promise<void> {
		if (this.busy || submittedDraft?.uncertain || ((submittedDraft || write) && this.submissionUncertain)) { return; }
		this.operation.dispose(true);
		const operation = this.operation = new CancellationTokenSource();
		this.busy = true; this.error = undefined; this.change.fire();
		try { await work(operation.token); }
		catch (error) {
			if (!operation.token.isCancellationRequested) {
				this.error = error;
				if (error instanceof GitHubError && error.code === GitHubErrorCode.Conflict) { this.ready = false; }
				if (submittedDraft && error instanceof GitHubError && error.code === GitHubErrorCode.SubmissionUncertain) { submittedDraft.uncertain = true; }
				if ((submittedDraft || write) && error instanceof GitHubError && error.code === GitHubErrorCode.SubmissionUncertain) { this.submissionUncertain = true; }
			}
		} finally { if (this.operation === operation) { this.busy = false; this.change.fire(); } }
	}

	private accountChanged(state: AccountState): void {
		if (state.revision <= this.accountRevision) { return; }
		this.accountRevision = state.revision;
		const github = state.accounts.find(account => account.provider === 'github' && (this.selectedAccount ? account.accountId === this.selectedAccount.id : true));
		const identity = github ? `${github.accountId}/${github.credentialRevision}/${github.status}` : '';
		if (this.accountIdentity !== undefined && identity !== this.accountIdentity) {
			this.clearAccountContent();
			this.error = new GitHubError(GitHubErrorCode.AuthenticationRequired); this.change.fire();
		}
		this.accountIdentity = identity;
	}

	private clearSelection(): void {
		this.selectedNotification = undefined;
		this.pullRequest = undefined; this.issue = undefined; this.files = []; this.baseCommit = undefined; this.checks = undefined;
		this.threads = []; this.reviews = []; this.pullRequestComments = []; this.codexReviewRequested = false; this.requestedReviewers = { users: [], teams: [] }; this.ready = false;
		this.nextFilesPage = null; this.nextReviewsPage = null; this.nextThreadsCursor = null; this.nextCommentsPage = null; this.filesLimitReached = false;
	}
	private requireRepository(): GitHubRepository { if (!this.repository) { throw new GitHubError(GitHubErrorCode.InvalidInput); } return this.repository; }
	private requirePullRequest(): GitHubPullRequest { if (!this.pullRequest) { throw new GitHubError(GitHubErrorCode.InvalidInput); } return this.pullRequest; }
	private draftKey(number: number): string { const repo = this.requireRepository(); return `${repo.host}/${repo.owner}/${repo.name}/${number}`.toLowerCase(); }
	private ensureDraft(): ReviewDraft {
		const pr = this.requirePullRequest(); const key = this.draftKey(pr.number);
		let draft = this.drafts.get(key);
		if (!draft || (!draft.uncertain && !draft.body && !draft.comments.length && draft.commit !== pr.headCommit)) { draft = { commit: pr.headCommit, body: '', comments: [], uncertain: false }; this.drafts.set(key, draft); }
		return draft;
	}
	private replaceThread(thread: GitHubReviewThread): void { this.threads = this.threads.map(item => item.id === thread.id ? thread : item); }
}

/** GitHub accepts new comments only on lines present in the PR patch, including its context. */
export function isReviewLine(patch: string | null | undefined, line: number, side: GitHubDiffSide): boolean {
	if (!patch || line < 1) { return false; }
	let left = 0; let right = 0; let inHunk = false;
	for (const text of patch.split('\n')) {
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
		if (hunk) { left = Number(hunk[1]); right = Number(hunk[2]); inHunk = true; continue; }
		if (!inHunk || ![' ', '+', '-'].includes(text[0] ?? '')) { continue; }
		if (side === GitHubDiffSide.Left && text[0] !== '+' && left === line) { return true; }
		if (side === GitHubDiffSide.Right && text[0] !== '-' && right === line) { return true; }
		if (text[0] !== '+') { left++; }
		if (text[0] !== '-') { right++; }
	}
	return false;
}
