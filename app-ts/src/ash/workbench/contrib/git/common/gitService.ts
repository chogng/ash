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
	readonly checkedOutElsewhere?: boolean;
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

export type GitReferenceKind = "localBranch" | "remoteBranch" | "tag";

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

export interface GitConflictFile {
	readonly stageIds: readonly (string | null)[];
	readonly resultObjectId: string | null;
	readonly base: GitCommitFileContent;
	readonly current: GitCommitFileContent;
	readonly incoming: GitCommitFileContent;
	readonly result: GitCommitFileContent;
}

export type GitConflictResolution = { readonly kind: 'edited'; readonly text: string } | { readonly kind: 'current' } | { readonly kind: 'incoming' };

/** Describes one bounded page of Git graph history requested by a frontend consumer. */
export interface GraphQuery {
	readonly limit: number;
	readonly cursor?: string;
}

export interface GitCommitResult {
	readonly objectId: string;
	readonly status: GitStatus;
}

export interface GitWorktree {
	/** Opaque checkout selector used for resolve and delete requests. */
	readonly checkoutRoot: string;
	/** Workspace folder preserving the source repository's nested directory. */
	readonly path: string;
	readonly branch: string | undefined;
	readonly head: string;
	readonly current: boolean;
	readonly state: 'ready' | 'threadOwned' | 'locked' | 'prunable' | 'invalid' | 'missingDirectory';
}

export type GitIntegration = 'merge' | 'rebase' | 'cherryPick';

/** Finite repository intents owned by the frontend Git domain. */
export type GitCommand =
	| { readonly kind: 'renameBranch'; readonly name: string; readonly newName: string }
	| { readonly kind: 'deleteRemoteBranch'; readonly remote: string; readonly name: string }
	| { readonly kind: 'merge' | 'rebase' | 'cherryPick'; readonly reference: string }
	| { readonly kind: 'continue' | 'abort'; readonly operation: GitIntegration }
	| { readonly kind: 'stash'; readonly message: string; readonly mode: 'tracked' | 'includeUntracked' }
	| { readonly kind: 'applyStash' | 'popStash' | 'dropStash'; readonly objectId: string }
	| { readonly kind: 'createTag'; readonly name: string; readonly reference: string }
	| { readonly kind: 'deleteTag' | 'removeRemote'; readonly name: string }
	| { readonly kind: 'addRemote'; readonly name: string; readonly url: string }
	| { readonly kind: 'amend'; readonly message: string }
	| { readonly kind: 'undoCommit'; readonly expectedHead: string };

export interface GitCatalog {
	readonly tags: readonly { readonly name: string; readonly objectId: string }[];
	readonly stashes: readonly { readonly objectId: string; readonly subject: string }[];
	readonly remotes: readonly string[];
	readonly operation: GitIntegration | undefined;
}

export interface GitCommandResult {
	readonly status: GitStatus;
	readonly outcome: 'completed' | 'conflicted';
	readonly operation: GitIntegration | undefined;
}

export type GitIndexSelection = { readonly kind: 'hunk'; readonly index: number } | { readonly kind: 'lines'; readonly start: number; readonly end: number };

export interface GitIndexDiff {
	readonly original: string | null;
	readonly modified: string | null;
	readonly hunks: readonly { readonly index: number; readonly oldStart: number; readonly oldCount: number; readonly newStart: number; readonly newCount: number; readonly preview: string }[];
}

export class GitWorkspaceError extends Error {
	constructor(readonly reason: 'noFolder' | 'noRepository') {
		super(reason);
	}
}

/** Frontend Git operations and repository updates for the active workspace. */
export interface IGitService {
	initializeRepository(initialBranch: string, dirId: string): Promise<void>;
	catalog(repositoryId?: string): Promise<GitCatalog>;
	executeCommand(command: GitCommand, repositoryId?: string): Promise<GitCommandResult>;
	indexDiff(path: string, comparison: GitChangeFileComparison, repositoryId?: string): Promise<GitIndexDiff>;
	editIndex(path: string, comparison: GitChangeFileComparison, reviewed: GitIndexDiff, selection: GitIndexSelection, repositoryId?: string): Promise<GitStatus>;
	readonly canCloneRepository: boolean;
	cloneRepository(url: string, parentPath: string): Promise<string>;
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
	/** Resolves the operation target before async UI or queries can change the active repository. */
	getRepository(repositoryId?: string): Promise<GitRepository>;
	selectRepository(repositoryId: string): Promise<GitStatus>;
	repositoryForResource(resource: URI): GitRepository | undefined;
	checkIgnore(resources: readonly URI[]): Promise<readonly URI[]>;
	status(repositoryId?: string): Promise<GitStatus>;
	history(repositoryId?: string): Promise<readonly GitCommitSummary[]>;
	branches(repositoryId?: string): Promise<readonly GitBranch[]>;
	/** Creates a branch at HEAD without switching the current checkout. */
	createBranch(name: string, repositoryId?: string): Promise<void>;
	/** Git rejects unmerged branches and branches checked out in any worktree. */
	deleteBranch(name: string, repositoryId?: string): Promise<void>;
	switchBranch(name: string, repositoryId?: string): Promise<GitStatus>;
	worktrees(repositoryId?: string): Promise<readonly GitWorktree[]>;
	/** Creates an unbound detached checkout under the backend's configured worktree root. */
	createWorktree(name: string, repositoryId?: string): Promise<string>;
	/** Removes a clean, unbound linked checkout; session-owned checkouts use their session lifecycle. */
	deleteWorktree(checkoutRoot: string, repositoryId?: string): Promise<void>;
	resolveWorktree(checkoutRoot: string, repositoryId?: string): Promise<string>;
	graph(query: GraphQuery, repositoryId?: string): Promise<GraphPage>;
	commitChanges(objectId: string, repositoryId?: string): Promise<GitCommitChanges>;
	commitFile(objectId: string, path: string, repositoryId?: string): Promise<GitCommitFile>;
	changeFile(path: string, comparison: GitChangeFileComparison, repositoryId?: string): Promise<GitChangeFile>;
	conflictFile(path: string, repositoryId?: string): Promise<GitConflictFile>;
	completeConflict(path: string, expectedStageIds: readonly (string | null)[], expectedResultObjectId: string | null, resolution: GitConflictResolution, repositoryId?: string): Promise<GitStatus>;
	stage(paths: readonly string[], repositoryId?: string): Promise<GitStatus>;
	unstage(paths: readonly string[], repositoryId?: string): Promise<GitStatus>;
	discardWorktree(paths: readonly string[], repositoryId?: string): Promise<GitStatus>;
	commit(message: string, repositoryId?: string): Promise<GitCommitResult>;
	fetch(repositoryId?: string): Promise<GitStatus>;
	pull(repositoryId?: string): Promise<GitStatus>;
	push(repositoryId?: string): Promise<GitStatus>;
}

export const IGitService = createServiceIdentifier<IGitService>("gitService");
