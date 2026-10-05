import type { CancellationToken } from '../../../base/common/cancellation.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export enum GitHubIssueState { Open = 'open', Closed = 'closed' }
export enum GitHubMergeMethod { Merge = 'merge', Squash = 'squash', Rebase = 'rebase' }
export enum GitHubReviewEvent { Approve = 'approve', RequestChanges = 'requestChanges', Comment = 'comment' }
export enum GitHubErrorCode {
	InvalidInput = 'invalidInput',
	AuthenticationRequired = 'authenticationRequired',
	PermissionDenied = 'permissionDenied',
	RateLimited = 'rateLimited',
	NotFound = 'notFound',
	Conflict = 'conflict',
	Unavailable = 'unavailable',
	TimedOut = 'timedOut',
	SubmissionUncertain = 'submissionUncertain',
	OperationFailed = 'operationFailed',
}

export class GitHubError extends Error {
	constructor(public readonly code: GitHubErrorCode) {
		super(code);
		this.name = 'GitHubError';
	}
}

export interface GitHubRepository { readonly host: string; readonly owner: string; readonly name: string; }
export interface GitHubPage<T> { readonly items: readonly T[]; readonly nextPage: number | null; }
export interface GitHubRepositoryInfo {
	readonly defaultBranch: string;
	readonly fullName: string;
	readonly allowMergeCommit: boolean;
	readonly allowSquashMerge: boolean;
	readonly allowRebaseMerge: boolean;
	readonly allowAutoMerge: boolean;
}
export interface GitHubIssueSummary {
	readonly number: number;
	readonly title: string;
	readonly url: string;
	readonly updatedAt: string;
	readonly state: string;
	readonly labels: readonly string[];
	readonly assignees: readonly string[];
}
export interface GitHubIssue extends GitHubIssueSummary { readonly body: string; }
export interface GitHubIssueDetails extends GitHubIssue { readonly comments: readonly GitHubComment[]; }
export interface GitHubIssuePage extends GitHubPage<GitHubIssueSummary> { readonly notice: string; }
export interface GitHubComment { readonly id: number; readonly body: string; readonly url: string; readonly updatedAt: string; }
export interface GitHubCreateIssue { readonly title: string; readonly body: string; readonly labels: readonly string[]; readonly assignees: readonly string[]; }
export interface GitHubUpdateIssue { readonly title?: string; readonly body?: string; readonly state?: GitHubIssueState; readonly labels?: readonly string[]; readonly assignees?: readonly string[]; }
export interface GitHubPullRequest {
	readonly number: number;
	readonly title: string;
	readonly body: string;
	readonly url: string;
	readonly state: string;
	readonly draft: boolean;
	readonly mergedAt: string | null;
	readonly headCommit: string;
	readonly headBranch: string;
	readonly headRepository: string | null;
	readonly baseBranch: string;
	readonly autoMerge: boolean;
}
export interface GitHubCreatePullRequest { readonly title: string; readonly body: string; readonly head: string; readonly base: string; readonly draft: boolean; }
export interface GitHubUpdatePullRequest { readonly title?: string; readonly body?: string; readonly state?: GitHubIssueState; readonly base?: string; }
export interface GitHubPullRequestFile {
	readonly filename: string;
	readonly status: string;
	readonly additions: number;
	readonly deletions: number;
	readonly changes: number;
	readonly patch: string | null;
	readonly previousFilename: string | null;
}
export interface GitHubPullRequestFiles extends GitHubPage<GitHubPullRequestFile> { readonly limitReached: boolean; }
export interface GitHubPullRequestReview { readonly id: number; readonly body: string; readonly state: string; readonly url: string; readonly commit: string; readonly submittedAt: string | null; }
export interface GitHubReview { readonly commit: string; readonly event: GitHubReviewEvent; readonly body: string; }
/** The commit identifies the head the caller actually reviewed; GitHub enforces it during submission. */
export interface GitHubMerge { readonly commit: string; readonly method: GitHubMergeMethod; }
export interface GitHubMergeResult { readonly commit: string; readonly merged: boolean; readonly message: string; }
export interface GitHubCommitStatus { readonly context: string; readonly state: string; readonly description: string | null; readonly targetUrl: string | null; }
export interface GitHubCommit {
	readonly sha: string;
	readonly url: string;
	readonly message: string;
	readonly author: string;
	readonly committedAt: string;
	readonly additions: number;
	readonly deletions: number;
}
export interface GitHubCheckRun { readonly id: number; readonly name: string; readonly status: string; readonly conclusion: string | null; readonly detailsUrl: string | null; }
export interface GitHubChecks { readonly state: string; readonly statuses: readonly GitHubCommitStatus[]; readonly checks: readonly GitHubCheckRun[]; readonly nextPage: number | null; }
export interface GitHubLabel { readonly name: string; readonly color: string; }

