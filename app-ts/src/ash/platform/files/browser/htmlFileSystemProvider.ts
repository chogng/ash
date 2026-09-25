import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { FileKind, FileNotFoundError, FileOperationNotSupportedError, FileRevisionConflictError, type FileDeleteMode, type FileExistingTargetBehavior, type FileMissingTargetBehavior, type IFileBytes, type IFileChangeEvent, type IFileContent, type IFileEntry, type IFileService, type IFileStat, type IFileWriteRequest, type IFileWriteResult } from '../common/files.js';

interface SavedDirectory {
	readonly id: string;
	readonly name: string;
	readonly handle: FileSystemDirectoryHandle;
}

interface PermissionedDirectoryHandle extends FileSystemDirectoryHandle {
	queryPermission(descriptor?: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
	requestPermission(descriptor?: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

interface IterableDirectoryHandle extends FileSystemDirectoryHandle {
	entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

const DATABASE_NAME = 'ash-browser-folders';
const STORE_NAME = 'directories';
const ROOT_PREFIX = '/@browser/';

/** File access for folders explicitly selected through the browser picker. */
export class HTMLFileSystemProvider extends Disposable implements IFileService {
	private readonly changes = this._register(new Emitter<IFileChangeEvent>());
	private readonly database: Promise<IDBDatabase>;
	private readonly directories = new Map<string, SavedDirectory>();
	public readonly onDidChangeFiles = this.changes.event;

	constructor(factory: IDBFactory) {
		super();
		this.database = openDatabase(factory);
		this._register(toDisposable(() => { void this.database.then(database => database.close()); }));
	}

	public async registerDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<URI> {
		if (await (handle as PermissionedDirectoryHandle).requestPermission({ mode: 'readwrite' }) !== 'granted') {
			throw new Error(localize({ bundle: 'ash', key: 'workbench.browserFolderPermission' }, 'Browser folder permission is required'));
		}
		const saved: SavedDirectory = { id: crypto.randomUUID(), name: handle.name, handle };
		const database = await this.database;
		await transaction(database, 'readwrite', store => store.put(saved));
		this.directories.set(saved.id, saved);
		return rootUri(saved);
	}

	public async openDirectory(resource: URI): Promise<URI> {
		const { saved, parts } = await this.directory(resource, true);
		if (parts.length !== 0) throw new Error('Expected a registered browser folder');
		return rootUri(saved);
	}

	/** Resolves a previously authorized folder for the browser's starting location. */
	public async getDirectoryHandle(resource: URI): Promise<FileSystemDirectoryHandle> {
		const handle = await this.handle(resource);
		if (!isDirectoryHandle(handle)) throw new FileOperationNotSupportedError(resource, 'getDirectoryHandle');
		return handle;
	}

	public async stat(resource: URI): Promise<IFileStat> {
		const handle = await this.handle(resource);
		if (isDirectoryHandle(handle)) {
			return { resource, kind: FileKind.Directory, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined };
		}
		if (!isFileHandle(handle)) throw new FileNotFoundError(resource);
		const file = await handle.getFile();
		return { resource, kind: FileKind.File, sizeBytes: file.size, readonly: false, modifiedAtMillis: file.lastModified };
	}

	public async readDirectory(resource: URI): Promise<readonly IFileEntry[]> {
		const handle = await this.handle(resource);
		if (!isDirectoryHandle(handle)) throw new FileOperationNotSupportedError(resource, 'readDirectory');
		const entries: IFileEntry[] = [];
		for await (const [name, child] of (handle as IterableDirectoryHandle).entries()) {
			entries.push({
				resource: childUri(resource, name),
				name,
				kind: child.kind === 'directory' ? FileKind.Directory : FileKind.File,
			});
		}
		return entries;
	}

	public async readFile(resource: URI): Promise<IFileContent> {
		const file = await this.file(resource);
		const bytes = new Uint8Array(await file.arrayBuffer());
		return { resource, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), revision: await revision(bytes) };
	}

	public async readFileBytes(resource: URI): Promise<IFileBytes> {
		const file = await this.file(resource);
		const bytes = new Uint8Array(await file.arrayBuffer());
		return { resource, bytes, revision: await revision(bytes) };
	}

	public async writeFile(request: IFileWriteRequest): Promise<IFileWriteResult> {
		const { parent, name } = await this.parent(request.resource);
		let handle: FileSystemFileHandle;
		try {
			handle = await parent.getFileHandle(name);
		} catch (error) {
			if (!isMissing(error) || request.expectedRevision !== undefined) throw fileError(error, request.resource);
			handle = await parent.getFileHandle(name, { create: true });
		}
		if (request.expectedRevision !== undefined) {
			const current = new Uint8Array(await (await handle.getFile()).arrayBuffer());
			if (await revision(current) !== request.expectedRevision) throw new FileRevisionConflictError(request.resource);
		}
		const writable = await handle.createWritable();
		try {
			await writable.write(request.content);
			await writable.close();
		} catch (error) {
			await writable.abort();
			throw error;
		}
		this.changes.fire({ resources: [request.resource] });
		return { stat: await this.stat(request.resource), revision: await revision(new TextEncoder().encode(request.content)) };
	}

	public async createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat> {
		const { parent, name } = await this.parent(resource);
		let found = true;
		try { await parent.getFileHandle(name); }
		catch (error) { if (!isMissing(error)) throw fileError(error, resource); found = false; }
		if (found && existing === 'error') throw new Error(localize({ bundle: 'ash', key: 'workbench.browserFolderFileExists' }, 'File already exists'));
		if (!found || existing === 'overwrite') {
			const handle = await parent.getFileHandle(name, { create: true });
			if (found) {
				const writable = await handle.createWritable();
				await writable.close();
			}
			this.changes.fire({ resources: [resource] });
		}
		return this.stat(resource);
	}

	public async rename(source: URI, target: URI, existing: FileExistingTargetBehavior): Promise<void> {
		const sourceParts = partsOf(source);
		const targetParts = partsOf(target);
		if (sourceParts.id !== targetParts.id || sourceParts.parts.length === 0 || targetParts.parts.length === 0) {
			throw new FileOperationNotSupportedError(source, 'rename');
		}
		if (source.toString() === target.toString()) return;
		const handle = await this.handle(source);
		if (!isFileHandle(handle)) throw new FileOperationNotSupportedError(source, 'renameDirectory');
		try {
			await this.stat(target);
			if (existing === 'ignore') return;
			if (existing === 'error') throw new Error(localize({ bundle: 'ash', key: 'workbench.browserFolderTargetExists' }, 'Target file already exists'));
		} catch (error) { if (!(error instanceof FileNotFoundError)) throw error; }
		const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
		const { parent, name } = await this.parent(target);
		const targetHandle = await parent.getFileHandle(name, { create: true });
		const writable = await targetHandle.createWritable();
		try {
			await writable.write(bytes);
			await writable.close();
		} catch (error) {
			await writable.abort();
			throw error;
		}
		const sourceParent = await this.parent(source);
		await sourceParent.parent.removeEntry(sourceParent.name);
		this.changes.fire({ resources: [source, target] });
	}

	public async delete(resource: URI, missing: FileMissingTargetBehavior, mode: FileDeleteMode): Promise<void> {
		const { parent, name } = await this.parent(resource);
		try { await parent.removeEntry(name, { recursive: mode === 'recursive' }); }
		catch (error) { if (missing !== 'ignore' || !isMissing(error)) throw fileError(error, resource); }
		this.changes.fire({ resources: [resource] });
	}

	private async file(resource: URI): Promise<File> {
		const handle = await this.handle(resource);
		if (!isFileHandle(handle)) throw new FileOperationNotSupportedError(resource, 'readFile');
		return handle.getFile();
	}

	private async handle(resource: URI): Promise<FileSystemHandle> {
		const { saved, parts } = await this.directory(resource, false);
		let current: FileSystemHandle = saved.handle;
		for (const part of parts) {
			if (!isDirectoryHandle(current)) throw new FileNotFoundError(resource);
			const directory = current;
			try { current = await directory.getDirectoryHandle(part); }
			catch (error) {
				if (!isMissing(error) && !(error instanceof DOMException && error.name === 'TypeMismatchError')) throw fileError(error, resource);
				try { current = await directory.getFileHandle(part); }
				catch (fileHandleError) { throw fileError(fileHandleError, resource); }
			}
		}
		return current;
	}

	private async parent(resource: URI): Promise<{ parent: FileSystemDirectoryHandle; name: string }> {
		const { saved, parts } = await this.directory(resource, false);
		if (parts.length === 0) throw new FileOperationNotSupportedError(resource, 'modifyRoot');
		let parent = saved.handle;
		for (const part of parts.slice(0, -1)) {
			try { parent = await parent.getDirectoryHandle(part); }
			catch (error) { throw fileError(error, resource); }
		}
		return { parent, name: parts[parts.length - 1]! };
	}

	private async directory(resource: URI, requestPermission: boolean): Promise<{ saved: SavedDirectory; parts: readonly string[] }> {
		const { id, name, parts } = partsOf(resource);
		let saved = this.directories.get(id);
		if (!saved) {
			const database = await this.database;
			saved = await idbRequest<SavedDirectory | undefined>(database.transaction(STORE_NAME).objectStore(STORE_NAME).get(id));
			if (!saved) throw new FileNotFoundError(resource);
		}
		if (saved.name !== name) throw new FileNotFoundError(resource);
		const handle = saved.handle as PermissionedDirectoryHandle;
		const permission = await handle.queryPermission({ mode: 'readwrite' });
		if (permission !== 'granted' && (!requestPermission || await handle.requestPermission({ mode: 'readwrite' }) !== 'granted')) {
			throw new Error(localize({ bundle: 'ash', key: 'workbench.browserFolderPermission' }, 'Browser folder permission is required'));
		}
		this.directories.set(id, saved);
		return { saved, parts };
	}
}

function partsOf(resource: URI): { id: string; name: string; parts: readonly string[] } {
	if (resource.scheme !== 'file' || resource.authority || resource.query || resource.fragment || !resource.path.startsWith(ROOT_PREFIX)) {
		throw new FileNotFoundError(resource);
	}
	const segments = resource.path.slice(ROOT_PREFIX.length).split('/').map(decodeURIComponent);
	const [id, name, ...parts] = segments;
	if (!id || !name || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\'))) {
		throw new FileNotFoundError(resource);
	}
	return { id, name, parts };
}

function rootUri(directory: SavedDirectory): URI {
	return URI.parse(`file://${ROOT_PREFIX}${encodeURIComponent(directory.id)}/${encodeURIComponent(directory.name)}`);
}

function childUri(parent: URI, name: string): URI {
	return parent.withPath(`${parent.path.replace(/\/$/, '')}/${encodeURIComponent(name)}`);
}

async function revision(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
	return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

function isMissing(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'NotFoundError';
}

function isDirectoryHandle(handle: FileSystemHandle): handle is FileSystemDirectoryHandle {
	return handle.kind === 'directory';
}

function isFileHandle(handle: FileSystemHandle): handle is FileSystemFileHandle {
	return handle.kind === 'file';
}

function fileError(error: unknown, resource: URI): unknown {
	return isMissing(error) ? new FileNotFoundError(resource) : error;
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const opening = factory.open(DATABASE_NAME, 1);
		opening.onupgradeneeded = () => opening.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
		opening.onsuccess = () => resolve(opening.result);
		opening.onerror = () => reject(opening.error ?? new Error('Browser folder database failed to open'));
	});
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('Browser folder database request failed'));
	});
}

async function transaction(database: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<void> {
	const current = database.transaction(STORE_NAME, mode);
	await idbRequest(run(current.objectStore(STORE_NAME)));
	await new Promise<void>((resolve, reject) => {
		current.oncomplete = () => resolve();
		current.onerror = () => reject(current.error ?? new Error('Browser folder transaction failed'));
		current.onabort = () => reject(current.error ?? new Error('Browser folder transaction aborted'));
	});
}
