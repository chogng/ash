import { BroadcastDataChannel } from '../../../base/browser/broadcast.js';
import { IndexedDB } from '../../../base/browser/indexedDB.js';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
import {
	createFileSystemProviderError,
	FileSystemProviderErrorCode,
	FileKind,
	FileNotFoundError,
	FileRevisionConflictError,
	FileSystemProviderCapabilities,
	type IFileSystemProvider,
	type IFileStat,
	type IFileEntry,
	type IFileBytes,
	type IFileWriteOptions,
	type IFileWriteResult,
	type IFileChangeEvent,
	type IWatchOptions,
	type FileExistingTargetBehavior,
	type FileMissingTargetBehavior,
	type FileDeleteMode,
} from '../common/files.js';

interface Entry {
	readonly kind: FileKind.File | FileKind.Directory;
	readonly bytes: Uint8Array;
	readonly revision: string;
	readonly modifiedAtMillis: number;
}

/** Browser files with atomic revision checks shared by every window on the same origin. */
export class IndexedDBFileSystemProvider extends Disposable implements IFileSystemProvider {
	public readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy | FileSystemProviderCapabilities.PathCaseSensitive;
	public readonly onDidChangeCapabilities = Event.None;
	private readonly changes = this._register(new Emitter<IFileChangeEvent>());
	public readonly onDidChangeFiles = this.changes.event;
	private readonly channel: BroadcastDataChannel<null>;

	private constructor(private readonly database: IndexedDB, private readonly scheme: string) {
		super();
		this._register(toDisposable(() => database.close()));
		this.channel = this._register(new BroadcastDataChannel<null>('ash-user-data-files'));
		this._register(this.channel.onDidReceiveData(() => this.changes.fire({ resources: undefined })));
	}

	public static async create(factory: IDBFactory, scheme: string): Promise<IndexedDBFileSystemProvider> {
		const database = await IndexedDB.create('ash-user-data-files', 1, ['files'], factory);
		return new IndexedDBFileSystemProvider(database, scheme);
	}

	public async stat(resource: URI): Promise<IFileStat> {
		return this.access(false, entries => this.fileStat(resource, this.entry(entries, resource)));
	}

	public async readDirectory(resource: URI): Promise<readonly IFileEntry[]> {
		return this.access(false, entries => {
			if (this.entry(entries, resource).kind !== FileKind.Directory) {
				throw createFileSystemProviderError('Expected a directory', FileSystemProviderErrorCode.FileNotADirectory);
			}
			const prefix = this.key(resource).replace(/\/$/u, '') + '/';
			return [...entries].filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
				.map(([key, entry]) => ({ resource: URI.parse(key), name: key.slice(prefix.length), kind: entry.kind }));
		});
	}

	public async readFile(resource: URI): Promise<IFileBytes> {
		return this.access(false, entries => {
			const entry = this.entry(entries, resource);
			if (entry.kind !== FileKind.File) {
				throw createFileSystemProviderError('Expected a file', FileSystemProviderErrorCode.FileIsADirectory);
			}
			return { resource, bytes: entry.bytes, revision: entry.revision };
		});
	}

	public watch(resource: URI, _options: IWatchOptions): IDisposable {
		this.assertNotDisposed();
		this.key(resource);
		// Cross-window invalidations are already delivered by the database-owned BroadcastChannel.
		return Disposable.None;
	}

	public async createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat> {
		return this.access(true, entries => {
			const current = entries.get(this.key(resource));
			if (current?.kind === FileKind.Directory) {
				throw createFileSystemProviderError('Expected a file', FileSystemProviderErrorCode.FileIsADirectory);
			}
			if (current && existing === 'error') {
				throw createFileSystemProviderError('File already exists', FileSystemProviderErrorCode.FileExists);
			}
			if (current && existing === 'ignore') {
				return this.fileStat(resource, current);
			}
			this.parents(entries, resource);
			const entry = this.newEntry(FileKind.File, new Uint8Array());
			entries.set(this.key(resource), entry);
			return this.fileStat(resource, entry);
		});
	}

	public async createDirectory(resource: URI): Promise<IFileStat> {
		return this.access(true, entries => {
			this.parents(entries, resource);
			const entry = entries.get(this.key(resource)) ?? this.newEntry(FileKind.Directory, new Uint8Array());
			if (entry.kind !== FileKind.Directory) {
				throw createFileSystemProviderError('A file occupies this directory', FileSystemProviderErrorCode.FileExists);
			}
			entries.set(this.key(resource), entry);
			return this.fileStat(resource, entry);
		});
	}

	public async copy(source: URI, target: URI): Promise<void> {
		await this.transfer(source, target, 'error', false);
	}

	public async rename(source: URI, target: URI, existing: FileExistingTargetBehavior): Promise<void> {
		await this.transfer(source, target, existing, true);
	}

