import { addDisposableListener } from '../../../base/browser/dom.js';
import { IndexedDB } from '../../../base/browser/indexedDB.js';
import { raceCancellationError } from '../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { canceled } from '../../../base/common/errors.js';
import { newWriteableStream, type ReadableStreamEvents } from '../../../base/common/stream.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { parse, type ParsedPattern } from '../../../base/common/glob.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { extUri } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { WebFileSystemAccess, WebFileSystemObserver, type FileSystemObserver, type FileSystemObserverRecord } from './webFileSystemAccess.js';
import {
	createFileSystemProviderError,
	FileSystemProviderErrorCode,
	FileKind,
	FileNotFoundError,
	FileOperationNotSupportedError,
	FileRevisionConflictError,
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
} from '../common/files.js';

interface SavedDirectory {
	readonly id: string;
	readonly name: string;
	readonly handle: FileSystemDirectoryHandle;
}

interface PermissionedDirectoryHandle extends FileSystemDirectoryHandle {
	queryPermission(descriptor?: { mode: 'read' | 'readwrite'; }): Promise<PermissionState>;
	requestPermission(descriptor?: { mode: 'read' | 'readwrite'; }): Promise<PermissionState>;
}

interface BrowserFileWatch extends DisposableStore {
	readonly resource: URI;
	readonly options: IWatchOptions;
	readonly excludes: readonly ParsedPattern[];
	readonly observer: MutableDisposable<IDisposable>;
	isStarting: boolean;
}

const DATABASE_NAME = 'ash-browser-folders';
const STORE_NAME = 'directories';
const ROOT_PREFIX = '/@browser/';

/** File access for folders explicitly selected through the browser picker. */
export class HTMLFileSystemProvider extends Disposable implements IFileSystemProviderWithFileReadStreamCapability {
	public readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy | FileSystemProviderCapabilities.FileReadStream | FileSystemProviderCapabilities.PathCaseSensitive;
	public readonly onDidChangeCapabilities = Event.None;
	private readonly changes = this._register(new Emitter<IFileChangeEvent>());
	private readonly database: Promise<IndexedDB>;
	private readonly directories = new Map<string, SavedDirectory>();
	private readonly watches = this._register(new DisposableMap<object, BrowserFileWatch>());
	private readonly reads = this._register(new DisposableMap<object, DisposableStore>());
	private readonly foregroundListeners = this._register(new MutableDisposable<DisposableStore>());
	private isRefreshScheduled = false;
	private shouldRetryObservers = false;
	public readonly onDidChangeFiles = this.changes.event;

	constructor(factory: IDBFactory, private readonly ownerWindow: Window) {
		super();
		this.database = IndexedDB.create(DATABASE_NAME, 1, [STORE_NAME], factory);
		// Handle operations report opening errors even when a folder is selected long after construction.
		void this.database.catch(() => undefined);
		this._register(toDisposable(() => { void this.database.then(database => database.close(), () => undefined); }));
	}

	public async registerDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<URI> {
		this.assertNotDisposed();
		if (!WebFileSystemAccess.isFileSystemHandle(handle) || !WebFileSystemAccess.isFileSystemDirectoryHandle(handle)) {
			throw new TypeError('Expected a browser directory handle');
		}
		if (await (handle as PermissionedDirectoryHandle).requestPermission({ mode: 'readwrite' }) !== 'granted') {
			throw createFileSystemProviderError(localize({ bundle: 'ash', key: 'workbench.browserFolderPermission' }, 'Browser folder permission is required'), FileSystemProviderErrorCode.NoPermissions);
		}
		const database = await this.database;
		const registered = await database.runInTransaction<SavedDirectory[]>(STORE_NAME, 'readonly', store => store.getAll());
		// A folder keeps its resource and workspace identity across picker calls and page reloads.
		for (const saved of registered) {
			if (await saved.handle.isSameEntry(handle)) {
				this.directories.set(saved.id, saved);
				return rootUri(saved);
			}
		}
		const saved: SavedDirectory = { id: crypto.randomUUID(), name: handle.name, handle };
		// Older databases used an inline id key; preserve those registrations without a data migration.
		await database.runInTransaction(STORE_NAME, 'readwrite', store => store.keyPath === null ? store.put(saved, saved.id) : store.put(saved));
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
		if (!WebFileSystemAccess.isFileSystemDirectoryHandle(handle)) throw new FileOperationNotSupportedError(resource, 'getDirectoryHandle');
		return handle;
	}