/** GitHub business operations use the account grant owned by the backend login service. */
export interface IGitHubService {
	readCommit(repository: GitHubRepository, sha: string, token?: CancellationToken): Promise<GitHubCommit>;
	readRepository(repository: GitHubRepository, token?: CancellationToken): Promise<GitHubRepositoryInfo>;
	listIssues(repository: GitHubRepository, state: GitHubIssueState, query: string, page: number, token?: CancellationToken): Promise<GitHubIssuePage>;
	readIssue(repository: GitHubRepository, number: number, token?: CancellationToken): Promise<GitHubIssueDetails>;
	createIssue(repository: GitHubRepository, issue: GitHubCreateIssue, token?: CancellationToken): Promise<GitHubIssue>;
	updateIssue(repository: GitHubRepository, number: number, update: GitHubUpdateIssue, token?: CancellationToken): Promise<GitHubIssue>;
	listComments(repository: GitHubRepository, number: number, page: number, token?: CancellationToken): Promise<GitHubPage<GitHubComment>>;
	createComment(repository: GitHubRepository, number: number, body: string, token?: CancellationToken): Promise<GitHubComment>;
	updateComment(repository: GitHubRepository, commentId: number, body: string, token?: CancellationToken): Promise<GitHubComment>;
	deleteComment(repository: GitHubRepository, commentId: number, token?: CancellationToken): Promise<void>;
	listPullRequests(repository: GitHubRepository, state: GitHubIssueState, page: number, token?: CancellationToken): Promise<GitHubPage<GitHubPullRequest>>;
	readPullRequest(repository: GitHubRepository, number: number, token?: CancellationToken): Promise<GitHubPullRequest>;
	createPullRequest(repository: GitHubRepository, request: GitHubCreatePullRequest, token?: CancellationToken): Promise<GitHubPullRequest>;
	updatePullRequest(repository: GitHubRepository, number: number, update: GitHubUpdatePullRequest, token?: CancellationToken): Promise<GitHubPullRequest>;
	listPullRequestFiles(repository: GitHubRepository, number: number, page: number, token?: CancellationToken): Promise<GitHubPullRequestFiles>;
	listPullRequestReviews(repository: GitHubRepository, number: number, page: number, token?: CancellationToken): Promise<GitHubPage<GitHubPullRequestReview>>;
	reviewPullRequest(repository: GitHubRepository, number: number, review: GitHubReview, token?: CancellationToken): Promise<GitHubPullRequestReview>;
	mergePullRequest(repository: GitHubRepository, number: number, merge: GitHubMerge, token?: CancellationToken): Promise<GitHubMergeResult>;
	enableAutoMerge(repository: GitHubRepository, number: number, merge: GitHubMerge, token?: CancellationToken): Promise<void>;
	readChecks(repository: GitHubRepository, commit: string, page: number, token?: CancellationToken): Promise<GitHubChecks>;
	listLabels(repository: GitHubRepository, token?: CancellationToken): Promise<readonly GitHubLabel[]>;
	createLabel(repository: GitHubRepository, label: GitHubLabel, token?: CancellationToken): Promise<GitHubLabel>;
	updateLabelColor(repository: GitHubRepository, label: GitHubLabel, token?: CancellationToken): Promise<GitHubLabel>;
	listAssignees(repository: GitHubRepository, token?: CancellationToken): Promise<readonly string[]>;
}

export const IGitHubService = createServiceIdentifier<IGitHubService>('githubService');
