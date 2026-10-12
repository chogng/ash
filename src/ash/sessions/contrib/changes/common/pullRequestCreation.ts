import type { CancellationToken } from '../../../../base/common/cancellation.js';

export type SessionPullRequestMergeMethod = 'MERGE' | 'SQUASH' | 'REBASE';

/** Identity displayed by the form and checked again before submission. */
export interface ISessionPullRequestContext {
	readonly workingDirectory: string;
	readonly repository: string;
	readonly branchName: string;
	readonly baseBranchName: string;
}

export interface ISessionPullRequestOptions {
	readonly title: string;
	readonly description: string;
	readonly draft: boolean;
	readonly autoMergeMethod?: SessionPullRequestMergeMethod;
	readonly expectedContext: ISessionPullRequestContext;
}

export interface ISessionPullRequestChatOptions {
	readonly draft: boolean;
	readonly title?: string;
	readonly description?: string;
	readonly autoMergeMethod?: SessionPullRequestMergeMethod;
	readonly expectedContext: ISessionPullRequestContext;
}

export interface ISessionPullRequestDetails {
	readonly title: string;
	readonly description: string;
	readonly branchName: string;
	readonly baseBranchName: string;
	readonly repository: string;
	readonly autoMergeAllowed: boolean;
	readonly mergeMethods: readonly SessionPullRequestMergeMethod[];
	readonly context: ISessionPullRequestContext;
}

export interface ISessionPullRequestCreation {
	/** Reads editable defaults without publishing a branch or creating a PR. */
	prepare(token: CancellationToken): Promise<ISessionPullRequestDetails>;
	/** Returns the created URL and any warnings from post-creation operations. */
	create(options: ISessionPullRequestOptions): Promise<string>;
	/** Rechecks the captured repository before handing an explicit request to the Turn owner. */
	prepareChatRequest?(message: string, options: ISessionPullRequestChatOptions): Promise<string>;
}
