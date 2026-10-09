import { localize } from '../../../nls.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { createFileSystemProviderError, FileSystemProviderErrorCode } from '../../files/common/files.js';
import type { FsFileType, FsFileWriteMode, FsReadBinaryFileResult, FsReadDirectoryResult, ResourceMetadataResult, ResourceReadResult } from "../../../../../.build/protocol/typescript/index.js";
import type { FsChanged } from "../../../../../.build/protocol/typescript/index.js";
import type { IResourceApi } from "../common/appServerApi.js";
import { AppServerRemoteError } from "../common/appServerError.js";
import { decodeBase64 } from "../../../base/common/buffer.js";
import { Emitter, Event } from "../../../base/common/event.js";
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from "../../../base/common/lifecycle.js";
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { canceled } from '../../../base/common/errors.js';
import { raceCancellationError } from '../../../base/common/async.js';
import { newWriteableStream, type ReadableStreamEvents } from '../../../base/common/stream.js';
import { URI } from "../../../base/common/uri.js";
import {
	FileKind,
	FileNotFoundError,
	FileRevisionConflictError,
	FileOperationNotSupportedError,
	FileSystemProviderCapabilities,
	type FileDeleteMode,
	type FileExistingTargetBehavior,
	type FileMissingTargetBehavior,
	type IFileBytes,
	type IFileChangeEvent,
	type IFileEntry,
	type IFileSystemProviderWithFileReadStreamCapability,
	type IFileReadStreamOptions,
	type IFileStat,
	type IFileWriteOptions,
	type IFileWriteResult,
	type IWatchOptions,
} from "../../files/common/files.js";
import { workspaceRelativePath, workspaceResourceFromPath, type IWorkspaceContextService } from "../../workspace/common/workspace.js";
import type { IFileApi } from '../../files/common/fileApi.js';
import type { ISystemFileTransferService } from '../../files/common/systemFileTransferService.js';

export interface AppServerFileSystemProviderOptions {
	readonly api: IFileApi;
	readonly resourceApi: IResourceApi;
	readonly workspaceContextService: IWorkspaceContextService;
	readonly onDidChange?: Event<FsChanged>;
}

/**
 * Maps workspace resource URIs to the App Server's root-relative filesystem protocol.
 */
export class AppServerFileSystemProvider extends Disposable implements IFileSystemProviderWithFileReadStreamCapability, ISystemFileTransferService {
	// The transport does not advertise host filesystem casing; preserve distinct paths rather than infer it from the renderer OS.
	public readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy | FileSystemProviderCapabilities.FileReadStream | FileSystemProviderCapabilities.FileWriteElevated | FileSystemProviderCapabilities.FileWriteUnlock | FileSystemProviderCapabilities.PathCaseSensitive;
	public readonly onDidChangeCapabilities = Event.None;
	private readonly api: IFileApi;
	private readonly resourceApi: IResourceApi;
	private readonly workspaceContextService: IWorkspaceContextService;
	private readonly fileChanges = this._register(new Emitter<IFileChangeEvent>());
	private readonly reads = this._register(new DisposableMap<object, DisposableStore>());

	readonly onDidChangeFiles = this.fileChanges.event;

	constructor(options: AppServerFileSystemProviderOptions) {
		super();
		this.api = options.api;
		this.resourceApi = options.resourceApi;
		this.workspaceContextService = options.workspaceContextService;
		if (options.onDidChange) this._register(options.onDidChange(change => this.acceptFileChange(change)));
	}

	public watch(resource: URI, _options: IWatchOptions): IDisposable {
		this.assertNotDisposed();
		this.fileTarget(resource);
		// Rust owns continuous watches for every authorized workspace root, including Agent consumers.
		return Disposable.None;
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
		let result: FsReadDirectoryResult;
		try { result = await this.api.readDirectory(this.fileTarget(resource)); }
		catch (error) { if (isFileNotFound(error)) throw new FileNotFoundError(resource); throw error; }
		return result.entries.map((entry) => ({
			resource: resource.joinPathSegment(entry.name),
			name: entry.name,
			kind: fileKind(entry.fileType),
		}));
	}

	async readFile(resource: URI): Promise<IFileBytes> {
		let result: FsReadBinaryFileResult;
		try { result = await this.api.readBinaryFile(this.fileTarget(resource)); }
		catch (error) { if (isFileNotFound(error)) throw new FileNotFoundError(resource); throw error; }
		try {
			const bytes = await this.readResourceBytes(result.resource);
			return Object.freeze({ resource, bytes, revision: result.revision });
		} finally {
			await this.resourceApi.release({ resourceId: result.resource.resourceId });
		}
	}