	public async stat(resource: URI): Promise<IFileStat> {
		const handle = await this.handle(resource);
		if (WebFileSystemAccess.isFileSystemDirectoryHandle(handle)) {
			return { resource, kind: FileKind.Directory, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined };
		}
		if (!WebFileSystemAccess.isFileSystemFileHandle(handle)) throw new FileNotFoundError(resource);
		const file = await handle.getFile();
		return { resource, kind: FileKind.File, sizeBytes: file.size, readonly: false, modifiedAtMillis: file.lastModified };
	}

	public async readDirectory(resource: URI): Promise<readonly IFileEntry[]> {
		const handle = await this.handle(resource);
		if (!WebFileSystemAccess.isFileSystemDirectoryHandle(handle)) throw createFileSystemProviderError('Expected a directory', FileSystemProviderErrorCode.FileNotADirectory);
		const entries: IFileEntry[] = [];
		for await (const [name, child] of handle.entries()) {
			entries.push({
				resource: childUri(resource, name),
				name,
				kind: child.kind === 'directory' ? FileKind.Directory : FileKind.File,
			});
		}
		return entries;
	}

	public async readFile(resource: URI): Promise<IFileBytes> {
		const file = await this.file(resource);
		const bytes = new Uint8Array(await file.arrayBuffer());
		return { resource, bytes, revision: await revision(bytes) };
	}

	public readFileStream(resource: URI, options: IFileReadStreamOptions, token: CancellationToken): ReadableStreamEvents<Uint8Array> {
		this.assertNotDisposed();
		const stream = newWriteableStream<Uint8Array>(null, { highWaterMark: 1 });
		const lifetime = new DisposableStore();
		this.reads.set(lifetime, lifetime);
		const cancellation = new CancellationTokenSource(token);
		lifetime.add(toDisposable(() => cancellation.dispose(true)));
		const destroy = stream.destroy;
		stream.destroy = (): void => { this.reads.deleteAndDispose(lifetime); destroy(); };
		void (async () => {
			let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
			try {
				const file = await raceCancellationError(this.file(resource), cancellation.token);
				if (options.limits?.size !== undefined && file.size > options.limits.size) {
					throw createFileSystemProviderError('File exceeds the read size limit', FileSystemProviderErrorCode.FileTooLarge);
				}
				const start = options.position ?? 0;
				reader = file.slice(start, options.length === undefined ? undefined : start + options.length).stream().getReader();
				const activeReader = reader;
				lifetime.add(toDisposable(() => { void activeReader.cancel().catch(() => undefined); }));
				while (true) {
					if (cancellation.token.isCancellationRequested) { throw canceled(); }
					const chunk = await raceCancellationError(reader.read(), cancellation.token);
					if (chunk.done) { break; }
					await raceCancellationError(Promise.resolve(stream.write(chunk.value)), cancellation.token);
				}
			} catch (error) {
				stream.error(error instanceof Error ? error : new Error(String(error)));
			} finally {
				this.reads.deleteAndDispose(lifetime);
				reader?.releaseLock();
				stream.end();
			}
		})();
		return stream;
	}

