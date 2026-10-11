import { backend } from 'ash';
import { CancellationToken, CancellationError, AppServerRemoteError } from './support.js';
import type { GitCompareChangesParams, GitCompareChangesResult, GitCommitMessageResult, GitCommitDetailsResult } from '../../../.build/protocol/typescript/index.js';
import type { GitInitParams, GitCatalogResult, GitCommandParams, GitCommandResult, GitIndexDiffResult, GitIndexEditParams } from '../../../.build/protocol/typescript/index.js';
import type { ConfigCommandResult, ConfigReadResult, ConfigUpdateParams, GitBranchListResult, GitBranchSwitchParams, GitChangeFileParams, GitChangeFileResult, GitConflictFileParams, GitConflictFileResult, GitCompleteConflictParams, GitCloneParams, GitCloneResult, GitCommitChangesParams, GitCommitChangesResult, GitCommitFileParams, GitCommitFileResult, GitCommitParams, GitCommitResult, GitFetchParams, GitGraphParams, GitGraphResult, GitHistoryResult, GitOperationResult, GitPathsParams, GitRepositoriesResult, GitRepositoryParams, GitStatusResult } from "../../../.build/protocol/typescript/index.js";
import type { GitCheckIgnoreParams, GitCheckIgnoreResult } from '../../../.build/protocol/typescript/index.js';
import type { GitBranchCreateParams, GitBranchDeleteParams, GitWorktreeCreateParams, GitWorktreeCreateResult, GitWorktreeDeleteParams, GitWorktreeListResult, GitWorktreeResolveParams, GitWorktreeResolveResult } from '../../../.build/protocol/typescript/index.js';

export interface IGitApi {
	initialize(params: GitInitParams): Promise<GitRepositoriesResult>;
	catalog(params: GitRepositoryParams): Promise<GitCatalogResult>;
	executeCommand(params: GitCommandParams): Promise<GitCommandResult>;
	indexDiff(params: GitChangeFileParams): Promise<GitIndexDiffResult>;
	editIndex(params: GitIndexEditParams): Promise<GitOperationResult>;
	clone(params: GitCloneParams): Promise<GitCloneResult>;
	readConfig(): Promise<ConfigReadResult>;
	updateConfig(params: ConfigUpdateParams): Promise<ConfigCommandResult>;
	repositories(): Promise<GitRepositoriesResult>;
	status(params: GitRepositoryParams): Promise<GitStatusResult>;
	checkIgnore(params: Omit<GitCheckIgnoreParams, 'operationId'>, token?: CancellationToken): Promise<GitCheckIgnoreResult>;
	history(params: GitRepositoryParams): Promise<GitHistoryResult>;
	branches(params: GitRepositoryParams): Promise<GitBranchListResult>;
	createBranch(params: GitBranchCreateParams): Promise<GitBranchListResult>;
	deleteBranch(params: GitBranchDeleteParams): Promise<GitBranchListResult>;
	switchBranch(params: GitBranchSwitchParams): Promise<GitOperationResult>;
	worktrees(params: GitRepositoryParams): Promise<GitWorktreeListResult>;
	createWorktree(params: GitWorktreeCreateParams): Promise<GitWorktreeCreateResult>;
	deleteWorktree(params: GitWorktreeDeleteParams): Promise<GitWorktreeListResult>;
	resolveWorktree(params: GitWorktreeResolveParams): Promise<GitWorktreeResolveResult>;
	graph(params: GitGraphParams): Promise<GitGraphResult>;
	compareChanges(params: GitCompareChangesParams): Promise<GitCompareChangesResult>;
	commitMessage(params: GitCommitChangesParams): Promise<GitCommitMessageResult>;
	commitDetails(params: GitCommitChangesParams): Promise<GitCommitDetailsResult>;
	commitChanges(params: GitCommitChangesParams): Promise<GitCommitChangesResult>;
	commitFile(params: GitCommitFileParams): Promise<GitCommitFileResult>;
	changeFile(params: GitChangeFileParams): Promise<GitChangeFileResult>;
	conflictFile(params: GitConflictFileParams): Promise<GitConflictFileResult>;
	completeConflict(params: GitCompleteConflictParams): Promise<GitOperationResult>;
	stage(params: GitPathsParams): Promise<GitOperationResult>;
	unstage(params: GitPathsParams): Promise<GitOperationResult>;
	discardWorktree(params: GitPathsParams): Promise<GitOperationResult>;
	commit(params: GitCommitParams): Promise<GitCommitResult>;
	fetch(params: GitFetchParams): Promise<GitOperationResult>;
	pull(params: GitRepositoryParams): Promise<GitOperationResult>;
	push(params: GitRepositoryParams): Promise<GitOperationResult>;
}

async function call<T>(method: string, params: unknown): Promise<T> {
	const result = await backend.request<T | { backendError: { name: string; message: string; }; }>('git.repository', method, params);
	if (result && typeof result === 'object' && 'backendError' in result) { throw new AppServerRemoteError(result.backendError.name, result.backendError.message); }
	return result as T;
}

export function createGitApi(): IGitApi {
	return {
		initialize: params => call('initialize', params),
		catalog: params => call('catalog', params),
		executeCommand: params => call('executeCommand', params),
		indexDiff: params => call('indexDiff', params),
		editIndex: params => call('editIndex', params),
		clone: (params) => call('clone', params),
		readConfig: () => call('readConfig', {}),
		updateConfig: (params) => call('updateConfig', params),
		repositories: () => call('repositories', {}),
		status: (params) => call('status', params),
		checkIgnore: async (params, token = CancellationToken.None) => {
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}
			const operationId = `git-ignore-${crypto.randomUUID()}`;
			const result = call<GitCheckIgnoreResult>('checkIgnore', { ...params, operationId });
			let cancellation: Promise<unknown> | undefined;
			using listener = token.onCancellationRequested(() => {
				// Keep the original request registered until the server sends its terminal response.
				cancellation = call('cancelIgnore', { operationId });
				void cancellation.catch(() => undefined);
			});
			try {
				return await result;
			} catch (error) {
				if (error instanceof AppServerRemoteError && error.errorName === 'RequestCancelled') {
					throw new CancellationError();
				}
				throw error;
			} finally {
				await cancellation;
			}
		},
		history: (params) => call('history', params),
		branches: (params) => call('branches', params),
		createBranch: params => call('createBranch', params),
		deleteBranch: params => call('deleteBranch', params),
		switchBranch: (params) => call('switchBranch', params),
		worktrees: params => call('worktrees', params),
		createWorktree: params => call('createWorktree', params),
		deleteWorktree: params => call('deleteWorktree', params),
		resolveWorktree: params => call('resolveWorktree', params),
		graph: (params) => call('graph', params),
		compareChanges: params => call('compareChanges', params),
		commitMessage: params => call('commitMessage', params),
		commitDetails: params => call('commitDetails', params),
		commitChanges: (params) => call('commitChanges', params),
		commitFile: (params) => call('commitFile', params),
		changeFile: (params) => call('changeFile', params),
		conflictFile: (params) => call('conflictFile', params),
		completeConflict: (params) => call('completeConflict', params),
		stage: (params) => call('stage', params),
		unstage: (params) => call('unstage', params),
		discardWorktree: (params) => call('discardWorktree', params),
		commit: (params) => call('commit', params),
		fetch: (params) => call('fetch', params),
		pull: (params) => call('pull', params),
		push: (params) => call('push', params),
	};
}