	public readFileStream(resource: URI, options: IFileReadStreamOptions, token: CancellationToken): ReadableStreamEvents<Uint8Array> {
		this.assertNotDisposed();
		const target = this.fileTarget(resource);
		const stream = newWriteableStream<Uint8Array>(null, { highWaterMark: 1 });
		const lifetime = new DisposableStore();
		this.reads.set(lifetime, lifetime);
		const cancellation = new CancellationTokenSource(token);
		lifetime.add(toDisposable(() => cancellation.dispose(true)));
		const destroy = stream.destroy;
		stream.destroy = (): void => { this.reads.deleteAndDispose(lifetime); destroy(); };
		void (async () => {
			let snapshot: FsReadBinaryFileResult | undefined;
			try {
				if (cancellation.token.isCancellationRequested) { throw canceled(); }
				// The allocation request has no backend cancel method; retain its late response so it can be released.
				snapshot = await this.api.readBinaryFile(target);
				for await (const chunk of this.resourceChunks(snapshot.resource, options, cancellation.token)) {
					await raceCancellationError(Promise.resolve(stream.write(chunk)), cancellation.token);
				}
			} catch (error) {
				stream.error(isFileNotFound(error) ? new FileNotFoundError(resource) : error instanceof Error ? error : new Error(String(error)));
			} finally {
				if (snapshot) {
					try { await this.resourceApi.release({ resourceId: snapshot.resource.resourceId }); }
					catch (error) { stream.error(error instanceof Error ? error : new Error(String(error))); }
				}
				this.reads.deleteAndDispose(lifetime);
				stream.end();
			}
		})();
		return stream;
	}