	public watch(resource: URI, options: IWatchOptions): IDisposable {
		this.assertNotDisposed();
		partsOf(resource);
		const excludes = options.excludes.map(pattern => parse(pattern));
		const lifetime = new DisposableStore();
		const watch: BrowserFileWatch = Object.assign(lifetime, {
			resource,
			options: { recursive: options.recursive, excludes: [...options.excludes] },
			excludes,
			observer: lifetime.add(new MutableDisposable<IDisposable>()),
			isStarting: false,
		});
		this.watches.set(watch, watch);
		if (!this.foregroundListeners.value) {
			const listeners = this.foregroundListeners.value = new DisposableStore();
			listeners.add(addDisposableListener(this.ownerWindow, 'focus', () => this.scheduleRefresh(true)));
			listeners.add(addDisposableListener(this.ownerWindow.document, 'visibilitychange', () => this.scheduleRefresh(true)));
		}
		void this.startWatching(watch);
		return toDisposable(() => {
			this.watches.deleteAndDispose(watch);
			if (this.watches.size === 0) {
				this.foregroundListeners.clear();
			}
		});
	}

	private async startWatching(watch: BrowserFileWatch): Promise<void> {
		if (this.isDisposed || watch.isDisposed || watch.isStarting || watch.observer.value) {
			return;
		}
		if (!WebFileSystemObserver.supported(this.ownerWindow as Window & typeof globalThis)) {
			return;
		}
		const Observer = (this.ownerWindow as Window & { FileSystemObserver: typeof FileSystemObserver; }).FileSystemObserver;
		watch.isStarting = true;
		let observer: FileSystemObserver | undefined;
		try {
			// Restored handles are queried without prompting; permission can only be granted by a user action.
			const handle = await this.handle(watch.resource);
			if (this.isDisposed || watch.isDisposed) {
				return;
			}
			let observation: IDisposable | undefined;
			observer = new Observer(records => {
				if (observation && watch.observer.value === observation) {
					this.acceptWatchRecords(watch, records);
				}
			});
			const activeObserver = observer;
			observation = toDisposable(() => activeObserver.disconnect());
			watch.observer.value = observation;
			await observer.observe(handle, { recursive: watch.options.recursive });
			// Recheck the loaded views after registration, covering changes during asynchronous handle lookup.
			this.scheduleRefresh();
		} catch {
			// Unsupported handles, revoked permission and observation limits retain the foreground fallback.
			watch.observer.clear();
		} finally {
			watch.isStarting = false;
			// An observation that completes after cancellation must not revive the released watch.
			if (this.isDisposed || watch.isDisposed) {
				observer?.disconnect();
			}
		}
	}

	private acceptWatchRecords(watch: BrowserFileWatch, records: readonly FileSystemObserverRecord[]): void {
		if (this.isDisposed || watch.isDisposed || records.length === 0) {
			return;
		}
		const resources = new Map<string, URI>();
		let shouldRescan = false;
		for (const record of records) {
			if (record.type === 'errored') {
				watch.observer.clear();
			}
			if (!['appeared', 'disappeared', 'modified', 'moved'].includes(record.type)) {
				shouldRescan = true;
				continue;
			}
			const paths = [record.relativePathComponents];
			if (record.type === 'moved') {
				if (record.relativePathMovedFrom) {
					paths.push(record.relativePathMovedFrom);
				} else {
					shouldRescan = true;
				}
			}
			for (const parts of paths) {
				if (parts.some(part => !part || part === '.' || part === '..' || part.includes('/') || part.includes('\\'))) {
					shouldRescan = true;
					continue;
				}
				if (!watch.options.recursive && parts.length > 1) {
					continue;
				}
				const resource = parts.reduce((parent, name) => childUri(parent, name), watch.resource);
				if (watch.excludes.some(matches => matches(parts.join('/')) || matches(resource.path))) {
					continue;
				}
				resources.set(extUri.getComparisonKey(resource), resource);
			}
		}
		if (this.ownerWindow.document.hidden) {
			return;
		}
		if (shouldRescan) {
			this.scheduleRefresh();
		} else if (resources.size > 0) {
			this.changes.fire({ resources: [...resources.values()] });
		}
	}

