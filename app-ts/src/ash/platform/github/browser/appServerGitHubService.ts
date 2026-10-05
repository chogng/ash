import { CancellationToken } from '../../../base/common/cancellation.js';
import { CancellationError, onUnexpectedError } from '../../../base/common/errors.js';
import { generateUuid } from '../../../base/common/uuid.js';
import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../app-server/browser/appServerRequest.js';
import { AppServerRemoteError } from '../../app-server/common/appServerError.js';
import type { AppServerMethod, MethodParams, MethodResult } from '../../app-server/common/generated/index.js';
import { GitHubError, GitHubErrorCode } from '../common/githubService.js';
import type { IGitHubService, GitHubCommit, GitHubRepository, GitHubRepositoryInfo, GitHubIssueState, GitHubIssuePage, GitHubIssueDetails, GitHubCreateIssue, GitHubUpdateIssue, GitHubIssue, GitHubComment, GitHubPage, GitHubPullRequest, GitHubCreatePullRequest, GitHubUpdatePullRequest, GitHubPullRequestFiles, GitHubPullRequestReview, GitHubReview, GitHubMerge, GitHubMergeResult, GitHubChecks, GitHubLabel } from '../common/githubService.js';

type GitHubMethod = Exclude<Extract<AppServerMethod, `github/${string}`>, 'github/cancel'>;
enum RequestKind { Read, Write }

export class AppServerGitHubService implements IGitHubService {
	constructor(private readonly connection: AppServerProtocolClient) { }

	public async readCommit(repository: GitHubRepository, sha: string, token?: CancellationToken): Promise<GitHubCommit> {
		return { ...await this.request('github/commit/read', { repository, sha }, RequestKind.Read, token) };
	}

