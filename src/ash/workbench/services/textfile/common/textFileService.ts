import { type URI } from "../../../../base/common/uri.js";

export enum TextFileContentSource {
	Bootstrap = "bootstrap",
	FileSystem = "fileSystem",
}

export interface TextFileResolveRequest {
	readonly resource: URI;
	readonly bootstrapText?: string;
}

export interface ResolvedTextFileContent {
	readonly resource: URI;
	readonly text: string;
	readonly source: TextFileContentSource;
	/** Opaque file revision when the content came from the workspace file service. */
	readonly revision: string | undefined;
	readonly encoding: "utf8" | "utf8bom";
}

export interface TextFileSaveRequest {
	/** Only set after an explicit user choice to request system authorization. */
	readonly writeElevated?: boolean;
	/** Explicit retry that makes an existing file writable without system elevation. */
	readonly unlock?: boolean;
	readonly resource: URI;
	readonly text: string;
	readonly encoding?: "utf8" | "utf8bom";
	readonly expectedRevision?: string;
}

/** Result of one successful text-file save. */
export interface TextFileSaveResult {
	readonly revision: string | undefined;
}

export interface ITextFileSaveEvent {
	readonly resource: URI;
	/** Exact content accepted by the file provider, including the requested encoding. */
	readonly content: string;
	readonly revision: string;
}

/** A conditional file save was rejected because the resource changed after it was resolved. */
export class TextFileSaveConflictError extends Error {
	constructor(readonly resource: URI) {
		super(`Text file changed since it was resolved: ${resource.toString()}`);
		this.name = "TextFileSaveConflictError";
	}
}

export class TextFileBinaryError extends Error {
	constructor(readonly resource: URI, message = "The file is binary or uses an unsupported text encoding", options?: ErrorOptions) {
		super(`${message}: ${resource.toString()}`, options);
		this.name = "TextFileBinaryError";
	}
}

export class TextFileTooLargeError extends Error {
	constructor(readonly resource: URI, readonly sizeBytes: number) {
		super(`The text file is too large to open safely (${sizeBytes} bytes): ${resource.toString()}`);
		this.name = "TextFileTooLargeError";
	}
}
