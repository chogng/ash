import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

/** Window-scoped GitHub account connection and authorization presentation. */
export interface IGitHubConnectionService {
	readonly isConnecting: boolean;
	connect(): Promise<void>;
}

export const IGitHubConnectionService = createServiceIdentifier<IGitHubConnectionService>('gitHubConnectionService');
