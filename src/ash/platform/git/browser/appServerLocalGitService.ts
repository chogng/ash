import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import { CancellationTokenSource, type CancellationToken } from '../../../base/common/cancellation.js';
import { raceCancellationError } from '../../../base/common/async.js';
import type { GitRepositoryContext, ILocalGitService } from '../common/localGitService.js';
import { APP_SERVER_METHODS } from '../../../../../.build/protocol/typescript/index.js';
import { AppServerRemoteError } from '../../agentHost/common/appServerError.js';
import { canceled } from '../../../base/common/errors.js';

/** Converts the App contract to typed Rust requests; it owns no Git or installation state. */
export class AppServerLocalGitService implements ILocalGitService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly connection: AppServerProtocolClient) { }

	async readRepositoryContexts(directory: { readonly sessionId: string; readonly path: string; }, token?: CancellationToken): Promise<readonly GitRepositoryContext[]> {
		const generation = this.connection.generation;
		using cancellation = new CancellationTokenSource(token);
		using subscription = this.connection.onStateChange(state => { if (state !== 'ready') cancellation.cancel(); });
		if (cancellation.token.isCancellationRequested || this.connection.state !== 'ready') throw canceled();
		const result = await raceCancellationError(appServerRequest(this.connection, 'git/repositoryContexts', { sessionDirectory: directory }), cancellation.token);
		if (cancellation.token.isCancellationRequested || generation !== this.connection.generation) throw canceled();
		return result.repositories.map(repository => ({
			id: repository.id, label: repository.label, path: repository.path, rootPath: repository.rootPath,
			head: { type: repository.head.type, name: 'name' in repository.head ? repository.head.name : '', ...('objectId' in repository.head ? { objectId: repository.head.objectId } : {}), ...('upstream' in repository.head && repository.head.upstream ? { upstream: { ...repository.head.upstream } } : {}) },
			remotes: repository.remotes.map(remote => ({ name: remote.name, ...(remote.identity ? { identity: { ...remote.identity } } : {}) })),
		}));
	}

	async clone(operationId: string, cloneUrl: string, targetPath: string, ref?: string): Promise<void> {
		// Git allows fifteen minutes for cloning, followed by bounded revision fetch and verification.
		try {
			await this.connection.request(APP_SERVER_METHODS['git/cloneTo'], {
				operationId, url: cloneUrl, targetPath, reference: ref ?? null,
			}, { timeoutMs: 20 * 60_000 });
		} catch (error) {
			if (error instanceof AppServerRemoteError && error.errorName === 'RequestCancelled') {
				throw canceled(error);
			}
			throw error;
		}
	}

	async cancel(operationId: string): Promise<void> {
		await appServerRequest(this.connection, 'git/cloneTo/cancel', { operationId });
	}
}

export function createDisconnectedLocalGitService(unavailable: UnavailableOperation): ILocalGitService {
	return {
		_serviceBrand: undefined,
		readRepositoryContexts: () => unavailable('git/repositoryContexts'),
		clone: () => unavailable('git/cloneTo'),
		cancel: () => unavailable('git/cloneTo/cancel'),
	};
}
