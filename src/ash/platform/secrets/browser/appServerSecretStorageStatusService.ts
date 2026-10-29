import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import type { SecretStorageStatusResult } from '../../../../../.build/protocol/typescript/index.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import { AppServerRemoteError } from '../../agentHost/common/appServerError.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import { SecretStorageError, type ISecretStorageStatusService, type SecretStorageState } from '../common/secrets.js';

export function createAppServerSecretStorageStatusService(connection: AppServerProtocolClient): ISecretStorageStatusService {
	return {
		readState: () => storageState(appServerRequest(connection, 'secrets/status', {})),
		authorizeAccess: () => storageState(appServerRequest(connection, 'secrets/authorize', {})),
		setStorageMode: mode => storageState(appServerRequest(connection, 'secrets/storageMode/set', { mode })),
	};
}

async function storageState(operation: Promise<SecretStorageStatusResult>): Promise<SecretStorageState> {
	const result = await withSecretStorageErrors(operation);
	return { status: result.status, ...(result.mode ? { mode: result.mode } : {}) };
}

export function createDisconnectedSecretStorageStatusService(unavailable: UnavailableOperation): ISecretStorageStatusService {
	return {
		readState: () => unavailable('secrets.status'),
		authorizeAccess: () => unavailable('secrets.authorize'),
		setStorageMode: () => unavailable('secrets.storageMode'),
	};
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
