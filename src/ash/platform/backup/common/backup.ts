import type { URI } from '../../../base/common/uri.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

/** Reopening information; the storage owner does not interpret windows or editor state. */
export interface IBackupWorkspace {
	readonly id: string;
	readonly folders: readonly URI[];
	readonly configuration?: URI;
	readonly remoteAuthority?: string;
}

export interface IBackupContent {
	readonly resource: URI;
	readonly format: string;
	readonly content: string;
}

export interface IBackupRecord {
	readonly content: IBackupContent;
	readonly revision: string;
	readonly updatedAt: number;
}

export class BackupError extends Error {
	constructor(public readonly code: 'conflict' | 'unavailable' | 'failed') {
		super(`Backup ${code}`);
		this.name = 'BackupError';
	}
}

/** Profile recovery content in the host-selected client namespace, retained across connection closure. */
export interface IBackupService {
	getWorkspaces(): Promise<readonly IBackupWorkspace[]>;
	list(workspaceId: string): Promise<readonly IBackupRecord[]>;
	/** Resolves after durable commit. Undefined creates a record; updates require the last observed revision. */
	store(workspace: IBackupWorkspace, content: IBackupContent, expectedRevision?: string): Promise<IBackupRecord>;
	discard(workspaceId: string, resource: URI, expectedRevision: string): Promise<void>;
}

export const IBackupService = createServiceIdentifier<IBackupService>('backupService');
