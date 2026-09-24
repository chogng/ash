import type { Event } from "../../../../base/common/event.js";
import type { URI } from "../../../../base/common/uri.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import type { GitAutofetch } from './gitConfiguration.js';

export type GitChangeStatus = "unmodified" | "modified" | "added" | "deleted" | "renamed" | "copied" | "typeChanged" | "unmerged" | "untracked" | "ignored";

export interface GitUpstream {
	readonly name: string;
	readonly ahead: number;
	readonly behind: number;
}

export type GitHead =
	| { readonly type: "branch"; readonly name: string; readonly objectId: string; readonly upstream: GitUpstream | undefined }
	| { readonly type: "detached"; readonly objectId: string }
	| { readonly type: "unborn"; readonly name: string };

export interface GitSubmoduleState {
	readonly isSubmodule: boolean;
	readonly commitChanged: boolean;
	readonly trackedChanges: boolean;
	readonly untrackedChanges: boolean;
}

export interface GitRepositoryChange {
	readonly path: string;
	readonly originalPath: string | undefined;
	readonly indexStatus: GitChangeStatus;
	readonly worktreeStatus: GitChangeStatus;
	readonly conflicted: boolean;
	readonly submodule: GitSubmoduleState;
}

export interface GitStatus {
	readonly repositoryId: string;
	readonly streamInstanceId: string;
	readonly revision: number;
	readonly workspacePath: string;
	readonly head: GitHead;
	readonly changes: readonly GitRepositoryChange[];
}

export interface GitCommitSummary {
	readonly repositoryId: string;
	readonly objectId: string;
	readonly parentObjectIds: readonly string[];
	readonly timestampSeconds: number;
	readonly subject: string;
}

export interface GitRepository {
	readonly id: string;
	readonly label: string;
	readonly path: string;
	readonly root: URI;
}

export interface GitBranch {
	readonly name: string;
	readonly objectId: string;
	readonly current: boolean;
	readonly upstream: string | undefined;
}

export type GitRemoteProvider = "github" | "gitlab" | "bitbucket" | "other";

export interface GitRepositoryIdentity {
	readonly provider: GitRemoteProvider;
	readonly host: string;
	readonly owner: string;
	readonly repository: string;
}

export interface GitRemote {
	readonly name: string;
	readonly identity: GitRepositoryIdentity | undefined;
}

export type GitReferenceKind = "localBranch" | "remoteBranch";

export interface GitReference {
	readonly name: string;
	readonly objectId: string;
	readonly kind: GitReferenceKind;
	readonly remoteName: string | undefined;
	readonly current: boolean;
}

export interface GraphPage {
	readonly commits: readonly GitCommitSummary[];
	readonly references: readonly GitReference[];
	readonly remotes: readonly GitRemote[];
	readonly hasMore: boolean;
	readonly nextCursor: string | undefined;
}

export interface GitCommitChange {
	readonly path: string;
	readonly originalPath: string | undefined;
	readonly status: GitChangeStatus;
}

export interface GitCommitChanges {
	readonly parentObjectId: string | undefined;
	readonly changes: readonly GitCommitChange[];
}

export type GitCommitFileContent =
	| { readonly kind: "missing" }
	| { readonly kind: "binary" }
	| { readonly kind: "text"; readonly text: string };

export interface GitCommitFile {
	readonly original: GitCommitFileContent;
	readonly modified: GitCommitFileContent;
}

export type GitChangeFileComparison = "staged" | "unstaged";

export interface GitChangeFile {
	readonly original: GitCommitFileContent;
	readonly modified: GitCommitFileContent;
}

/** Describes one bounded page of Git graph history requested by a frontend consumer. */
export interface GraphQuery {
	readonly limit: number;
	readonly cursor?: string;
}

export interface GitCommitResult {
	readonly objectId: string;
	readonly status: GitStatus;
}

/** Frontend Git operations and repository updates for the active workspace. */
export interface IGitService {
	readonly onDidChangeAutoFetch: Event<void>;
	readonly autoFetch: GitAutofetch;
	readonly autoFetchPeriod: number;
	setAutoFetch(value: GitAutofetch): Promise<void>;
	setAutoFetchPeriod(seconds: number): Promise<void>;
	readonly onDidChangeStatus: Event<GitStatus>;
	readonly onDidChangeRepositoryStatus: Event<GitStatus>;
	readonly onDidChangeRepositories: Event<readonly GitRepository[]>;
	readonly onDidChangeActiveRepository: Event<GitRepository | undefined>;
	readonly onDidBecomeReady: Event<void>;
	readonly repositories: readonly GitRepository[];
	readonly activeRepository: GitRepository | undefined;
	listRepositories(): Promise<readonly GitRepository[]>;
	selectRepository(repositoryId: string): Promise<GitStatus>;
	repositoryForResource(resource: URI): GitRepository | undefined;
	status(repositoryId?: string): Promise<GitStatus>;
	history(repositoryId?: string): Promise<readonly GitCommitSummary[]>;
	branches(repositoryId?: string): Promise<readonly GitBranch[]>;
	switchBranch(name: string, repositoryId?: string): Promise<GitStatus>;
	graph(query: GraphQuery, repositoryId?: string): Promise<GraphPage>;
	commitChanges(objectId: string, repositoryId?: string): Promise<GitCommitChanges>;
	commitFile(objectId: string, path: string, repositoryId?: string): Promise<GitCommitFile>;
	changeFile(path: string, comparison: GitChangeFileComparison, repositoryId?: string): Promise<GitChangeFile>;
	stage(paths: readonly string[], repositoryId?: string): Promise<GitStatus>;
	unstage(paths: readonly string[], repositoryId?: string): Promise<GitStatus>;
	discardWorktree(paths: readonly string[], repositoryId?: string): Promise<GitStatus>;
	commit(message: string, repositoryId?: string): Promise<GitCommitResult>;
	fetch(repositoryId?: string): Promise<GitStatus>;
	pull(repositoryId?: string): Promise<GitStatus>;
	push(repositoryId?: string): Promise<GitStatus>;
}

export const IGitService = createServiceIdentifier<IGitService>("gitService");