	private scheduleRefresh(retryObservers = false): void {
		if (this.isDisposed || this.watches.size === 0 || this.ownerWindow.document.hidden) {
			return;
		}
		this.shouldRetryObservers ||= retryObservers;
		if (this.isRefreshScheduled) {
			return;
		}
		this.isRefreshScheduled = true;
		this.ownerWindow.queueMicrotask(() => {
			this.isRefreshScheduled = false;
			const shouldRetry = this.shouldRetryObservers;
			this.shouldRetryObservers = false;
			if (this.isDisposed || this.watches.size === 0 || this.ownerWindow.document.hidden) {
				return;
			}
			// Coarse invalidation rechecks open clean models and loaded, expanded tree nodes; it never scans the workspace here.
			this.changes.fire({ resources: undefined });
			if (shouldRetry) {
				for (const [, watch] of this.watches) {
					void this.startWatching(watch);
				}
			}
		});
	}

	public async writeFile(resource: URI, bytes: Uint8Array, options: IFileWriteOptions): Promise<IFileWriteResult> {
		const { parent, name } = await this.parent(resource);
		let handle: FileSystemFileHandle;
		let created = false;
		try {
			handle = await parent.getFileHandle(name);
			if (!options.overwrite) throw createFileSystemProviderError(localize({ bundle: 'ash', key: 'workbench.browserFolderFileExists' }, 'File already exists'), FileSystemProviderErrorCode.FileExists);
		} catch (error) {
			if (!isMissing(error) || !options.create || options.expectedRevision !== undefined) throw fileError(error, resource);
			handle = await parent.getFileHandle(name, { create: true });
			created = true;
		}
		if (options.expectedRevision !== undefined) {
			const current = new Uint8Array(await (await handle.getFile()).arrayBuffer());
			if (await revision(current) !== options.expectedRevision) throw new FileRevisionConflictError(resource);
		}
		let writable: FileSystemWritableFileStream | undefined;
		try {
			writable = await handle.createWritable();
			await writable.write(Uint8Array.from(bytes));
			await writable.close();
		} catch (error) {
			await writable?.abort().catch(() => undefined);
			if (created) await parent.removeEntry(name);
			throw error;
		}
		this.changes.fire({ resources: [resource] });
		return { stat: await this.stat(resource), revision: await revision(bytes) };
	}

