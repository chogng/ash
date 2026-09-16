import type { FsFileType, FsGetMetadataParams, FsGetMetadataResult, FsReadBinaryFileParams, FsReadBinaryFileResult, FsReadDirectoryParams, FsReadDirectoryResult, FsReadFileParams, FsReadFileResult, FsWriteFileParams, FsWriteFileResult, ResourceMetadataResult, ResourceReadResult } from "../../app-server/common/generated/index.js";
import type { FsChanged } from "../../app-server/common/generated/index.js";
import type { IResourceApi } from "../../app-server/common/appServerApi.js";
import { AppServerRemoteError } from "../../app-server/common/appServerError.js";
import { decodeBase64 } from "../../../base/common/buffer.js";
import { Emitter, type Event } from "../../../base/common/event.js";
import { Disposable } from "../../../base/common/lifecycle.js";
import { URI } from "../../../base/common/uri.js";
import { FileKind, FileNotFoundError, FileRevisionConflictError, type FileDeleteMode, type FileExistingTargetBehavior, type FileMissingTargetBehavior, type IFileBytes, type IFileChangeEvent, type IFileContent, type IFileEntry, type IFileService, type IFileStat, type IFileWriteRequest, type IFileWriteResult } from "../common/files.js";
import type { IWorkspaceContextService } from "../../workspace/common/workspace.js";
import { isRemoteResource } from "../../remote/common/remote.js";

/** Narrow App Server surface consumed by the browser file-service adapter. */
export interface IFileSystemApi {
	getMetadata(params: FsGetMetadataParams): Promise<FsGetMetadataResult>;
	readDirectory(params: FsReadDirectoryParams): Promise<FsReadDirectoryResult>;
	readFile(params: FsReadFileParams): Promise<FsReadFileResult>;
	readBinaryFile(params: FsReadBinaryFileParams): Promise<FsReadBinaryFileResult>;
	writeFile(params: FsWriteFileParams): Promise<FsWriteFileResult>;
	createFile(params: import("../../app-server/common/generated/index.js").FsCreateFileParams): Promise<FsGetMetadataResult>;
	rename(params: import("../../app-server/common/generated/index.js").FsRenameParams): Promise<void>;
	delete(params: import("../../app-server/common/generated/index.js").FsDeleteParams): Promise<void>;
}

export interface BrowserFileServiceOptions {
	readonly api: IFileSystemApi;
	readonly resourceApi: IResourceApi;
	readonly workspaceContextService: IWorkspaceContextService;
	readonly onDidChange?: Event<FsChanged>;
}

/**
 * Maps workspace resource URIs to the App Server's root-relative filesystem protocol.
 */
export class BrowserFileService extends Disposable implements IFileService {
	private readonly api: IFileSystemApi;
	private readonly resourceApi: IResourceApi;
	private readonly workspaceContextService: IWorkspaceContextService;
	private readonly fileChanges = this._register(new Emitter<IFileChangeEvent>());

	readonly onDidChangeFiles = this.fileChanges.event;

	constructor(options: BrowserFileServiceOptions) {
		super();
		this.api = options.api;
		this.resourceApi = options.resourceApi;
		this.workspaceContextService = options.workspaceContextService;
		if (options.onDidChange) this._register(options.onDidChange(change => this.acceptFileChange(change)));
	}

	async stat(resource: URI): Promise<IFileStat> {
		let result;
		try { result = await this.api.getMetadata(this.fileTarget(resource)); }
		catch (error) { if (isFileNotFound(error)) throw new FileNotFoundError(resource); throw error; }
		return {
			resource,
			kind: fileKind(result.fileType),
			sizeBytes: result.sizeBytes,
			readonly: result.readonly,
			modifiedAtMillis: result.modifiedAtMillis ?? undefined,
		};
	}

	async readDirectory(resource: URI): Promise<readonly IFileEntry[]> {
		const result = await this.api.readDirectory(this.fileTarget(resource));
		return result.entries.map((entry) => ({
			resource: childResource(resource, entry.name),
			name: entry.name,
			kind: fileKind(entry.fileType),
		}));
	}

	async readFile(resource: URI): Promise<IFileContent> {
		const result = await this.api.readFile(this.fileTarget(resource));
		return Object.freeze({ resource, content: result.content, revision: result.revision });
	}

