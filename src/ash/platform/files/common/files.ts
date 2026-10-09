import type { Event } from "../../../base/common/event.js";
import type { IDisposable } from "../../../base/common/lifecycle.js";
import type { URI } from "../../../base/common/uri.js";
import type { CancellationToken } from '../../../base/common/cancellation.js';
import type { VSBufferReadableStream } from '../../../base/common/buffer.js';
import type { ReadableStreamEvents } from '../../../base/common/stream.js';
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

/** Stable file kind used by Workbench consumers independently of wire DTOs. */
export enum FileKind {
	Directory = "directory",
	File = "file",
	SymbolicLink = "symbolicLink",
	Other = "other",
}

/** Metadata for one existing workspace resource. */
export interface IFileStat {
	readonly resource: URI;
	readonly kind: FileKind;
	readonly sizeBytes: number;
	readonly readonly: boolean;
	readonly modifiedAtMillis: number | undefined;
}

/** Text read from a workspace resource together with its opaque exact-content revision. */
export interface IFileContent {
	readonly resource: URI;
	readonly content: string;
	readonly revision: string;
}

/** Exact stored bytes read from a resource together with their opaque content revision. */
export interface IFileBytes {
	readonly resource: URI;
	readonly bytes: Uint8Array;
	readonly revision: string;
}

/** One conditional text write requested by a Workbench persistence service. */
export interface IFileWriteRequest {
	readonly resource: URI;
	readonly content: string;
	/** Omit only when intentionally creating or overwriting without a prior read. */
	readonly expectedRevision?: string;
}

/** Result of a workspace write, including the new opaque content revision. */
export interface IFileWriteResult {
	readonly stat: IFileStat;
	readonly revision: string;
}

export type FileExistingTargetBehavior = "error" | "overwrite" | "ignore";
export type FileMissingTargetBehavior = "error" | "ignore";
export type FileDeleteMode = "fileOrEmptyDirectory" | "recursive";

export enum FileSystemProviderCapabilities {
	None = 0,
	FileReadWrite = 1 << 1,
	FileOpenReadWriteClose = 1 << 2,
	FileFolderCopy = 1 << 3,
	FileReadStream = 1 << 4,
	FileWriteElevated = 1 << 5,
	FileWriteUnlock = 1 << 6,
	Readonly = 1 << 11,
}

/** Selects creation or replacement and optionally checks the stored content revision. */
export interface IFileWriteOptions {
	/** Explicit user retry; providers must reject it unless they own system elevation. */
	readonly writeElevated?: boolean;
	/** Explicit retry that makes an existing file writable without system elevation. */
	readonly unlock?: boolean;
	readonly create: boolean;
	readonly overwrite: boolean;
	readonly expectedRevision?: string;
}

export interface IWatchOptions {
	readonly recursive: boolean;
	readonly excludes: readonly string[];
}

export enum FileSystemProviderErrorCode {
	FileExists = 'EntryExists',
	FileNotFound = 'EntryNotFound',
	FileNotADirectory = 'EntryNotADirectory',
	FileIsADirectory = 'EntryIsADirectory',
	FileExceedsStorageQuota = 'EntryExceedsStorageQuota',
	FileTooLarge = 'EntryTooLarge',
	FileWriteLocked = 'EntryWriteLocked',
	NoPermissions = 'NoPermissions',
	Unavailable = 'Unavailable',
	Unknown = 'Unknown',
}

export interface IFileSystemProviderError extends Error {
	readonly code: FileSystemProviderErrorCode;
}

export class FileSystemProviderError extends Error implements IFileSystemProviderError {
	constructor(message: string, public readonly code: FileSystemProviderErrorCode) {
		super(message);
		this.name = `${code} (FileSystemError)`;
	}
}

export function createFileSystemProviderError(error: Error | string, code: FileSystemProviderErrorCode): FileSystemProviderError {
	return new FileSystemProviderError(typeof error === 'string' ? error : error.message, code);
}

/** Revives the stable category retained by channel error serialization. */
export function toFileSystemProviderErrorCode(error: Error | undefined | null): FileSystemProviderErrorCode {
	if (error instanceof FileSystemProviderError) { return error.code; }
	if (error?.name === 'FileNotFoundError') { return FileSystemProviderErrorCode.FileNotFound; }
	if (error?.name === 'FileOperationNotSupportedError') { return FileSystemProviderErrorCode.Unavailable; }
	return Object.values(FileSystemProviderErrorCode).find(code => error?.name === `${code} (FileSystemError)`) ?? FileSystemProviderErrorCode.Unknown;
}

export interface IFileReadLimits { readonly size?: number; }

export interface IFileReadStreamOptions {
	readonly position?: number;
	readonly length?: number;
	readonly limits?: IFileReadLimits;
}

export interface IReadFileStreamOptions extends IFileReadStreamOptions { }

export interface IFileStreamContent extends IFileStat {
	readonly value: VSBufferReadableStream;
}

export interface IFileOpenOptions { readonly create: boolean; }

