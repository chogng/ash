import { createHash, randomUUID } from 'node:crypto';
import { copyFile, link, lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { constants, watch } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Emitter, Event } from '../../../base/common/event.js';
import { parse } from '../../../base/common/glob.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { FileKind, FileNotFoundError, FileRevisionConflictError, FileSystemProviderCapabilities, type FileDeleteMode, type FileExistingTargetBehavior, type FileMissingTargetBehavior, type IFileBytes, type IFileChangeEvent, type IFileEntry, type IFileSystemProvider, type IFileStat, type IFileWriteOptions, type IFileWriteResult, type IWatchOptions } from '../common/files.js';

/** Local file access restricted to the roots granted by the desktop host. */
export class DiskFileSystemProvider extends Disposable implements IFileSystemProvider {
	public readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy;
	public readonly onDidChangeCapabilities = Event.None;
	private readonly changes = this._register(new Emitter<IFileChangeEvent>());
	public readonly onDidChangeFiles = this.changes.event;
	private readonly watchErrors = this._register(new Emitter<string>());
	public readonly onDidWatchError = this.watchErrors.event;
	private readonly watchers = this._register(new DisposableMap<string, DisposableStore>());
	private readonly roots: readonly string[];
	// Windows have separate provider instances; compare-and-write must share one host queue.
	private static readonly pendingWrites = new Map<string, Promise<unknown>>();

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
			const bytes = await readFile(await this.path(resource));
			return { resource, bytes, revision: revision(bytes) };
		} catch (error) { throw fileError(error, resource); }
	}

	public async writeFile(resource: URI, content: Uint8Array, options: IFileWriteOptions): Promise<IFileWriteResult> {
		const path = await this.path(resource);
		return this.withWrite(path, async () => {
			let exists = true;
			try { await lstat(path); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; exists = false; }
			if (exists && !options.overwrite) throw new Error(`File already exists: ${resource.toString()}`);
			if (!exists && !options.create) throw new FileNotFoundError(resource);
			await mkdir(dirname(path), { recursive: true });
			const temporary = `${path}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporary, content, { flag: 'wx' });
				if (options.expectedRevision !== undefined && (await this.readFile(resource)).revision !== options.expectedRevision) {
					throw new FileRevisionConflictError(resource);
				}
				if (options.overwrite) await rename(temporary, path);
				else await link(temporary, path);
			} finally { await rm(temporary, { force: true }); }
			this.changes.fire({ resources: [resource] });
			return { stat: await this.stat(resource), revision: revision(content) };
		});
	}

	public async createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat> {
		const path = await this.path(resource);
		await mkdir(dirname(path), { recursive: true });
		try { await writeFile(path, '', { flag: existing === 'overwrite' ? 'w' : 'wx' }); }
		catch (error) { if (existing !== 'ignore' || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
		this.changes.fire({ resources: [resource] });
		return this.stat(resource);
	}

	public async createDirectory(resource: URI): Promise<IFileStat> {
		await mkdir(await this.path(resource), { recursive: true });
		this.changes.fire({ resources: [resource] });
		return this.stat(resource);
	}

	public async copy(source: URI, target: URI): Promise<void> {
		const from = await this.path(source);
		const to = await this.path(target);
		if (this.roots.includes(from) || this.roots.includes(to) || to === from || to.startsWith(`${from}${sep}`)) throw new Error('Cannot copy a granted root or into itself');
		try { await lstat(to); throw new Error('Copy target already exists'); }
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
		catch (error) { if (created) await rm(to, { recursive: true, force: true }); throw error; }
		this.changes.fire({ resources: [target] });
	}

	public async rename(source: URI, target: URI, existing: FileExistingTargetBehavior): Promise<void> {
		const from = await this.path(source);
		const to = await this.path(target);
		if (this.roots.includes(from) || this.roots.includes(to)) throw new Error('Cannot rename a granted root');
		await mkdir(dirname(to), { recursive: true });
		if (existing === 'overwrite') {
			await rename(from, to);
		} else if ((await lstat(from)).isDirectory()) {
			let exists = false;
			try { await lstat(to); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
			if (exists) {
				if (existing === 'ignore') return;
				throw new Error('Target directory already exists');
			}
			await rename(from, to);
		} else {
			try { await link(from, to); }
			catch (error) { if (existing === 'ignore' && (error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
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

	private async withWrite<T>(path: string, operation: () => Promise<T>): Promise<T> {
		const previous = DiskFileSystemProvider.pendingWrites.get(path);
		const pending = (previous ?? Promise.resolve()).catch(() => undefined).then(operation);
		DiskFileSystemProvider.pendingWrites.set(path, pending);
		try { return await pending; }
		finally {
			if (DiskFileSystemProvider.pendingWrites.get(path) === pending) {
				DiskFileSystemProvider.pendingWrites.delete(path);
			}
		}
	}

	private async path(resource: URI): Promise<string> {
		if (resource.scheme !== 'file' || resource.query || resource.fragment) throw new Error('Expected a local file resource');
		const path = resolve(resource.fsPath);
		const root = this.roots.find(candidate => { const child = relative(candidate, path); return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)); });
		if (!root) throw new Error('File resource is outside the granted roots');
		let current = path;
		while (true) {
			try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Symbolic links are not permitted in granted file resources'); }
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
	return (error as NodeJS.ErrnoException).code === 'ENOENT' ? new FileNotFoundError(resource) : error;
}