	async readFileBytes(resource: URI): Promise<IFileBytes> {
		const result = await this.api.readBinaryFile(this.fileTarget(resource));
		try {
			const bytes = await this.readResourceBytes(result.resource);
			return Object.freeze({ resource, bytes, revision: result.revision });
		} finally {
			await this.resourceApi.release({ resourceId: result.resource.resourceId });
		}
	}

	async writeFile(request: IFileWriteRequest): Promise<IFileWriteResult> {
		try {
			const result = await this.api.writeFile({
				...this.fileTarget(request.resource),
				content: request.content,
				...(request.expectedRevision === undefined ? {} : { expectedRevision: request.expectedRevision }),
			});
			return Object.freeze({
				stat: {
					resource: request.resource,
					kind: fileKind(result.metadata.fileType),
					sizeBytes: result.metadata.sizeBytes,
					readonly: result.metadata.readonly,
					modifiedAtMillis: result.metadata.modifiedAtMillis ?? undefined,
				},
				revision: result.revision,
			});
		} catch (error) {
			if (isRevisionConflict(error)) throw new FileRevisionConflictError(request.resource);
			throw error;
		}
	}

	async createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat> {
		const result = await this.api.createFile({ ...this.fileTarget(resource), existing });
		return { resource, kind: fileKind(result.fileType), sizeBytes: result.sizeBytes, readonly: result.readonly, modifiedAtMillis: result.modifiedAtMillis ?? undefined };
	}

	rename(source: URI, target: URI, existing: FileExistingTargetBehavior): Promise<void> {
		const sourceTarget = this.fileTarget(source);
		const targetTarget = this.fileTarget(target);
		if (sourceTarget.dirId !== targetTarget.dirId) {
			throw new Error("Renaming across workspace folders is not supported");
		}
		return this.api.rename({
			dirId: sourceTarget.dirId,
			source: sourceTarget.path,
			target: targetTarget.path,
			existing,
		});
	}

	delete(resource: URI, missing: FileMissingTargetBehavior, mode: FileDeleteMode): Promise<void> {
		return this.api.delete({ ...this.fileTarget(resource), missing, mode });
	}

	private fileTarget(resource: URI): { readonly dirId: string; readonly path: string } {
		const folders = this.workspaceContextService.getWorkspace().folders;
		let match: { readonly dirId: string; readonly path: string; readonly rootLength: number } | undefined;
		for (const folder of folders) {
			try {
				const path = workspaceRelativePath(folder.uri, resource);
				if (!match || folder.uri.path.length > match.rootLength) {
					match = { dirId: folder.id, path, rootLength: folder.uri.path.length };
				}
			} catch {
				// A resource may only belong to one of the workspace's independent roots.
			}
		}
		if (!match) throw new Error("Resource must belong to a current workspace folder");
		return { dirId: match.dirId, path: match.path };
	}

	private async readResourceBytes(resource: ResourceMetadataResult): Promise<Uint8Array> {
		if (!Number.isSafeInteger(resource.size) || resource.size < 0 || resource.size > MAX_BINARY_FILE_BYTES) {
			throw new Error("Workspace binary resource size is invalid");
		}
		const bytes = new Uint8Array(resource.size);
		let offset = 0;
		while (offset < bytes.length) {
			const chunk = await this.resourceApi.read({
				resourceId: resource.resourceId,
				offset,
				maxBytes: Math.min(MAX_RESOURCE_READ_BYTES, bytes.length - offset),
			});
			const chunkBytes = decodeResourceChunk(chunk, resource.resourceId, offset, bytes.length);
			bytes.set(chunkBytes, offset);
			offset += chunkBytes.length;
		}
		return bytes;
	}

	private acceptFileChange(change: FsChanged): void {
		if (change.type === "rescanRequired") {
			this.fileChanges.fire(Object.freeze({ resources: undefined }));
			return;
		}
		const folders = this.workspaceContextService.getWorkspace().folders;
		const folder = change.dirId
			? folders.find(folder => folder.id === change.dirId)
			: folders.length === 1 ? folders[0] : undefined;
		if (!folder) {
			this.fileChanges.fire(Object.freeze({ resources: undefined }));
			return;
		}
		const resources = change.paths.map(path => workspaceResourceFromPath(folder.uri, path));
		if (resources.some(resource => resource === undefined)) {
			this.fileChanges.fire(Object.freeze({ resources: undefined }));
			return;
		}
		const unique = new Map<string, URI>();
		for (const resource of resources) unique.set(resource!.toString(), resource!);
		this.fileChanges.fire(Object.freeze({ resources: Object.freeze([...unique.values()]) }));
	}
}

