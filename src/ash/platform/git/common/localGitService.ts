import type { CancellationToken } from '../../../base/common/cancellation.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const ILocalGitService = createDecorator<ILocalGitService>('localGitService');

export interface GitRepositoryContext {
	readonly id: string;
	readonly label: string;
	readonly path: string;
	readonly rootPath: string;
	readonly head: { readonly type: string; readonly name: string; readonly objectId?: string; readonly upstream?: { readonly name: string; readonly ahead: number; readonly behind: number; }; };
	readonly remotes: readonly { readonly name: string; readonly identity?: { readonly provider: string; readonly host: string; readonly owner: string; readonly repository: string; }; }[];
}

export type GitSessionComparison = { readonly kind: 'branches'; } | { readonly kind: 'uncommitted'; }
	| { readonly kind: 'branch'; readonly headObjectId: string; readonly baseObjectId: string; };

export type GitSessionComparisonContent = { readonly kind: 'text'; readonly text: string; } | { readonly kind: 'binary' | 'missing'; };

export type GitSessionComparisonSnapshot =
	| { readonly kind: 'branches'; readonly references: readonly { readonly name: string; readonly objectId: string; }[]; }
	| {
		readonly kind: 'changes'; readonly files: readonly {
			readonly path: string;
			readonly originalPath: string | null;
			readonly original: GitSessionComparisonContent;
			readonly modified: GitSessionComparisonContent;
		}[];
	};

/** Host Git operations for App workflows, independent of the optional SCM extension. */
export interface ILocalGitService {
	readonly _serviceBrand: undefined;
	/** Ready checkouts for a trusted source path, or for the connection's workspace repositories. */
	listWorktrees(token: CancellationToken, sourcePath?: string): Promise<readonly { readonly label: string; readonly path: string; readonly sourcePath: string; }[]>;
	/** Read-only repository metadata for this Session's execution directory. Returns an empty list when inspection is not authorized. */
	readRepositoryContexts(directory: { readonly sessionId: string; readonly path: string; }, token?: CancellationToken): Promise<readonly GitRepositoryContext[]>;
	readSessionComparison(directory: { readonly sessionId: string; readonly path: string; }, repositoryId: string, comparison: GitSessionComparison, signal: AbortSignal): Promise<GitSessionComparisonSnapshot>;
	/** Clones into a new absolute host path. Ref selects a branch, tag or full commit ID. */
	clone(operationId: string, cloneUrl: string, targetPath: string, ref?: string): Promise<void>;
	/** Cancels only an operation issued by this connection, including before execution starts. */
	cancel(operationId: string): Promise<void>;
}