	public async readRepository(repository: GitHubRepository, token?: CancellationToken): Promise<GitHubRepositoryInfo> {
		return { ...await this.request('github/repository/read', { repository }, RequestKind.Read, token) };
	}
	public async listIssues(repository: GitHubRepository, state: GitHubIssueState, query: string, page: number, token?: CancellationToken): Promise<GitHubIssuePage> {
		const result = await this.request('github/issue/list', { repository, state, query, page }, RequestKind.Read, token);
		return { items: result.issues.map(issue => ({ ...issue })), nextPage: result.nextPage, notice: result.notice };
	}
	public async readIssue(repository: GitHubRepository, number: number, token?: CancellationToken): Promise<GitHubIssueDetails> {
		const result = await this.request('github/issue/read', { repository, number }, RequestKind.Read, token);
		return { ...result.issue, body: result.body, comments: result.comments.map(comment => ({ ...comment })) };
	}
	public async createIssue(repository: GitHubRepository, issue: GitHubCreateIssue, token?: CancellationToken): Promise<GitHubIssue> {
		const result = await this.request('github/issue/create', { repository, title: issue.title, body: issue.body, labels: [...issue.labels], assignees: [...issue.assignees] }, RequestKind.Write, token);
		return { ...result.issue, body: result.body };
	}
	public async updateIssue(repository: GitHubRepository, number: number, update: GitHubUpdateIssue, token?: CancellationToken): Promise<GitHubIssue> {
		const result = await this.request('github/issue/update', { repository, number, title: update.title ?? null, body: update.body ?? null, state: update.state ?? null, labels: update.labels ? [...update.labels] : null, assignees: update.assignees ? [...update.assignees] : null }, RequestKind.Write, token);
		return { ...result.issue, body: result.body };
	}
	public async listComments(repository: GitHubRepository, number: number, page: number, token?: CancellationToken): Promise<GitHubPage<GitHubComment>> {
		const result = await this.request('github/comment/list', { repository, number, page }, RequestKind.Read, token);
		return { items: result.comments.map(comment => ({ ...comment })), nextPage: result.nextPage };
	}
	public async createComment(repository: GitHubRepository, number: number, body: string, token?: CancellationToken): Promise<GitHubComment> {
		return { ...await this.request('github/comment/create', { repository, number, body }, RequestKind.Write, token) };
	}
	public async updateComment(repository: GitHubRepository, commentId: number, body: string, token?: CancellationToken): Promise<GitHubComment> {
		return { ...await this.request('github/comment/update', { repository, commentId, body }, RequestKind.Write, token) };
	}
	public async deleteComment(repository: GitHubRepository, commentId: number, token?: CancellationToken): Promise<void> {
		await this.request('github/comment/delete', { repository, commentId }, RequestKind.Write, token);
	}
	public async listPullRequests(repository: GitHubRepository, state: GitHubIssueState, page: number, token?: CancellationToken): Promise<GitHubPage<GitHubPullRequest>> {
		const result = await this.request('github/pullRequest/list', { repository, state, page }, RequestKind.Read, token);
		return { items: result.pullRequests.map(pullRequest => ({ ...pullRequest })), nextPage: result.nextPage };
	}
	public async readPullRequest(repository: GitHubRepository, number: number, token?: CancellationToken): Promise<GitHubPullRequest> {
		return { ...await this.request('github/pullRequest/read', { repository, number }, RequestKind.Read, token) };
	}
	public async createPullRequest(repository: GitHubRepository, request: GitHubCreatePullRequest, token?: CancellationToken): Promise<GitHubPullRequest> {
		return { ...await this.request('github/pullRequest/create', { repository, ...request }, RequestKind.Write, token) };
	}
	public async updatePullRequest(repository: GitHubRepository, number: number, update: GitHubUpdatePullRequest, token?: CancellationToken): Promise<GitHubPullRequest> {
		return { ...await this.request('github/pullRequest/update', { repository, number, title: update.title ?? null, body: update.body ?? null, state: update.state ?? null, base: update.base ?? null }, RequestKind.Write, token) };
	}
	public async listPullRequestFiles(repository: GitHubRepository, number: number, page: number, token?: CancellationToken): Promise<GitHubPullRequestFiles> {
		const result = await this.request('github/pullRequest/files', { repository, number, page }, RequestKind.Read, token);
		return { items: result.files.map(file => ({ ...file })), nextPage: result.nextPage, limitReached: result.limitReached };
	}
	public async listPullRequestReviews(repository: GitHubRepository, number: number, page: number, token?: CancellationToken): Promise<GitHubPage<GitHubPullRequestReview>> {
		const result = await this.request('github/pullRequest/reviews', { repository, number, page }, RequestKind.Read, token);
		return { items: result.reviews.map(review => ({ ...review })), nextPage: result.nextPage };
	}
	public async reviewPullRequest(repository: GitHubRepository, number: number, review: GitHubReview, token?: CancellationToken): Promise<GitHubPullRequestReview> {
		return { ...await this.request('github/pullRequest/review', { repository, number, ...review }, RequestKind.Write, token) };
	}
	public async mergePullRequest(repository: GitHubRepository, number: number, merge: GitHubMerge, token?: CancellationToken): Promise<GitHubMergeResult> {
		return { ...await this.request('github/pullRequest/merge', { repository, number, ...merge }, RequestKind.Write, token) };
	}
	public async enableAutoMerge(repository: GitHubRepository, number: number, merge: GitHubMerge, token?: CancellationToken): Promise<void> {
		await this.request('github/pullRequest/autoMerge', { repository, number, ...merge }, RequestKind.Write, token);
	}
	public async readChecks(repository: GitHubRepository, commit: string, page: number, token?: CancellationToken): Promise<GitHubChecks> {
		const result = await this.request('github/checks', { repository, commit, page }, RequestKind.Read, token);
		return { state: result.state, statuses: result.statuses.map(status => ({ ...status })), checks: result.checks.map(check => ({ ...check })), nextPage: result.nextPage };
	}
	public async listLabels(repository: GitHubRepository, token?: CancellationToken): Promise<readonly GitHubLabel[]> {
		const result = await this.request('github/labels/list', { repository }, RequestKind.Read, token);
		return result.labels.map(label => ({ ...label }));
	}
	public async createLabel(repository: GitHubRepository, label: GitHubLabel, token?: CancellationToken): Promise<GitHubLabel> {
		return { ...await this.request('github/label/create', { repository, ...label }, RequestKind.Write, token) };
	}
	public async updateLabelColor(repository: GitHubRepository, label: GitHubLabel, token?: CancellationToken): Promise<GitHubLabel> {
		return { ...await this.request('github/label/update', { repository, ...label }, RequestKind.Write, token) };
	}
	public async listAssignees(repository: GitHubRepository, token?: CancellationToken): Promise<readonly string[]> {
		const result = await this.request('github/assignees/list', { repository }, RequestKind.Read, token);
		return [...result.assignees];
	}

