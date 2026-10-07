import type { Event } from "../../../base/common/event.js";
import type { IDisposable } from "../../../base/common/lifecycle.js";
import type { URI } from "../../../base/common/uri.js";
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
	readonly onDidChangeFiles: Event<IFileChangeEvent>;
	stat(resource: URI): Promise<IFileStat>;
	readDirectory(resource: URI): Promise<readonly IFileEntry[]>;
	/** Reads exact stored bytes; the revision continues to identify those bytes across text decoding. */
	readFile(resource: URI): Promise<IFileBytes>;
	writeFile(request: IFileWriteRequest): Promise<IFileWriteResult>;
	/** Creates a file from exact bytes without replacing an existing nonempty file. */
	writeFileBytes(resource: URI, bytes: Uint8Array): Promise<IFileWriteResult>;
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
	stat(resource: URI): Promise<IFileStat>;
	readDirectory(resource: URI): Promise<readonly IFileEntry[]>;
	readFile(resource: URI): Promise<IFileContent>;
	readFileBytes(resource: URI): Promise<IFileBytes>;
	writeFile(request: IFileWriteRequest): Promise<IFileWriteResult>;
	writeFileBytes(resource: URI, bytes: Uint8Array): Promise<IFileWriteResult>;
	createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat>;
	createDirectory(resource: URI): Promise<IFileStat>;
	copy(source: URI, target: URI): Promise<void>;
	rename(source: URI, target: URI, existing: FileExistingTargetBehavior): Promise<void>;
	delete(resource: URI, missing: FileMissingTargetBehavior, mode: FileDeleteMode): Promise<void>;
	/** One registration per scheme; disposal unregisters it without disposing the caller-owned provider. */
	registerProvider(scheme: string, provider: IFileSystemProvider): IDisposable;
	/** Reports routing availability, which does not imply that the provider's storage is currently accessible. */
	hasProvider(resource: URI): boolean;
}

export class FileNotFoundError extends Error {
	constructor(readonly resource: URI) {
		super(`File does not exist: ${resource.toString()}`);
		this.name = "FileNotFoundError";
	}
}

export class FileOperationNotSupportedError extends Error {
	constructor(readonly resource: URI, readonly operation: string) {
		super(`File operation '${operation}' is not supported for ${resource.toString()}`);
		this.name = "FileOperationNotSupportedError";
	}
}

export const IFileService =
	createServiceIdentifier<IFileService>("fileService");
