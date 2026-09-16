import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { FileKind, FileNotFoundError, FileRevisionConflictError, type FileDeleteMode, type FileExistingTargetBehavior, type FileMissingTargetBehavior, type IFileBytes, type IFileChangeEvent, type IFileContent, type IFileEntry, type IFileService, type IFileStat, type IFileWriteRequest, type IFileWriteResult } from '../common/files.js';

/** Local file access restricted to the roots granted by the desktop host. */
export class DiskFileSystemProvider extends Disposable implements IFileService {
	private readonly changes = this._register(new Emitter<IFileChangeEvent>());
	public readonly onDidChangeFiles = this.changes.event;
	private readonly roots: readonly string[];

	constructor(roots: readonly URI[]) {
		super();
		this.roots = roots.map(root => resolve(root.fsPath));
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

	public async readFile(resource: URI): Promise<IFileContent> {
		const value = await this.readFileBytes(resource);
		return { resource, content: new TextDecoder('utf-8', { fatal: true }).decode(value.bytes), revision: value.revision };
	}

	public async readFileBytes(resource: URI): Promise<IFileBytes> {
		try {
			const bytes = await readFile(await this.path(resource));
			return { resource, bytes, revision: revision(bytes) };
		} catch (error) { throw fileError(error, resource); }
	}

	public async writeFile(request: IFileWriteRequest): Promise<IFileWriteResult> {
		const path = await this.path(request.resource);
		await mkdir(dirname(path), { recursive: true });
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, request.content, { encoding: 'utf8', flag: 'wx' });
			if (request.expectedRevision !== undefined && (await this.readFile(request.resource)).revision !== request.expectedRevision) throw new FileRevisionConflictError(request.resource);
			await rename(temporary, path);
		} finally { await rm(temporary, { force: true }); }
		this.changes.fire({ resources: [request.resource] });
		return { stat: await this.stat(request.resource), revision: revision(Buffer.from(request.content)) };
	}

	public async createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat> {
		const path = await this.path(resource);
		await mkdir(dirname(path), { recursive: true });
		try { await writeFile(path, '', { flag: existing === 'overwrite' ? 'w' : 'wx' }); }
		catch (error) { if (existing !== 'ignore' || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
		this.changes.fire({ resources: [resource] });
		return this.stat(resource);
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
