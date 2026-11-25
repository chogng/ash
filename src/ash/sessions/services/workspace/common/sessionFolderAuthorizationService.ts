import type { IAgentConnection } from '../../../../platform/agentHost/common/agentService.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

export interface ISessionFolderAuthorizationService {
	/** Checks existing local directory permissions without prompting or granting access. */
	isTrusted(path: string): Promise<boolean>;

	/** Checks development permissions and confirms all missing grants on the same host in one prompt. */
	authorize(paths: readonly string[], signal: AbortSignal, options?: {
		readonly host?: { readonly api: IAgentConnection; readonly label: string; };
		/** Require a grant that can bind the directory as a workspace root. */
		readonly explicitGrant?: boolean;
		readonly onTrustDeclined?: () => void;
	}): Promise<boolean>;
}

export const ISessionFolderAuthorizationService = createServiceIdentifier<ISessionFolderAuthorizationService>('sessionFolderAuthorizationService');