	async writeFile(resource: URI, content: Uint8Array, options: IFileWriteOptions, signal?: AbortSignal): Promise<IFileWriteResult> {
		let mode: FsFileWriteMode;
		if (options.create) mode = options.overwrite ? 'createOrReplace' : 'create';
		else if (options.overwrite) mode = 'replace';
		else throw new FileOperationNotSupportedError(resource, 'writeFile');
		// The privileged contract binds replacement to a revision and creation to absence.
		// Other provider modes need their own backend conditions before they can be exposed.
		if (options.writeElevated && mode !== 'createOrReplace') {
			throw new FileOperationNotSupportedError(resource, 'writeFileElevated');
		}
		try {
			const result = options.writeElevated
				? await this.api.writeFileElevated({ ...this.fileTarget(resource), operationId: generateUuid(), dataBase64: encodeBinaryFile(content), ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }) }, signal)
				: await this.api.writeBinaryFile({
					...this.fileTarget(resource),
					dataBase64: encodeBinaryFile(content),
					options: { mode, ...(options.unlock ? { unlock: true } : {}), ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }) },
				});
			return Object.freeze({
				stat: {
					resource,
					kind: fileKind(result.metadata.fileType),
					sizeBytes: result.metadata.sizeBytes,
					readonly: result.metadata.readonly,
					modifiedAtMillis: result.metadata.modifiedAtMillis ?? undefined,
				},
				revision: result.revision,
			});
		} catch (error) {
			if (isRevisionConflict(error)) throw new FileRevisionConflictError(resource);
			if (error instanceof AppServerRemoteError && error.errorName === 'FileSystemWriteLocked') {
				throw createFileSystemProviderError(localize('files.osWriteLocked', 'The file is read-only. Overwrite to make it writable and save.'), FileSystemProviderErrorCode.FileWriteLocked);
			}
			if (error instanceof AppServerRemoteError && error.errorName === 'FileSystemPermissionDenied') {
				throw createFileSystemProviderError(localize('files.osPermissionDenied', 'The operating system denied file write access.'), FileSystemProviderErrorCode.NoPermissions);
			}
			if (isFileNotFound(error)) throw new FileNotFoundError(resource);
			if (error instanceof AppServerRemoteError) {
				if (error.errorName === 'FileSystemElevationDenied') { throw createFileSystemProviderError(localize('files.elevationDenied', 'System authorization was declined. Your changes remain unsaved.'), FileSystemProviderErrorCode.NoPermissions); }
				if (error.errorName === 'FileSystemElevationTimedOut') { throw createFileSystemProviderError(localize('files.elevationTimedOut', 'System authorization timed out. Your changes remain unsaved.'), FileSystemProviderErrorCode.Unavailable); }
				if (error.errorName === 'FileSystemElevationFailed') { throw createFileSystemProviderError(localize('files.elevationFailed', 'System authorization or the save helper failed. Check the App Server log. Your changes remain unsaved.'), FileSystemProviderErrorCode.Unavailable); }
				if (error.errorName === 'FileSystemElevationUnavailable') { throw createFileSystemProviderError(localize('files.elevationUnavailable', 'System authorization is unavailable on this host.'), FileSystemProviderErrorCode.Unavailable); }
				if (error.errorName === 'FileSystemWriteOutcomeUnknown') { throw createFileSystemProviderError(localize('files.elevationOutcomeUnknown', 'The save result could not be confirmed. Reload the file before retrying.'), FileSystemProviderErrorCode.Unavailable); }
			}
			throw error;
		}
	}

	async createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat> {
		const result = await this.api.createFile({ ...this.fileTarget(resource), existing });
		return { resource, kind: fileKind(result.fileType), sizeBytes: result.sizeBytes, readonly: result.readonly, modifiedAtMillis: result.modifiedAtMillis ?? undefined };
	}

	async createDirectory(resource: URI): Promise<IFileStat> {
		const result = await this.api.createDirectory(this.fileTarget(resource));
		return { resource, kind: fileKind(result.fileType), sizeBytes: result.sizeBytes, readonly: result.readonly, modifiedAtMillis: result.modifiedAtMillis ?? undefined };
	}

	copy(source: URI, target: URI): Promise<void> {
		const from = this.fileTarget(source);
		const to = this.fileTarget(target);
		return this.api.copy({ sourceDirId: from.dirId, source: from.path, targetDirId: to.dirId, target: to.path });
	}

	pasteSystemFiles(directory: URI, moveRequested: boolean): Promise<boolean> {
		return this.api.pasteSystemFiles({ ...this.fileTarget(directory), moveRequested });
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

	private fileTarget(resource: URI): { readonly dirId: string; readonly path: string; } {
		const folder = this.workspaceContextService.getWorkspaceFolder(resource);
		if (!folder) throw new Error("Resource must belong to a current workspace folder");
		return { dirId: folder.id, path: workspaceRelativePath(folder.uri, resource) };
	}

	private async readResourceBytes(resource: ResourceMetadataResult): Promise<Uint8Array> {
		if (!Number.isSafeInteger(resource.size) || resource.size < 0 || resource.size > MAX_FILE_READ_BYTES) {
			throw new Error("Workspace binary resource size is invalid");
		}
		const bytes = new Uint8Array(resource.size);
		let offset = 0;
		for await (const chunk of this.resourceChunks(resource, {}, CancellationToken.None)) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	}

	private async *resourceChunks(resource: ResourceMetadataResult, options: IFileReadStreamOptions, token: CancellationToken): AsyncIterable<Uint8Array> {
		if (!Number.isSafeInteger(resource.size) || resource.size < 0 || resource.size > MAX_FILE_READ_BYTES) {
			throw new Error('Workspace binary resource size is invalid');
		}
		if (options.limits?.size !== undefined && resource.size > options.limits.size) { throw new Error('File exceeds the read size limit'); }
		let offset = options.position ?? 0;
		const end = Math.min(resource.size, options.length === undefined ? resource.size : offset + options.length);
		while (offset < end) {
			if (token.isCancellationRequested) { throw canceled(); }
			const maxBytes = Math.min(MAX_RESOURCE_READ_BYTES, end - offset);
			const chunk = await this.resourceApi.read({
				resourceId: resource.resourceId,
				offset,
				maxBytes,
			});
			if (token.isCancellationRequested) { throw canceled(); }
			const chunkBytes = decodeResourceChunk(chunk, resource.resourceId, offset, resource.size);
			if (chunkBytes.byteLength > maxBytes) { throw new Error('Workspace binary resource response exceeds the requested range'); }
			offset += chunkBytes.byteLength;
			yield chunkBytes;
		}
		if (token.isCancellationRequested) { throw canceled(); }
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
// Both backend file-read endpoints accept this limit; preview panes apply their own smaller bounds.
const MAX_FILE_READ_BYTES = 50 * 1024 * 1024;

function encodeBinaryFile(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 8192) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
	}
	return btoa(binary);
}

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