function isRevisionConflict(error: unknown): boolean {
	return error instanceof AppServerRemoteError && error.errorName === "FileSystemRevisionConflict";
}

function isFileNotFound(error: unknown): boolean {
	return error instanceof AppServerRemoteError && error.errorName === "FileSystemNotFound";
}

const MAX_RESOURCE_READ_BYTES = 262_144;
const MAX_BINARY_FILE_BYTES = 16 * 1024 * 1024;

function decodeResourceChunk(chunk: ResourceReadResult, resourceId: string, expectedOffset: number, totalSize: number): Uint8Array {
	if (chunk.resourceId !== resourceId || chunk.offset !== expectedOffset) {
		throw new Error("Workspace binary resource response is inconsistent");
	}
	const bytes = decodeBase64(chunk.dataBase64).buffer;
	if (chunk.decodedLength !== bytes.byteLength || bytes.byteLength === 0 || bytes.byteLength > totalSize - expectedOffset || chunk.eof !== (expectedOffset + bytes.byteLength === totalSize)) {
		throw new Error("Workspace binary resource response is inconsistent");
	}
	return bytes;
}

/** Resolves a resource to a slash-separated path beneath one workspace root. */
export function workspaceRelativePath(root: URI, resource: URI): string {
	if (
		!isWorkspaceFileSystemResource(root) ||
		resource.scheme !== root.scheme ||
		root.authority.toLowerCase() !== resource.authority.toLowerCase()
	) {
		throw new Error("Resource must belong to the current workspace filesystem");
	}
	const rootPath = decodedPath(root).replace(/\/+$/, "");
	const resourcePath = decodedPath(resource).replace(/\/+$/, "");
	const ignoreCase = root.scheme === "file" && isCaseInsensitiveFileSystemPath(rootPath);
	const comparedRoot = ignoreCase ? rootPath.toLowerCase() : rootPath;
	const comparedResource = ignoreCase
		? resourcePath.toLowerCase()
		: resourcePath;
	if (comparedResource === comparedRoot) return ".";
	const prefix = `${comparedRoot}/`;
	if (!comparedResource.startsWith(prefix)) {
		throw new Error("Resource is outside the current workspace folder");
	}
	return resourcePath.slice(rootPath.length + 1);
}

function decodedPath(resource: URI): string {
	const path = decodeURIComponent(resource.path);
	return resource.scheme === "file" ? path.replaceAll("\\", "/") : path;
}

function isCaseInsensitiveFileSystemPath(path: string): boolean {
	return /^\/[A-Za-z]:\//.test(`${path}/`) ||
		globalThis.navigator?.platform?.startsWith("Mac") === true;
}

function childResource(parent: URI, name: string): URI {
	const base = parent.path.endsWith("/")
		? parent.path.slice(0, -1)
		: parent.path;
	return parent.withPath(`${base}/${encodeURIComponent(name)}`);
}

/** Resolves one slash-separated protocol path beneath a workspace root. */
export function workspaceResourceFromPath(root: URI, path: string): URI | undefined {
	if (!isWorkspaceFileSystemResource(root)) return undefined;
	const normalizedPath = root.scheme === "file" ? path.replaceAll("\\", "/") : path;
	const segments = normalizedPath.split("/");
	if (segments.length === 0 || segments.some(segment => segment.length === 0 || segment === "." || segment === "..")) return undefined;
	const rootPath = root.path.endsWith("/") ? root.path.slice(0, -1) : root.path;
	return root.withPath(`${rootPath}/${segments.map(encodeURIComponent).join("/")}`);
}

function isWorkspaceFileSystemResource(resource: URI): boolean {
	return resource.scheme === "file" || isRemoteResource(resource);
}

function fileKind(fileType: FsFileType): FileKind {
	switch (fileType) {
		case "directory":
			return FileKind.Directory;
		case "file":
			return FileKind.File;
		case "symbolicLink":
			return FileKind.SymbolicLink;
		case "other":
			return FileKind.Other;
	}
}
