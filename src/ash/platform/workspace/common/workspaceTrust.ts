import type { Event } from '../../../base/common/event.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { URI } from '../../../base/common/uri.js';
import { localize2 } from '../../../nls.js';

/** Exact Rust capabilities retained alongside the derived workspace trust state. */
export type WorkspaceTrustPermission =
	| 'readFiles'
	| 'writeFiles'
	| 'executeCommands'
	| 'watchFiles'
	| 'browseFiles'
	| 'searchFiles'
	| 'loadInstructions'
	| 'loadConfig'
	| 'discoverSkills'
	| 'discoverMcp'
	| 'useLanguageServices'
	| 'discoverHooks'
	| 'discoverPlugins'
	| 'inspectRepository'
	| 'mutateRepository';

/** Authorization selected by the host before entering a directory. */
export type WorkspaceTrustGrant =
	| { readonly type: 'config' }
	| { readonly type: 'host'; readonly permissions: readonly WorkspaceTrustPermission[] }
	| {
			readonly type: 'user';
			readonly commandId: string;
			readonly expectedRevision: number;
			readonly permissions: readonly WorkspaceTrustPermission[];
	  };

/** Backend directory identity and its exact grant, including partially authorized directories. */
export interface WorkspaceTrustEntry {
	readonly dir: string;
	readonly path: string | undefined;
	readonly permissions: readonly WorkspaceTrustPermission[];
}

export interface WorkspaceTrustSnapshot {
	readonly revision: number;
	readonly entries: readonly WorkspaceTrustEntry[];
}

export interface WorkspaceTrustCommandResult {
	readonly revision: number;
	readonly generation: number;
	readonly disposition: 'updated' | 'replayed';
}

/** Mechanical access to Rust authorization; it does not store a second trust list. */
export interface IWorkspaceTrustApi {
	readonly onDidChangeTrust: Event<void>;
	/** Reads the effective grant of an existing workspace directory without management authority. */
	readWorkspaceDirectory(dirId: string): Promise<readonly WorkspaceTrustPermission[] | undefined>;
	readDirectory(
		path: string,
	): Promise<{ readonly dir: string; readonly permissions: readonly WorkspaceTrustPermission[] | undefined }>;
	listDirectories(): Promise<WorkspaceTrustSnapshot>;
	setDirectoryPermissions(
		path: string,
		permissions: readonly WorkspaceTrustPermission[],
		expectedRevision: number,
	): Promise<WorkspaceTrustCommandResult>;
	forgetDirectory(dir: string, expectedRevision: number): Promise<WorkspaceTrustCommandResult>;
	createGrant(
		path: string,
		permissions: readonly WorkspaceTrustPermission[],
	): Promise<Extract<WorkspaceTrustGrant, { type: 'user' }>>;
	persistGrant(path: string, grant: WorkspaceTrustGrant): Promise<void>;
}

export const IWorkspaceTrustApi = createServiceIdentifier<IWorkspaceTrustApi>('workspaceTrustApi');

/** Choice made before Rust receives a grant for a newly opened folder. */
export type WorkspaceTrustChoice = 'development' | 'readOnly' | 'cancel';

/** The two choices offered when opening a directory without saved authorization. */
export const READ_DIR_PERMISSIONS: readonly WorkspaceTrustPermission[] = Object.freeze([
	'readFiles',
	'watchFiles',
	'browseFiles',
	'searchFiles',
	'inspectRepository',
]);

export const DEVELOPMENT_DIR_PERMISSIONS: readonly WorkspaceTrustPermission[] = Object.freeze([
	...READ_DIR_PERMISSIONS,
	'writeFiles',
	'executeCommands',
	'loadInstructions',
	'loadConfig',
	'discoverSkills',
	'discoverMcp',
	'useLanguageServices',
	'discoverHooks',
	'discoverPlugins',
	'mutateRepository',
]);

/** Frontend view of the current workspace's effective directory permissions. */
export interface IWorkspaceTrustInfo {
	readonly isTrusted: boolean;
	readonly isReadOnly: boolean;
}

export interface IWorkspaceTrustUriInfo {
	readonly trusted: boolean;
	readonly uri: URI;
	/** Undefined means no effective grant; an empty set is an explicit grant with no capabilities. */
	readonly permissions: readonly WorkspaceTrustPermission[] | undefined;
}

