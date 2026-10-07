import { createHash, randomUUID } from 'node:crypto';
import { copyFile, link, lstat, mkdir, open, readdir, rm, rmdir, writeFile, type FileHandle } from 'node:fs/promises';
import { constants, watch } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Emitter, Event } from '../../../base/common/event.js';
import { ResourceQueue } from '../../../base/common/async.js';
import { extUriBiasedIgnorePathCase } from '../../../base/common/resources.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { canceled } from '../../../base/common/errors.js';
import { consumeStream, newWriteableStream, type ReadableStreamEvents } from '../../../base/common/stream.js';
import { parse } from '../../../base/common/glob.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { Promises } from '../../../base/node/pfs.js';
import { readFileIntoStream } from '../common/io.js';
import {
	createFileSystemProviderError,
	FileSystemProviderErrorCode,
	FileKind,
	FileNotFoundError,
	FileRevisionConflictError,
	FileSystemProviderCapabilities,
	type FileDeleteMode,
	type FileExistingTargetBehavior,
	type FileMissingTargetBehavior,
	type IFileBytes,
	type IFileChangeEvent,
	type IFileEntry,
	type IFileSystemProviderWithOpenReadWriteCloseCapability,
	type IFileSystemProviderWithFileReadStreamCapability,
	type IFileOpenOptions,
	type IFileReadStreamOptions,
	type IFileStat,
	type IFileWriteOptions,
	type IFileWriteResult,
	type IWatchOptions,
} from '../common/files.js';

/** Local file access restricted to the roots granted by the desktop host. */
export class DiskFileSystemProvider extends Disposable implements IFileSystemProviderWithOpenReadWriteCloseCapability, IFileSystemProviderWithFileReadStreamCapability {
	public readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy | FileSystemProviderCapabilities.FileOpenReadWriteClose | FileSystemProviderCapabilities.FileReadStream;
	public readonly onDidChangeCapabilities = Event.None;
	private readonly changes = this._register(new Emitter<IFileChangeEvent>());
	public readonly onDidChangeFiles = this.changes.event;
	private readonly watchErrors = this._register(new Emitter<string>());
	public readonly onDidWatchError = this.watchErrors.event;
	private readonly watchers = this._register(new DisposableMap<string, DisposableStore>());
	private readonly reads = this._register(new DisposableMap<object>());
	private readonly handles = this._register(new DisposableMap<number, IDisposable & { handle: FileHandle; }>());
	private nextDescriptor = 0;
	private readonly roots: readonly string[];
	// Windows have separate provider instances; compare-and-write must share one host queue.
	private static readonly pendingWrites = new ResourceQueue();

	constructor(roots: readonly URI[]) {
		super();
		this.roots = roots.map(root => resolve(root.fsPath));
	}

