import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { DirPermission } from '../../dirPermissions/common/dirPermissionsService.js';

/** Choice made before Rust receives a grant for a newly opened folder. */
export type WorkspaceTrustChoice = 'development' | 'readOnly' | 'cancel';

/** The two choices offered when opening a directory without saved authorization. */
export const READ_DIR_PERMISSIONS: readonly DirPermission[] = Object.freeze([
	'readFiles', 'watchFiles', 'browseFiles', 'searchFiles', 'inspectRepository',
]);

export const DEVELOPMENT_DIR_PERMISSIONS: readonly DirPermission[] = Object.freeze([
	...READ_DIR_PERMISSIONS,
	'writeFiles', 'executeCommands', 'loadInstructions', 'loadConfig', 'discoverSkills',
	'discoverMcp', 'useLanguageServices', 'discoverHooks', 'discoverPlugins', 'mutateRepository',
]);

/** Frontend view of the current workspace's effective directory permissions. */
export interface IWorkspaceTrustInfo {
	readonly isTrusted: boolean;
	readonly isReadOnly: boolean;
}

export interface IWorkspaceTrustManagementService {
	/** Consumers reread after this event; Rust remains the authority for the permissions. */
	readonly onDidChangeTrust: Event<void>;
	getWorkspaceTrustInfo(): Promise<IWorkspaceTrustInfo | undefined>;
}

export const IWorkspaceTrustManagementService = createServiceIdentifier<IWorkspaceTrustManagementService>('workspaceTrustManagementService');

export interface IWorkspaceTrustRequestService {
	requestWorkspaceTrust(path: string): Promise<WorkspaceTrustChoice>;
}
