import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import { AppServerRemoteError } from '../../agentHost/common/appServerError.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import { SecretStorageError, type ISecretStorageStatusService } from '../common/secrets.js';

export function createAppServerSecretStorageStatusService(connection: AppServerProtocolClient): ISecretStorageStatusService {
	return {
		readStatus: async () => (await withSecretStorageErrors(appServerRequest(connection, 'secrets/status', {}))).status,
	};
}

export function createDisconnectedSecretStorageStatusService(unavailable: UnavailableOperation): ISecretStorageStatusService {
	return { readStatus: () => unavailable('secrets.status') };
}

/** Domain adapters share storage errors without exposing transport diagnostics to the UI. */
export async function withSecretStorageErrors<T>(operation: Promise<T>): Promise<T> {
	try {
		return await operation;
	} catch (error) {
		if (error instanceof AppServerRemoteError) {
			switch (error.data.kind) {
				case 'SecretStorageUnavailable': throw new SecretStorageError('unavailable');
				case 'SecretStorageAccessDenied': throw new SecretStorageError('accessDenied');
				case 'SecretStorageKeyMissing': throw new SecretStorageError('keyMissing');
				case 'SecretStorageCorrupted': throw new SecretStorageError('corrupted');
				case 'SecretStorageMigrationFailed': throw new SecretStorageError('migrationFailed');
				case 'SecretStorageOperationFailed': throw new SecretStorageError('failure');
			}
		}
		throw error;
	}
}
