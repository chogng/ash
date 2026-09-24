import type { Event } from "../../../base/common/event.js";
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

/** Binary content read from a workspace resource together with its opaque exact-content revision. */
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

/** Workspace-scoped file operations available to Workbench features. */
export interface IFileService {
	readonly onDidChangeFiles: Event<IFileChangeEvent>;
	stat(resource: URI): Promise<IFileStat>;
	readDirectory(resource: URI): Promise<readonly IFileEntry[]>;
	readFile(resource: URI): Promise<IFileContent>;
	readFileBytes(resource: URI): Promise<IFileBytes>;
	writeFile(request: IFileWriteRequest): Promise<IFileWriteResult>;
	createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat>;
	rename(source: URI, target: URI, existing: FileExistingTargetBehavior): Promise<void>;
	delete(resource: URI, missing: FileMissingTargetBehavior, mode: FileDeleteMode): Promise<void>;
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
