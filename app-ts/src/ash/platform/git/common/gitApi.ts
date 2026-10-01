import type { ConfigCommandResult, ConfigReadResult, ConfigUpdateParams, GitBranchListResult, GitBranchSwitchParams, GitChangeFileParams, GitChangeFileResult, GitConflictFileParams, GitConflictFileResult, GitCompleteConflictParams, GitCloneParams, GitCloneResult, GitCommitChangesParams, GitCommitChangesResult, GitCommitFileParams, GitCommitFileResult, GitCommitParams, GitCommitResult, GitFetchParams, GitGraphParams, GitGraphResult, GitHistoryResult, GitOperationResult, GitPathsParams, GitRepositoriesResult, GitRepositoryParams, GitStatusResult } from "../../app-server/common/generated/index.js";
import type { GitCheckIgnoreParams, GitCheckIgnoreResult } from '../../app-server/common/generated/index.js';

export interface IGitApi {
	clone(params: GitCloneParams): Promise<GitCloneResult>;
	readConfig(): Promise<ConfigReadResult>;
	updateConfig(params: ConfigUpdateParams): Promise<ConfigCommandResult>;
	repositories(): Promise<GitRepositoriesResult>;
	status(params: GitRepositoryParams): Promise<GitStatusResult>;
	checkIgnore(params: GitCheckIgnoreParams): Promise<GitCheckIgnoreResult>;
	history(params: GitRepositoryParams): Promise<GitHistoryResult>;
	branches(params: GitRepositoryParams): Promise<GitBranchListResult>;
	switchBranch(params: GitBranchSwitchParams): Promise<GitOperationResult>;
	graph(params: GitGraphParams): Promise<GitGraphResult>;
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
