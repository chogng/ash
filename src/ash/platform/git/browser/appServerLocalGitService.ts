import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import type { ILocalGitService } from '../common/localGitService.js';
import { APP_SERVER_METHODS } from '../../../../../.build/protocol/typescript/index.js';
import { AppServerRemoteError } from '../../agentHost/common/appServerError.js';
import { canceled } from '../../../base/common/errors.js';

/** Converts the App contract to typed Rust requests; it owns no Git or installation state. */
export class AppServerLocalGitService implements ILocalGitService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly connection: AppServerProtocolClient) { }

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
		clone: () => unavailable('git/cloneTo'),
		cancel: () => unavailable('git/cloneTo/cancel'),
	};
}
