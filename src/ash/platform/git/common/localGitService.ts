import type { CancellationToken } from '../../../base/common/cancellation.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const ILocalGitService = createDecorator<ILocalGitService>('localGitService');

export interface GitRepositoryContext {
	readonly id: string;
	readonly label: string;
	readonly path: string;
	readonly rootPath: string;
	readonly head: {
		readonly type: string;
		readonly name: string;
		readonly objectId?: string;
		readonly upstream?: { readonly name: string; readonly ahead: number; readonly behind: number };
	};
	readonly remotes: readonly {
		readonly name: string;
		readonly identity?: {
			readonly provider: string;
			readonly host: string;
			readonly owner: string;
			readonly repository: string;
		};
	}[];
}

/** Host Git operations for App workflows, independent of the optional SCM extension. */
export interface ILocalGitService {
	readonly _serviceBrand: undefined;
	/** Read-only repository metadata authorized by this Session's execution directory. */
	readRepositoryContexts(
		directory: { readonly sessionId: string; readonly path: string },
		token?: CancellationToken,
	): Promise<readonly GitRepositoryContext[]>;
	/** Clones into a new absolute host path. Ref selects a branch, tag or full commit ID. */
	clone(operationId: string, cloneUrl: string, targetPath: string, ref?: string): Promise<void>;
	/** Cancels only an operation issued by this connection, including before execution starts. */
	cancel(operationId: string): Promise<void>;
}