	private async request<M extends GitHubMethod>(method: M, params: Omit<MethodParams<M>, 'operationId'>, kind: RequestKind, token: CancellationToken = CancellationToken.None): Promise<MethodResult<M>> {
		if (token.isCancellationRequested) { throw new CancellationError(); }
		if (this.connection.state !== 'ready' || this.connection.capabilities?.github !== true || this.connection.capabilities.contracts.github?.version !== 1) { throw new GitHubError(GitHubErrorCode.Unavailable); }
		const operationId = generateUuid();
		const response = appServerRequest(this.connection, method, { ...params, operationId } as MethodParams<M>);
		const listener = token.onCancellationRequested(() => {
			// Cancellation acknowledges intent; the original response owns the remote outcome.
			void appServerRequest(this.connection, 'github/cancel', { operationId }).then(() => {}, onUnexpectedError);
		});
		try {
			const result = await response;
			if (kind === RequestKind.Read && token.isCancellationRequested) { throw new CancellationError(); }
			return result;
		} catch (error) {
			if (error instanceof CancellationError) { throw error; }
			if (error instanceof AppServerRemoteError) { throw githubError(error); }
			throw new GitHubError(kind === RequestKind.Write ? GitHubErrorCode.SubmissionUncertain : GitHubErrorCode.Unavailable);
		} finally { listener.dispose(); }
	}
}

export function createDisconnectedGitHubService(): IGitHubService {
	const unavailable = async (): Promise<never> => { throw new GitHubError(GitHubErrorCode.Unavailable); };
	return {
		readCommit: unavailable,
		readRepository: unavailable, listIssues: unavailable, readIssue: unavailable, createIssue: unavailable, updateIssue: unavailable,
		listComments: unavailable, createComment: unavailable, updateComment: unavailable, deleteComment: unavailable,
		listPullRequests: unavailable, readPullRequest: unavailable, createPullRequest: unavailable, updatePullRequest: unavailable,
		listPullRequestFiles: unavailable, listPullRequestReviews: unavailable, reviewPullRequest: unavailable, mergePullRequest: unavailable, enableAutoMerge: unavailable,
		readChecks: unavailable, listLabels: unavailable, createLabel: unavailable, updateLabelColor: unavailable, listAssignees: unavailable,
	};
}

function githubError(error: AppServerRemoteError): Error {
	switch (error.errorName) {
		case 'RequestCancelled': return new CancellationError();
		case 'InvalidParams': return new GitHubError(GitHubErrorCode.InvalidInput);
		case 'AccountAuthenticationRequired': return new GitHubError(GitHubErrorCode.AuthenticationRequired);
		case 'GitHubPermissionDenied': return new GitHubError(GitHubErrorCode.PermissionDenied);
		case 'GitHubRateLimited': return new GitHubError(GitHubErrorCode.RateLimited);
		case 'GitHubNotFound': return new GitHubError(GitHubErrorCode.NotFound);
		case 'GitHubConflict': return new GitHubError(GitHubErrorCode.Conflict);
		case 'GitHubTimedOut': return new GitHubError(GitHubErrorCode.TimedOut);
		case 'GitHubSubmissionUncertain': return new GitHubError(GitHubErrorCode.SubmissionUncertain);
		case 'AccountUnavailable': case 'GitHubUnavailable': return new GitHubError(GitHubErrorCode.Unavailable);
		default: return new GitHubError(GitHubErrorCode.OperationFailed);
	}
}
