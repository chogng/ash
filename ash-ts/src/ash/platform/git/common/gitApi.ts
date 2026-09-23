import type { ConfigCommandResult, ConfigReadResult, ConfigUpdateParams, GitBranchListResult, GitBranchSwitchParams, GitChangeFileParams, GitChangeFileResult, GitCommitChangesParams, GitCommitChangesResult, GitCommitFileParams, GitCommitFileResult, GitCommitParams, GitCommitResult, GitFetchParams, GitGraphParams, GitGraphResult, GitHistoryResult, GitOperationResult, GitPathsParams, GitRepositoriesResult, GitRepositoryParams, GitStatusResult } from "../../app-server/common/generated/index.js";

export interface IGitApi {
	readConfig(): Promise<ConfigReadResult>;
	updateConfig(params: ConfigUpdateParams): Promise<ConfigCommandResult>;
	repositories(): Promise<GitRepositoriesResult>;
	status(params: GitRepositoryParams): Promise<GitStatusResult>;
	history(params: GitRepositoryParams): Promise<GitHistoryResult>;
	branches(params: GitRepositoryParams): Promise<GitBranchListResult>;
	switchBranch(params: GitBranchSwitchParams): Promise<GitOperationResult>;
	graph(params: GitGraphParams): Promise<GitGraphResult>;
	commitChanges(params: GitCommitChangesParams): Promise<GitCommitChangesResult>;
	commitFile(params: GitCommitFileParams): Promise<GitCommitFileResult>;
	changeFile(params: GitChangeFileParams): Promise<GitChangeFileResult>;
	stage(params: GitPathsParams): Promise<GitOperationResult>;
	unstage(params: GitPathsParams): Promise<GitOperationResult>;
	discardWorktree(params: GitPathsParams): Promise<GitOperationResult>;
	commit(params: GitCommitParams): Promise<GitCommitResult>;
	fetch(params: GitFetchParams): Promise<GitOperationResult>;
	pull(params: GitRepositoryParams): Promise<GitOperationResult>;
	push(params: GitRepositoryParams): Promise<GitOperationResult>;
}
