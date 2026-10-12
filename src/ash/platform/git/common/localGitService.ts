import { createDecorator } from '../../instantiation/common/instantiation.js';

export const ILocalGitService = createDecorator<ILocalGitService>('localGitService');

/** Host Git operations for App workflows, independent of the optional SCM extension. */
export interface ILocalGitService {
	readonly _serviceBrand: undefined;
	/** Clones into a new absolute host path. Ref selects a branch, tag or full commit ID. */
	clone(operationId: string, cloneUrl: string, targetPath: string, ref?: string): Promise<void>;
	/** Cancels only an operation issued by this connection, including before execution starts. */
	cancel(operationId: string): Promise<void>;
}