export interface IWorkspaceTrustManagementService {
	/** Published after the effective permissions and transition participants have settled. */
	readonly onDidChangeTrust: Event<boolean>;
	/** Invalidates permission projections, including changes that preserve the trust boolean. */
	readonly onDidChangeTrustedFolders: Event<void>;
	readonly workspaceResolved: Promise<void>;
	readonly workspaceTrustInitialized: Promise<void>;
	isWorkspaceTrusted(): boolean;
	canSetWorkspaceTrust(): boolean;
	resolveWorkspaceTrust(): Promise<void>;
	setWorkspaceTrust(trusted: boolean): Promise<void>;
	/** expectedRevision retains the revision approved in Ash's permission editor. */
	setUrisTrust(uris: URI[], trusted: boolean, expectedRevision?: number): Promise<void>;
	addWorkspaceTrustTransitionParticipant(participant: IWorkspaceTrustTransitionParticipant): IDisposable;
	getUriTrustInfo(uri: URI): Promise<IWorkspaceTrustUriInfo>;
	getWorkspaceTrustInfo(): Promise<IWorkspaceTrustInfo | undefined>;
}

export const IWorkspaceTrustManagementService = createServiceIdentifier<IWorkspaceTrustManagementService>(
	'workspaceTrustManagementService',
);

/** Startup directory authorization is available before Workbench services exist. */
export interface IDirectoryPermissionRequestService {
	requestDirectoryPermissions(path: string, signal?: AbortSignal): Promise<WorkspaceTrustChoice>;
}

export interface WorkspaceTrustRequestButton {
	readonly label: string;
	readonly type: 'ContinueWithTrust' | 'ContinueWithoutTrust' | 'Manage' | 'Cancel';
}

export interface WorkspaceTrustRequestOptions {
	readonly buttons?: WorkspaceTrustRequestButton[];
	readonly message?: string;
}

export interface IWorkspaceTrustRequestService {
	readonly onDidInitiateWorkspaceTrustRequest: Event<WorkspaceTrustRequestOptions | undefined>;
	readonly onDidInitiateWorkspaceTrustRequestOnStartup: Event<void>;
	requestWorkspaceTrust(options?: WorkspaceTrustRequestOptions): Promise<boolean | undefined>;
	requestWorkspaceTrustOnStartup(): void;
	completeWorkspaceTrustRequest(trusted?: boolean): Promise<void>;
	cancelWorkspaceTrustRequest(): void;
}

export const IWorkspaceTrustRequestService =
	createServiceIdentifier<IWorkspaceTrustRequestService>('workspaceTrustRequestService');

export interface IWorkspaceTrustTransitionParticipant {
	participate(trusted: boolean): Promise<void>;
}

/** English NLS originals; each consumer resolves them through its window's localization service. */
export const workspaceTrustPermissionNames: Readonly<Record<WorkspaceTrustPermission, string>> = {
	readFiles: localize2({ bundle: 'ash.settings', key: 'capabilities.permission.readFiles' }, 'Read files').original,
	writeFiles: localize2({ bundle: 'ash.settings', key: 'capabilities.permission.writeFiles' }, 'Write files')
		.original,
	executeCommands: localize2(
		{ bundle: 'ash.settings', key: 'capabilities.permission.executeCommands' },
		'Execute commands',
	).original,
	watchFiles: localize2({ bundle: 'ash.settings', key: 'capabilities.permission.watchFiles' }, 'Watch files')
		.original,
	browseFiles: localize2({ bundle: 'ash.settings', key: 'capabilities.permission.browseFiles' }, 'Browse files')
		.original,
	searchFiles: localize2({ bundle: 'ash.settings', key: 'capabilities.permission.searchFiles' }, 'Search files')
		.original,
	loadInstructions: localize2(
		{ bundle: 'ash.settings', key: 'capabilities.permission.loadInstructions' },
		'Load instructions',
	).original,
	loadConfig: localize2({ bundle: 'ash.settings', key: 'capabilities.permission.loadConfig' }, 'Load configuration')
		.original,
	discoverSkills: localize2(
		{ bundle: 'ash.settings', key: 'capabilities.permission.discoverSkills' },
		'Discover skills',
	).original,
	discoverMcp: localize2({ bundle: 'ash.settings', key: 'capabilities.permission.discoverMcp' }, 'Discover MCP')
		.original,
	useLanguageServices: localize2(
		{ bundle: 'ash.settings', key: 'capabilities.permission.useLanguageServices' },
		'Use language services',
	).original,
	discoverHooks: localize2({ bundle: 'ash.settings', key: 'capabilities.permission.discoverHooks' }, 'Discover hooks')
		.original,
	discoverPlugins: localize2(
		{ bundle: 'ash.settings', key: 'capabilities.permission.discoverPlugins' },
		'Discover plugins',
	).original,
	inspectRepository: localize2(
		{ bundle: 'ash.settings', key: 'capabilities.permission.inspectRepository' },
		'Inspect repository',
	).original,
	mutateRepository: localize2(
		{ bundle: 'ash.settings', key: 'capabilities.permission.mutateRepository' },
		'Modify repository',
	).original,
};
