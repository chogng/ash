import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { basename, dirname, extUri } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import {
	FileKind,
	FileNotFoundError,
	FileRevisionConflictError,
	FileSystemProviderCapabilities,
	FileSystemProviderError,
	FileSystemProviderErrorCode,
	type FileDeleteMode,
	type FileExistingTargetBehavior,
	type FileMissingTargetBehavior,
	type IFileChangeEvent,
	type IFileStat,
	type IFileSystemProvider,
	type IFileWriteOptions,
} from './files.js';

interface MemoryEntry {
	readonly resource: URI;
	readonly kind: FileKind;
	readonly bytes: Uint8Array;
	readonly revision: string;
	readonly modifiedAtMillis: number;
}

/** A disposable filesystem for hosts whose edits must never reach durable storage. */
export class InMemoryFileSystemProvider extends Disposable implements IFileSystemProvider {
	readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy | FileSystemProviderCapabilities.PathCaseSensitive;
	readonly onDidChangeCapabilities = Event.None;
	private readonly changes = this._register(new Emitter<IFileChangeEvent>());
	readonly onDidChangeFiles = this.changes.event;
	private readonly entries = new Map<string, MemoryEntry>();
	private revision = 0;

	watch(resource: URI): IDisposable {
		this.key(resource);
		return Disposable.None;
	}

	async stat(resource: URI): Promise<IFileStat> {
		return this.metadata(this.get(resource));
	}

	async readDirectory(resource: URI) {
		this.requireKind(this.get(resource), FileKind.Directory);
		return [...this.entries.values()]
			.filter(entry => this.key(dirname(entry.resource)) === this.key(resource) && entry.resource.path !== '/')
			.map(entry => ({ resource: entry.resource, name: basename(entry.resource), kind: entry.kind }));
	}

	async readFile(resource: URI) {
		const entry = this.get(resource);
		this.requireKind(entry, FileKind.File);
		return { resource, bytes: entry.bytes.slice(), revision: entry.revision };
	}

	async writeFile(resource: URI, content: Uint8Array, options: IFileWriteOptions, signal?: AbortSignal) {
		signal?.throwIfAborted();
		const current = this.entries.get(this.key(resource));
		if (current) {
			this.requireKind(current, FileKind.File);
			if (!options.overwrite) this.exists(resource);
		} else if (!options.create) throw new FileNotFoundError(resource);
		if (options.expectedRevision !== undefined && options.expectedRevision !== current?.revision) throw new FileRevisionConflictError(resource);
		this.requireKind(this.get(dirname(resource)), FileKind.Directory);
		const entry = this.put(resource, FileKind.File, content);
		this.changes.fire({ resources: [resource] });
		return { stat: this.metadata(entry), revision: entry.revision };
	}

	async createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat> {
		const current = this.entries.get(this.key(resource));
		if (current) {
			this.requireKind(current, FileKind.File);
			if (existing === 'error') this.exists(resource);
			if (existing === 'ignore') return this.metadata(current);
		}
		return (await this.writeFile(resource, new Uint8Array(), { create: true, overwrite: existing === 'overwrite' })).stat;
	}

	async createDirectory(resource: URI): Promise<IFileStat> {
		const key = this.key(resource);
		const current = this.entries.get(key);
		if (current) {
			this.requireKind(current, FileKind.Directory);
			return this.metadata(current);
		}
		if (resource.path !== '/') await this.createDirectory(dirname(resource));
		const entry = this.put(resource, FileKind.Directory, new Uint8Array());
		this.changes.fire({ resources: [resource] });
		return this.metadata(entry);
	}

	async copy(source: URI, target: URI): Promise<void> {
		this.transfer(source, target, 'error', false);
	}
	async rename(source: URI, target: URI, existing: FileExistingTargetBehavior): Promise<void> {
		this.transfer(source, target, existing, true);
	}

	async delete(resource: URI, missing: FileMissingTargetBehavior, mode: FileDeleteMode): Promise<void> {
		if (!this.entries.has(this.key(resource))) {
			if (missing === 'error') throw new FileNotFoundError(resource);
			return;
		}
		const affected = this.subtree(resource);
		if (affected.length > 1 && mode !== 'recursive') throw new FileSystemProviderError('Directory is not empty', FileSystemProviderErrorCode.Unknown);
		for (const entry of affected) this.entries.delete(this.key(entry.resource));
		this.changes.fire({ resources: affected.map(entry => entry.resource) });
	}

	private transfer(source: URI, target: URI, existing: FileExistingTargetBehavior, move: boolean): void {
		this.get(source);
		if (this.key(source) === this.key(target) && move) return;
		if (source.path === '/' || extUri.isEqualOrParent(target, source) || extUri.isEqualOrParent(source, target)) {
			throw new FileSystemProviderError('Cannot transfer overlapping directories', FileSystemProviderErrorCode.NoPermissions);
		}
		this.requireKind(this.get(dirname(target)), FileKind.Directory);
		if (this.entries.has(this.key(target))) {
			if (existing === 'ignore') return;
			if (existing === 'error') this.exists(target);
		}
		const entries = this.subtree(source);
		const replaced = this.subtree(target);
		for (const entry of replaced) this.entries.delete(this.key(entry.resource));
		for (const entry of entries) {
			this.put(target.with({ path: target.path + entry.resource.path.slice(source.path.length) }), entry.kind, entry.bytes);
			if (move) this.entries.delete(this.key(entry.resource));
		}
		this.changes.fire({ resources: [source, target] });
	}

	private key(resource: URI): string {
		this.assertNotDisposed();
		if (!resource.scheme || !resource.path.startsWith('/') || resource.query || resource.fragment || resource.path.split('/').some(part => part === '.' || part === '..')) {
			throw new FileSystemProviderError('Expected an absolute filesystem resource', FileSystemProviderErrorCode.Unavailable);
		}
		return resource.with({ path: resource.path.replace(/\/+$/, '') || '/' }).toString();
	}

	private get(resource: URI): MemoryEntry {
		const key = this.key(resource);
		const entry = this.entries.get(key);
		if (entry) return entry;
		if (resource.path === '/') return this.put(resource, FileKind.Directory, new Uint8Array());
		throw new FileNotFoundError(resource);
	}

	private put(resource: URI, kind: FileKind, bytes: Uint8Array): MemoryEntry {
		const key = this.key(resource);
		const entry = {
			resource: URI.parse(key),
			kind,
			bytes: bytes.slice(),
			revision: String(++this.revision),
			modifiedAtMillis: Date.now(),
		};
		this.entries.set(key, entry);
		return entry;
	}

	private subtree(resource: URI): MemoryEntry[] {
		return [...this.entries.values()].filter(entry => extUri.isEqualOrParent(entry.resource, resource));
	}

	private metadata(entry: MemoryEntry): IFileStat {
		return {
			resource: entry.resource,
			kind: entry.kind,
			sizeBytes: entry.bytes.byteLength,
			readonly: false,
			modifiedAtMillis: entry.modifiedAtMillis,
		};
	}

	private requireKind(entry: MemoryEntry, kind: FileKind): void {
		if (entry.kind !== kind)
			throw new FileSystemProviderError(
				`Unexpected resource kind: ${entry.resource.toString()}`,
				kind === FileKind.File ? FileSystemProviderErrorCode.FileIsADirectory : FileSystemProviderErrorCode.FileNotADirectory,
			);
	}

	private exists(resource: URI): never {
		throw new FileSystemProviderError(`Resource exists: ${resource.toString()}`, FileSystemProviderErrorCode.FileExists);
	}

	protected override disposeCore(): void {
		this.entries.clear();
		super.disposeCore();
	}
}
