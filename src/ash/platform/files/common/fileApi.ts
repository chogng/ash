import type { FsCopyParams, FsCreateDirectoryParams, FsCreateFileParams, FsDeleteParams, FsGetMetadataParams, FsGetMetadataResult, FsPasteSystemFilesParams, FsReadBinaryFileParams, FsReadBinaryFileResult, FsReadDirectoryParams, FsReadDirectoryResult, FsReadFileParams, FsReadFileResult, FsRenameParams, FsWriteBinaryFileParams, FsWriteFileElevatedParams, FsWriteFileParams, FsWriteFileResult, FsReadPathCaseSensitivityParams, FsReadPathCaseSensitivityResult } from "../../../../../.build/protocol/typescript/index.js";
import type { URI } from '../../../base/common/uri.js';
import type { Event } from '../../../base/common/event.js';

export interface IFileSystemDirectory {
	readonly uri: URI;
	readonly target: { readonly type: 'environment'; readonly dirId: string; } | { readonly type: 'session'; readonly sessionId: string; readonly path: string; };
}

export interface IFileApi {
	/** Discover an existing backend-authorized root; this does not grant access. */
	resolvePath(resource: URI): Promise<IFileSystemDirectory>;
	readonly connectionGeneration: number;
	readonly onDidChangeConnection: Event<void>;
	readPathCaseSensitivity(params: FsReadPathCaseSensitivityParams): Promise<FsReadPathCaseSensitivityResult>;
	writeFileElevated(params: FsWriteFileElevatedParams, signal?: AbortSignal): Promise<FsWriteFileResult>;
	getMetadata(params: FsGetMetadataParams): Promise<FsGetMetadataResult>;
	readDirectory(params: FsReadDirectoryParams): Promise<FsReadDirectoryResult>;
	readFile(params: FsReadFileParams): Promise<FsReadFileResult>;
	readBinaryFile(params: FsReadBinaryFileParams): Promise<FsReadBinaryFileResult>;
	writeFile(params: FsWriteFileParams): Promise<FsWriteFileResult>;
	writeBinaryFile(params: FsWriteBinaryFileParams): Promise<FsWriteFileResult>;
	createFile(params: FsCreateFileParams): Promise<FsGetMetadataResult>;
	createDirectory(params: FsCreateDirectoryParams): Promise<FsGetMetadataResult>;
	copy(params: FsCopyParams): Promise<void>;
	pasteSystemFiles(params: FsPasteSystemFilesParams): Promise<boolean>;
	rename(params: FsRenameParams): Promise<void>;
	delete(params: FsDeleteParams): Promise<void>;
}