	public async delete(resource: URI, missing: FileMissingTargetBehavior, mode: FileDeleteMode): Promise<void> {
		await this.access(true, entries => {
			const key = this.key(resource);
			if (!entries.has(key) && missing === 'error') {
				throw new FileNotFoundError(resource);
			}
			const children = [...entries.keys()].filter(candidate => candidate.startsWith(key + '/'));
			if (children.length && mode !== 'recursive') {
				throw new Error('Directory is not empty');
			}
			for (const child of children) {
				entries.delete(child);
			}
			entries.delete(key);
		});
	}

	public async writeFile(resource: URI, bytes: Uint8Array, options: IFileWriteOptions): Promise<IFileWriteResult> {
		return this.access(true, entries => {
			const key = this.key(resource);
			const current = entries.get(key);
			if (current && !options.overwrite) throw createFileSystemProviderError('File already exists', FileSystemProviderErrorCode.FileExists);
			if (!current && !options.create) throw new FileNotFoundError(resource);
			if (options.expectedRevision !== undefined && current?.revision !== options.expectedRevision) {
				throw new FileRevisionConflictError(resource);
			}
			if (current?.kind === FileKind.Directory) {
				throw createFileSystemProviderError('Expected a file', FileSystemProviderErrorCode.FileIsADirectory);
			}
			this.parents(entries, resource);
			const entry = this.newEntry(FileKind.File, bytes);
			entries.set(key, entry);
			return { stat: this.fileStat(resource, entry), revision: entry.revision };
		});
	}

	private async transfer(source: URI, target: URI, existing: FileExistingTargetBehavior, move: boolean): Promise<void> {
		await this.access(true, entries => {
			const from = this.key(source);
			const to = this.key(target);
			this.entry(entries, source);
			if (to === from || to.startsWith(from + '/')) {
				throw new Error('Cannot move or copy into itself');
			}
			if (entries.has(to)) {
				if (existing === 'ignore') {
					return;
				}
				if (existing === 'error') {
					throw createFileSystemProviderError('Target already exists', FileSystemProviderErrorCode.FileExists);
				}
				for (const key of entries.keys()) {
					if (key === to || key.startsWith(to + '/')) {
						entries.delete(key);
					}
				}
			}
			this.parents(entries, target);
			for (const [key, entry] of [...entries]) {
				if (key !== from && !key.startsWith(from + '/')) {
					continue;
				}
				entries.set(to + key.slice(from.length), this.newEntry(entry.kind, entry.bytes));
				if (move) {
					entries.delete(key);
				}
			}
		});
	}

	private async access<T>(write: boolean, operation: (entries: Map<string, Entry>) => T): Promise<T> {
		this.assertNotDisposed();
		let result!: T;
		let failure: unknown;
		try {
			await this.database.runInTransaction('files', write ? 'readwrite' : 'readonly', store => {
				const keys = store.getAllKeys();
				const values = store.getAll();
				values.onsuccess = () => {
					try {
						const before = new Map(keys.result.map((key, index) => [String(key), values.result[index] as Entry]));
						const entries = new Map(before);
						result = operation(entries);
						if (write) {
							for (const key of before.keys()) {
								if (!entries.has(key)) {
									store.delete(key);
								}
							}
							for (const [key, entry] of entries) {
								if (before.get(key) !== entry) {
									store.put(entry, key);
								}
							}
						}
					} catch (error) { failure = error; store.transaction.abort(); }
				};
				return values;
			});
		} catch (error) {
			throw failure ?? error;
		}
		if (write && !this.isDisposed) { this.channel.postData(null); this.changes.fire({ resources: undefined }); }
		return result;
	}

	private key(resource: URI): string {
		if (resource.scheme !== this.scheme || resource.query || resource.fragment || resource.path.split('/').some(segment => segment === '.' || segment === '..')) {
			throw new TypeError('Invalid file resource');
		}
		return resource.toString();
	}

	private entry(entries: Map<string, Entry>, resource: URI): Entry {
		const entry = entries.get(this.key(resource));
		if (!entry) {
			throw new FileNotFoundError(resource);
		}
		return entry;
	}

	private parents(entries: Map<string, Entry>, resource: URI): void {
		const segments = resource.path.split('/').filter(Boolean);
		for (let index = 1; index < segments.length; index++) {
			const key = this.key(resource.with({ path: '/' + segments.slice(0, index).join('/') }));
			const parent = entries.get(key);
			if (parent && parent.kind !== FileKind.Directory) {
				throw createFileSystemProviderError('Parent is not a directory', FileSystemProviderErrorCode.FileNotADirectory);
			}
			if (!parent) {
				entries.set(key, this.newEntry(FileKind.Directory, new Uint8Array()));
			}
		}
	}

	private newEntry(kind: Entry['kind'], bytes: Uint8Array): Entry {
		return { kind, bytes, revision: crypto.randomUUID(), modifiedAtMillis: Date.now() };
	}

	private fileStat(resource: URI, entry: Entry): IFileStat {
		return { resource, kind: entry.kind, sizeBytes: entry.bytes.byteLength, readonly: false, modifiedAtMillis: entry.modifiedAtMillis };
	}
}