	public async createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat> {
		const { parent, name } = await this.parent(resource);
		let found = true;
		try { await parent.getFileHandle(name); }
		catch (error) { if (!isMissing(error)) throw fileError(error, resource); found = false; }
		if (found && existing === 'error') throw createFileSystemProviderError(localize({ bundle: 'ash', key: 'workbench.browserFolderFileExists' }, 'File already exists'), FileSystemProviderErrorCode.FileExists);
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

	public async createDirectory(resource: URI): Promise<IFileStat> {
		const { parent, name } = await this.parent(resource);
		await parent.getDirectoryHandle(name, { create: true });
		this.changes.fire({ resources: [resource] });
		return this.stat(resource);
	}

	public async copy(source: URI, target: URI): Promise<void> {
		const sourceParts = partsOf(source);
		const targetParts = partsOf(target);
		if (sourceParts.parts.length === 0 || targetParts.parts.length === 0 ||
			(sourceParts.id === targetParts.id && target.path.startsWith(`${source.path}/`))) {
			throw new FileOperationNotSupportedError(source, 'copy');
		}
		const sourceHandle = await this.handle(source);
		const { parent, name } = await this.parent(target);
		try { await this.handle(target); throw createFileSystemProviderError('Copy target already exists', FileSystemProviderErrorCode.FileExists); }
		catch (error) { if (!(error instanceof FileNotFoundError)) throw error; }
		const copyEntry = async (from: FileSystemHandle, toParent: FileSystemDirectoryHandle, toName: string): Promise<void> => {
			if (WebFileSystemAccess.isFileSystemDirectoryHandle(from)) {
				const to = await toParent.getDirectoryHandle(toName, { create: true });
				for await (const [childName, child] of from.entries()) await copyEntry(child, to, childName);
			} else if (WebFileSystemAccess.isFileSystemFileHandle(from)) {
				const file = await toParent.getFileHandle(toName, { create: true });
				const writable = await file.createWritable();
				try { await writable.write(await from.getFile()); await writable.close(); }
				catch (error) { await writable.abort(); throw error; }
			}
		};
		try { await copyEntry(sourceHandle, parent, name); }
		catch (error) { await parent.removeEntry(name, { recursive: true }); throw error; }
		this.changes.fire({ resources: [target] });
	}

	public async rename(source: URI, target: URI, existing: FileExistingTargetBehavior): Promise<void> {
		const sourceParts = partsOf(source);
		const targetParts = partsOf(target);
		if (sourceParts.id !== targetParts.id || sourceParts.parts.length === 0 || targetParts.parts.length === 0) {
			throw new FileOperationNotSupportedError(source, 'rename');
		}
		if (source.toString() === target.toString()) return;
		const handle = await this.handle(source);
		if (!WebFileSystemAccess.isFileSystemFileHandle(handle)) throw new FileOperationNotSupportedError(source, 'renameDirectory');
		try {
			await this.stat(target);
			if (existing === 'ignore') return;
			if (existing === 'error') throw createFileSystemProviderError(localize({ bundle: 'ash', key: 'workbench.browserFolderTargetExists' }, 'Target file already exists'), FileSystemProviderErrorCode.FileExists);
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
		if (!WebFileSystemAccess.isFileSystemFileHandle(handle)) throw createFileSystemProviderError('Expected a file', FileSystemProviderErrorCode.FileIsADirectory);
		return handle.getFile();
	}

	private async handle(resource: URI): Promise<FileSystemHandle> {
		const { saved, parts } = await this.directory(resource, false);
		let current: FileSystemHandle = saved.handle;
		for (const part of parts) {
			if (!WebFileSystemAccess.isFileSystemDirectoryHandle(current)) throw new FileNotFoundError(resource);
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

	private async parent(resource: URI): Promise<{ parent: FileSystemDirectoryHandle; name: string; }> {
		const { saved, parts } = await this.directory(resource, false);
		if (parts.length === 0) throw new FileOperationNotSupportedError(resource, 'modifyRoot');
		let parent = saved.handle;
		for (const part of parts.slice(0, -1)) {
			try { parent = await parent.getDirectoryHandle(part); }
			catch (error) { throw fileError(error, resource); }
		}
		return { parent, name: parts[parts.length - 1]! };
	}

	private async directory(resource: URI, requestPermission: boolean): Promise<{ saved: SavedDirectory; parts: readonly string[]; }> {
		const { id, name, parts } = partsOf(resource);
		let saved = this.directories.get(id);
		if (!saved) {
			const database = await this.database;
			saved = await database.runInTransaction<SavedDirectory | undefined>(STORE_NAME, 'readonly', store => store.get(id));
			if (!saved) throw new FileNotFoundError(resource);
		}
		if (saved.name !== name) throw new FileNotFoundError(resource);
		const handle = saved.handle as PermissionedDirectoryHandle;
		const permission = await handle.queryPermission({ mode: 'readwrite' });
		if (permission !== 'granted' && (!requestPermission || await handle.requestPermission({ mode: 'readwrite' }) !== 'granted')) {
			throw createFileSystemProviderError(localize({ bundle: 'ash', key: 'workbench.browserFolderPermission' }, 'Browser folder permission is required'), FileSystemProviderErrorCode.NoPermissions);
		}
		this.directories.set(id, saved);
		return { saved, parts };
	}
}

function partsOf(resource: URI): { id: string; name: string; parts: readonly string[]; } {
	const encodedPath = resource.toEncodedComponents().path;
	if (resource.scheme !== 'file' || resource.authority || resource.query || resource.fragment || !encodedPath.startsWith(ROOT_PREFIX)) {
		throw new FileNotFoundError(resource);
	}
	const segments = encodedPath.slice(ROOT_PREFIX.length).split('/').map(decodeURIComponent);
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
	return parent.joinPathSegment(name);
}

async function revision(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
	return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

function isMissing(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'NotFoundError';
}

function fileError(error: unknown, resource: URI): unknown {
	if (isMissing(error)) { return new FileNotFoundError(resource); }
	if (error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)) {
		return createFileSystemProviderError(error, FileSystemProviderErrorCode.NoPermissions);
	}
	return error;
}