	public watch(resource: URI, options: IWatchOptions): IDisposable {
		this.assertNotDisposed();
		const excludes = options.excludes.map(pattern => parse(pattern));
		const id = randomUUID();
		const resources = new DisposableStore();
		this.watchers.set(id, resources);
		void this.path(resource).then(async path => {
			let isDirectory = false;
			try { isDirectory = (await lstat(path)).isDirectory(); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
			if (resources.isDisposed) return;
			// Watch a file's parent so an atomic replacement does not leave us watching its old inode.
			const directory = isDirectory ? path : dirname(path);
			const watcher = watch(directory, { persistent: false, recursive: isDirectory && options.recursive }, (_event, filename) => {
				if (resources.isDisposed) return;
				if (filename === null) { this.changes.fire({ resources: undefined }); return; }
				const name = filename.toString();
				if (!isDirectory && (process.platform === 'win32' ? name.toLowerCase() !== basename(path).toLowerCase() : name !== basename(path))) return;
				if (excludes.some(matches => matches(name) || matches(resolve(directory, name)))) return;
				this.changes.fire({ resources: [URI.file(resolve(directory, name))] });
			});
			resources.add(toDisposable(() => watcher.close()));
			const onError = (error: Error): void => {
				this.watchErrors.fire(String(error));
				this.watchers.deleteAndDispose(id);
			};
			watcher.on('error', onError);
			resources.add(toDisposable(() => watcher.off('error', onError)));
		}).catch(error => {
			if (!resources.isDisposed) {
				this.watchErrors.fire(String(error));
				this.watchers.deleteAndDispose(id);
			}
		});
		return toDisposable(() => this.watchers.deleteAndDispose(id));
	}

	public async stat(resource: URI): Promise<IFileStat> {
		const path = await this.path(resource);
		try {
			const metadata = await lstat(path);
			return { resource, kind: metadata.isFile() ? FileKind.File : metadata.isDirectory() ? FileKind.Directory : FileKind.Other, sizeBytes: metadata.size, readonly: (metadata.mode & 0o222) === 0, modifiedAtMillis: metadata.mtimeMs };
		} catch (error) { throw fileError(error, resource); }
	}

	public async readDirectory(resource: URI): Promise<readonly IFileEntry[]> {
		try {
			const path = await this.path(resource);
			return (await readdir(path, { withFileTypes: true })).map(entry => ({ resource: URI.file(resolve(path, entry.name)), name: entry.name, kind: entry.isSymbolicLink() ? FileKind.SymbolicLink : entry.isFile() ? FileKind.File : entry.isDirectory() ? FileKind.Directory : FileKind.Other }));
		} catch (error) { throw fileError(error, resource); }
	}

	public async readFile(resource: URI): Promise<IFileBytes> {
		try {
			const bytes = await consumeStream(this.readFileStream(resource, {}, CancellationToken.None), chunks => {
				const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
				let offset = 0;
				for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
				return result;
			});
			return { resource, bytes, revision: revision(bytes) };
		} catch (error) { throw fileError(error, resource); }
	}

	public readFileStream(resource: URI, options: IFileReadStreamOptions, token: CancellationToken): ReadableStreamEvents<Uint8Array> {
		this.assertNotDisposed();
		const stream = newWriteableStream<Uint8Array>(null, { highWaterMark: 1 });
		const cancellation = new CancellationTokenSource(token);
		const lifetime = {};
		this.reads.set(lifetime, toDisposable(() => cancellation.dispose(true)));
		const destroy = stream.destroy;
		stream.destroy = (): void => { this.reads.deleteAndDispose(lifetime); destroy(); };
		void readFileIntoStream(this, resource, stream, buffer => buffer.buffer, { ...options, bufferSize: 256 * 1024, errorTransformer: error => fileError(error, resource) as Error }, cancellation.token)
			.finally(() => this.reads.deleteAndDispose(lifetime));
		return stream;
	}

	public async open(resource: URI, options: IFileOpenOptions): Promise<number> {
		this.assertNotDisposed();
		let handle: FileHandle;
		try { handle = await open(await this.path(resource), options.create ? 'w+' : 'r'); }
		catch (error) { throw fileError(error, resource); }
		if (this.isDisposed) { await handle.close(); throw canceled(); }
		const descriptor = ++this.nextDescriptor;
		this.handles.set(descriptor, Object.assign(toDisposable(() => { void handle.close().catch(() => undefined); }), { handle }));
		return descriptor;
	}

	public async read(fd: number, position: number, data: Uint8Array, offset: number, length: number): Promise<number> {
		const entry = this.handles.get(fd);
		if (!entry) { throw new Error('File descriptor is closed'); }
		return (await entry.handle.read(data, offset, length, position)).bytesRead;
	}

	public async write(fd: number, position: number, data: Uint8Array, offset: number, length: number): Promise<number> {
		const entry = this.handles.get(fd);
		if (!entry) { throw new Error('File descriptor is closed'); }
		return (await entry.handle.write(data, offset, length, position)).bytesWritten;
	}

	public async close(fd: number): Promise<void> {
		const entry = this.handles.get(fd);
		if (!entry) { return; }
		try { await entry.handle.close(); } finally { this.handles.deleteAndDispose(fd); }
	}

	public async writeFile(resource: URI, content: Uint8Array, options: IFileWriteOptions): Promise<IFileWriteResult> {
		const path = await this.path(resource);
		return DiskFileSystemProvider.pendingWrites.queueFor(URI.file(path), async () => {
			this.assertNotDisposed();
			let exists = true;
			try { await lstat(path); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; exists = false; }
			if (exists && !options.overwrite) throw createFileSystemProviderError(`File already exists: ${resource.toString()}`, FileSystemProviderErrorCode.FileExists);
			if (!exists && !options.create) throw new FileNotFoundError(resource);
			await mkdir(dirname(path), { recursive: true });
			const temporary = `${path}.${randomUUID()}.tmp`;
			try {
				// Reserve the unique publication path before opening its descriptor for writing.
				await writeFile(temporary, '', { flag: 'wx' });
				const descriptor = await this.open(URI.file(temporary), { create: true });
				try {
					let offset = 0;
					while (offset < content.byteLength) {
						const count = await this.write(descriptor, offset, content, offset, content.byteLength - offset);
						if (count === 0) { throw new Error('File write made no progress'); }
						offset += count;
					}
				} finally { await this.close(descriptor); }
				if (options.expectedRevision !== undefined && (await this.readFile(resource)).revision !== options.expectedRevision) {
					throw new FileRevisionConflictError(resource);
				}
				if (options.overwrite) await Promises.rename(temporary, path);
				else await link(temporary, path);
			} finally { await rm(temporary, { force: true }); }
			this.changes.fire({ resources: [resource] });
			return { stat: await this.stat(resource), revision: revision(content) };
		}, extUriBiasedIgnorePathCase).catch(error => { throw fileError(error, resource); });
	}

	public async createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat> {
		const path = await this.path(resource);
		await mkdir(dirname(path), { recursive: true });
		try { await writeFile(path, '', { flag: existing === 'overwrite' ? 'w' : 'wx' }); }
		catch (error) { if (existing !== 'ignore' || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw fileError(error, resource); }
		this.changes.fire({ resources: [resource] });
		return this.stat(resource);
	}

	public async createDirectory(resource: URI): Promise<IFileStat> {
		try { await mkdir(await this.path(resource), { recursive: true }); }
		catch (error) { throw fileError(error, resource); }
		this.changes.fire({ resources: [resource] });
		return this.stat(resource);
	}

	public async copy(source: URI, target: URI): Promise<void> {
		const from = await this.path(source);
		const to = await this.path(target);
		if (this.roots.includes(from) || this.roots.includes(to) || to === from || to.startsWith(`${from}${sep}`)) throw new Error('Cannot copy a granted root or into itself');
		try { await lstat(to); throw createFileSystemProviderError('Copy target already exists', FileSystemProviderErrorCode.FileExists); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
		let created = false;
		const copyEntry = async (fromPath: string, toPath: string): Promise<void> => {
			const metadata = await lstat(fromPath);
			if (metadata.isSymbolicLink()) throw new Error('Symbolic links cannot be copied');
			if (metadata.isDirectory()) {
				await mkdir(toPath);
				if (fromPath === from) created = true;
				for (const entry of await readdir(fromPath)) await copyEntry(resolve(fromPath, entry), resolve(toPath, entry));
			} else if (metadata.isFile()) { await copyFile(fromPath, toPath, constants.COPYFILE_EXCL); if (fromPath === from) created = true; }
			else throw new Error('Unsupported file type');
		};
		try { await copyEntry(from, to); }
		catch (error) { if (created) await rm(to, { recursive: true, force: true }); throw fileError(error, target); }
		this.changes.fire({ resources: [target] });
	}

	public async rename(source: URI, target: URI, existing: FileExistingTargetBehavior): Promise<void> {
		const from = await this.path(source);
		const to = await this.path(target);
		if (this.roots.includes(from) || this.roots.includes(to)) throw new Error('Cannot rename a granted root');
		await mkdir(dirname(to), { recursive: true });
		if (existing === 'overwrite') {
			await Promises.rename(from, to).catch(error => { throw fileError(error, target); });
		} else if ((await lstat(from)).isDirectory()) {
			let exists = false;
			try { await lstat(to); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
			if (exists) {
				if (existing === 'ignore') return;
				throw createFileSystemProviderError('Target directory already exists', FileSystemProviderErrorCode.FileExists);
			}
			await Promises.rename(from, to).catch(error => { throw fileError(error, target); });
		} else {
			try { await link(from, to); }
			catch (error) { if (existing === 'ignore' && (error as NodeJS.ErrnoException).code === 'EEXIST') return; throw fileError(error, target); }
			await rm(from);
		}
		this.changes.fire({ resources: [source, target] });
	}

	public async delete(resource: URI, missing: FileMissingTargetBehavior, mode: FileDeleteMode): Promise<void> {
		const path = await this.path(resource);
		if (this.roots.includes(path)) throw new Error('Cannot delete a granted root');
		try {
			if (mode === 'fileOrEmptyDirectory' && (await lstat(path)).isDirectory()) await rmdir(path);
			else await rm(path, { force: missing === 'ignore', recursive: mode === 'recursive' });
		} catch (error) { if (missing !== 'ignore' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw fileError(error, resource); }
		this.changes.fire({ resources: [resource] });
	}

	private async path(resource: URI): Promise<string> {
		if (resource.scheme !== 'file' || resource.query || resource.fragment) throw new Error('Expected a local file resource');
		const path = resolve(resource.fsPath);
		const root = this.roots.find(candidate => { const child = relative(candidate, path); return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)); });
		if (!root) throw createFileSystemProviderError('File resource is outside the granted roots', FileSystemProviderErrorCode.NoPermissions);
		let current = path;
		while (true) {
			try { if ((await lstat(current)).isSymbolicLink()) throw createFileSystemProviderError('Symbolic links are not permitted in granted file resources', FileSystemProviderErrorCode.NoPermissions); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
			if (current === root) break;
			current = dirname(current);
		}
		return path;
	}
}

function revision(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function fileError(error: unknown, resource: URI): unknown {
	const failure = error as NodeJS.ErrnoException;
	if (failure.code === 'ENOENT') { return new FileNotFoundError(resource); }
	const codes: Record<string, FileSystemProviderErrorCode> = {
		EEXIST: FileSystemProviderErrorCode.FileExists,
		ENOTDIR: FileSystemProviderErrorCode.FileNotADirectory,
		EISDIR: FileSystemProviderErrorCode.FileIsADirectory,
		EACCES: FileSystemProviderErrorCode.NoPermissions,
		EPERM: FileSystemProviderErrorCode.NoPermissions,
		ENOSPC: FileSystemProviderErrorCode.FileExceedsStorageQuota,
		EDQUOT: FileSystemProviderErrorCode.FileExceedsStorageQuota,
	};
	const code = failure.code && codes[failure.code];
	return code ? createFileSystemProviderError(failure, code) : error;
}
