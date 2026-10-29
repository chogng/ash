import type { URI } from '../../../base/common/uri.js';
import type { Event } from '../../../base/common/event.js';
import type { ResourceMetadataResult } from '../../agentHost/common/appServerApi.js';
import type { FileDeleteMode, FileExistingTargetBehavior, FileMissingTargetBehavior, IFileReadOptions } from './files.js';

/** A path within an already authorized environment or Session directory. */
interface FileTarget {
	readonly dirId?: string;
	readonly sessionDirectory?: { readonly sessionId: string; readonly path: string };
	readonly path: string;
}

type FileEntryType = 'directory' | 'file' | 'symbolicLink' | 'other';

interface FileMetadata {
	readonly fileType: FileEntryType;
	readonly sizeBytes: number;
	readonly readonly: boolean;
	readonly modifiedAtMillis: number | null;
}

interface FilePublicationOptions {
	readonly mode: 'create' | 'replace' | 'createOrReplace';
	/** Unlocking is an explicit retry tied to the observed content revision. */
	readonly unlock?: boolean;
	readonly expectedRevision?: string;
}

interface FilePublication {
	readonly metadata: FileMetadata;
	/** Exact-content revision to use for a later conditional write. */
	readonly revision: string;
}

export interface IFileSystemDirectory {
	readonly uri: URI;
	readonly target: { readonly type: 'environment'; readonly dirId: string } | { readonly type: 'session'; readonly sessionId: string; readonly path: string };
}

export interface IFileApi {
	/** Discover an existing backend-authorized root; this does not grant access. */
	resolvePath(resource: URI): Promise<IFileSystemDirectory>;
	readonly connectionGeneration: number;
	readonly onDidChangeConnection: Event<void>;
	readPathCaseSensitivity(params: FileTarget): Promise<{
		readonly scopes: readonly {
			readonly path: string;
			readonly sensitivity: 'sensitive' | 'insensitive' | 'unknown';
		}[];
	}>;
	writeFileElevated(
		params: FileTarget & {
			readonly operationId: string;
			readonly dataBase64: string;
			readonly expectedRevision?: string;
			readonly encoding?: string;
		},
		signal?: AbortSignal,
	): Promise<FilePublication>;
	getMetadata(params: FileTarget): Promise<FileMetadata>;
	readDirectory(params: FileTarget): Promise<{ readonly entries: readonly { readonly name: string; readonly fileType: FileEntryType }[] }>;
	readFile(
		params: FileTarget &
			IFileReadOptions & {
				/** Exact callback proof; cannot widen the initiating Agent's file authority. */
				readonly readAccess?: string;
				readonly encoding?: string;
			},
	): Promise<{ readonly content: string; readonly revision: string; readonly encoding?: string }>;
	readBinaryFile(params: FileTarget): Promise<{ readonly resource: ResourceMetadataResult; readonly revision: string }>;
	writeFile(
		params: FileTarget & {
			readonly content: string;
			readonly expectedRevision?: string | null;
			readonly encoding?: string;
			readonly options?: FilePublicationOptions;
		},
	): Promise<FilePublication>;
	writeBinaryFile(params: FileTarget & { readonly dataBase64: string; readonly options?: FilePublicationOptions }): Promise<FilePublication>;
	createFile(params: FileTarget & { readonly existing: FileExistingTargetBehavior }): Promise<FileMetadata>;
	createDirectory(params: FileTarget): Promise<FileMetadata>;
	copy(params: {
		readonly sourceDirId?: string;
		readonly source: string;
		readonly targetDirId?: string;
		readonly target: string;
		readonly sessionDirectory?: FileTarget['sessionDirectory'];
	}): Promise<void>;
	pasteSystemFiles(params: FileTarget & { readonly moveRequested: boolean }): Promise<boolean>;
	rename(
		params: Omit<FileTarget, 'path'> & {
			readonly source: string;
			readonly target: string;
			readonly existing: FileExistingTargetBehavior;
		},
	): Promise<void>;
	delete(params: FileTarget & { readonly missing: FileMissingTargetBehavior; readonly mode: FileDeleteMode }): Promise<void>;
}
