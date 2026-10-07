import { addDisposableListener } from '../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
import type { IFileSystemProvider } from '../common/fileSystemProviderService.js';
import { FileKind, FileNotFoundError, FileRevisionConflictError, type IFileStat, type IFileEntry, type IFileContent, type IFileBytes, type IFileWriteRequest, type IFileWriteResult, type IFileChangeEvent, type FileExistingTargetBehavior, type FileMissingTargetBehavior, type FileDeleteMode } from '../common/files.js';

interface Entry {
	readonly kind: FileKind.File | FileKind.Directory;
	readonly bytes: Uint8Array;
	readonly revision: string;
	readonly modifiedAtMillis: number;
}

/** Browser files with atomic revision checks shared by every window on the same origin. */
export class IndexedDBFileSystemProvider extends Disposable implements IFileSystemProvider {
	private readonly changes = this._register(new Emitter<IFileChangeEvent>());
	public readonly onDidChangeFiles = this.changes.event;
	private readonly channel: BroadcastChannel;

	private constructor(private readonly database: IDBDatabase, private readonly scheme: string) {
		super();
		this.channel = new BroadcastChannel(database.name);
		this._register(addDisposableListener(this.channel, 'message', () => this.changes.fire({ resources: undefined })));
		this._register(toDisposable(() => { this.channel.close(); database.close(); }));
	}

	public static async create(factory: IDBFactory, scheme: string): Promise<IndexedDBFileSystemProvider> {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = factory.open('ash-user-data-files', 1);
			request.onupgradeneeded = () => request.result.createObjectStore('files');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		return new IndexedDBFileSystemProvider(database, scheme);
	}

	public async stat(resource: URI): Promise<IFileStat> {
		return this.access(false, entries => this.fileStat(resource, this.entry(entries, resource)));
	}

	public async readDirectory(resource: URI): Promise<readonly IFileEntry[]> {
		return this.access(false, entries => {
			if (this.entry(entries, resource).kind !== FileKind.Directory) {
				throw new TypeError('Expected a directory');
			}
			const prefix = this.key(resource).replace(/\/$/u, '') + '/';
			return [...entries].filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
				.map(([key, entry]) => ({ resource: URI.parse(key), name: key.slice(prefix.length), kind: entry.kind }));
		});
	}

	public async readFile(resource: URI): Promise<IFileContent> {
		const result = await this.readFileBytes(resource);
		return { resource, content: new TextDecoder('utf-8', { fatal: true }).decode(result.bytes), revision: result.revision };
	}

	public async readFileBytes(resource: URI): Promise<IFileBytes> {
		return this.access(false, entries => {
			const entry = this.entry(entries, resource);
			if (entry.kind !== FileKind.File) {
				throw new TypeError('Expected a file');
			}
			return { resource, bytes: entry.bytes, revision: entry.revision };
		});
	}

	public async writeFile(request: IFileWriteRequest): Promise<IFileWriteResult> {
		return this.write(request.resource, new TextEncoder().encode(request.content), request.expectedRevision);
	}

	public async writeFileBytes(resource: URI, bytes: Uint8Array): Promise<IFileWriteResult> {
		return this.write(resource, bytes, undefined, true);
	}

	public async createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat> {
		return this.access(true, entries => {
			const current = entries.get(this.key(resource));
			if (current && existing === 'error') {
				throw new Error('File already exists');
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
				throw new TypeError('A file occupies this directory');
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

	private async write(resource: URI, bytes: Uint8Array, expectedRevision?: string, exclusive = false): Promise<IFileWriteResult> {
		return this.access(true, entries => {
			const key = this.key(resource);
			const current = entries.get(key);
			if (expectedRevision !== undefined && current?.revision !== expectedRevision) {
				throw new FileRevisionConflictError(resource);
			}
			if (exclusive && current) {
				throw new Error('File already exists');
			}
			if (current?.kind === FileKind.Directory) {
				throw new TypeError('Expected a file');
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
					throw new Error('Target already exists');
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

	private access<T>(write: boolean, operation: (entries: Map<string, Entry>) => T): Promise<T> {
		this.assertNotDisposed();
		return new Promise<T>((resolve, reject) => {
			const transaction = this.database.transaction('files', write ? 'readwrite' : 'readonly');
			const store = transaction.objectStore('files');
			const keys = store.getAllKeys();
			const values = store.getAll();
			let result: T;
			let failure: unknown;
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
				} catch (error) { failure = error; transaction.abort(); }
			};
			transaction.oncomplete = () => {
				if (write && !this.isDisposed) { this.channel.postMessage(null); this.changes.fire({ resources: undefined }); }
				resolve(result);
			};
			transaction.onabort = transaction.onerror = () => reject(failure ?? transaction.error);
		});
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
				throw new TypeError('Parent is not a directory');
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