export interface IFileSystemProviderWithFileReadStreamCapability extends IFileSystemProvider {
	readFileStream(resource: URI, options: IFileReadStreamOptions, token: CancellationToken): ReadableStreamEvents<Uint8Array>;
}

export interface IFileSystemProviderWithOpenReadWriteCloseCapability extends IFileSystemProvider {
	open(resource: URI, options: IFileOpenOptions): Promise<number>;
	read(fd: number, position: number, data: Uint8Array, offset: number, length: number): Promise<number>;
	write(fd: number, position: number, data: Uint8Array, offset: number, length: number): Promise<number>;
	close(fd: number): Promise<void>;
}

export function hasFileReadStreamCapability(provider: IFileSystemProvider): provider is IFileSystemProviderWithFileReadStreamCapability {
	return (provider.capabilities & FileSystemProviderCapabilities.FileReadStream) !== 0;
}

/** The file changed after a caller read its revision, so its write was rejected. */
export class FileRevisionConflictError extends Error {
	constructor(readonly resource: URI) {
		super(`File changed since it was read: ${resource.toString()}`);
		this.name = "FileRevisionConflictError";
	}
}

/** One direct child returned by a directory read. */
export interface IFileEntry {
	readonly resource: URI;
	readonly name: string;
	readonly kind: FileKind;
}

/** Coarse invalidation reported after workspace files may have changed on disk. */
export interface IFileChangeEvent {
	readonly resources: readonly URI[] | undefined;
}

/** Storage operations implemented by a runtime or virtual resource provider. */
export interface IFileSystemProvider {
	readonly capabilities: FileSystemProviderCapabilities;
	readonly onDidChangeCapabilities: Event<void>;
	readonly onDidChangeFiles: Event<IFileChangeEvent>;
	watch(resource: URI, options: IWatchOptions): IDisposable;
	stat(resource: URI): Promise<IFileStat>;
	readDirectory(resource: URI): Promise<readonly IFileEntry[]>;
	/** Reads exact stored bytes; the revision continues to identify those bytes across text decoding. */
	readFile(resource: URI): Promise<IFileBytes>;
	writeFile(resource: URI, content: Uint8Array, options: IFileWriteOptions, signal?: AbortSignal): Promise<IFileWriteResult>;
	createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat>;
	createDirectory(resource: URI): Promise<IFileStat>;
	/** Copies one file or directory, failing if the target exists. */
	copy(source: URI, target: URI): Promise<void>;
	rename(source: URI, target: URI, existing: FileExistingTargetBehavior): Promise<void>;
	delete(resource: URI, missing: FileMissingTargetBehavior, mode: FileDeleteMode): Promise<void>;
}

/** Routes file operations through explicitly registered resource schemes. */
export interface IFileService {
	readonly onDidChangeFiles: Event<IFileChangeEvent>;
	/** Releases this caller's watch; equivalent requests may share storage resources. */
	watch(resource: URI, options?: IWatchOptions): IDisposable;
	stat(resource: URI): Promise<IFileStat>;
	readDirectory(resource: URI): Promise<readonly IFileEntry[]>;
	readFile(resource: URI): Promise<IFileContent>;
	readFileBytes(resource: URI): Promise<IFileBytes>;
	readFileStream(resource: URI, options?: IReadFileStreamOptions, token?: CancellationToken): Promise<IFileStreamContent>;
	writeFile(request: IFileWriteRequest): Promise<IFileWriteResult>;
	/** Writes exact bytes; default import options reject existing files, including empty ones. */
	writeFileBytes(resource: URI, bytes: Uint8Array, options?: IFileWriteOptions, signal?: AbortSignal): Promise<IFileWriteResult>;
	createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat>;
	createDirectory(resource: URI): Promise<IFileStat>;
	copy(source: URI, target: URI): Promise<void>;
	rename(source: URI, target: URI, existing: FileExistingTargetBehavior): Promise<void>;
	delete(resource: URI, missing: FileMissingTargetBehavior, mode: FileDeleteMode): Promise<void>;
	/** One registration per scheme; disposal unregisters it without disposing the caller-owned provider. */
	registerProvider(scheme: string, provider: IFileSystemProvider): IDisposable;
	/** Reports routing availability, which does not imply that the provider's storage is currently accessible. */
	hasProvider(resource: URI): boolean;
	hasCapability(resource: URI, capability: FileSystemProviderCapabilities): boolean;
}

export class FileNotFoundError extends FileSystemProviderError {
	constructor(readonly resource: URI) {
		super(`File does not exist: ${resource.toString()}`, FileSystemProviderErrorCode.FileNotFound);
		this.name = "FileNotFoundError";
	}
}

export class FileOperationNotSupportedError extends FileSystemProviderError {
	constructor(readonly resource: URI, readonly operation: string) {
		super(`File operation '${operation}' is not supported for ${resource.toString()}`, FileSystemProviderErrorCode.Unavailable);
		this.name = "FileOperationNotSupportedError";
	}
}

export const IFileService =
	createServiceIdentifier<IFileService>("fileService");
