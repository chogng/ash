import { CancellationTokenSource, type CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IAccountService } from '../../../../platform/accounts/common/accountService.js';
import {
	FileKind, FileSystemProviderCapabilities, FileSystemProviderError, FileSystemProviderErrorCode,
	type IFileBytes, type IFileEntry, type IFileStat, type IFileSystemProvider,
} from '../../../../platform/files/common/files.js';
import {
	GitHubError, GitHubErrorCode, GitHubRepositoryEntryKind, IGitHubService,
	type GitHubAccount, type GitHubRepository, type GitHubRepositoryTreeEntry,
} from '../../../../platform/github/common/githubService.js';
import { localize } from '../../../../nls.js';
import { GITHUB_REMOTE_FILE_SCHEME } from '../../../services/sessions/common/session.js';

interface RepositorySnapshot {
	readonly entries: ReadonlyMap<string, GitHubRepositoryTreeEntry>;
	readonly directories: ReadonlyMap<string, readonly string[]>;
}

/** Reads immutable Git blobs; cached metadata is scoped to the current account grant. */
export class GitHubFileSystemProvider extends Disposable implements IFileSystemProvider {
	public readonly capabilities = FileSystemProviderCapabilities.Readonly
		| FileSystemProviderCapabilities.FileReadWrite
		| FileSystemProviderCapabilities.PathCaseSensitive;
	public readonly onDidChangeCapabilities = Event.None;
	public readonly onDidChangeFiles = Event.None;
	private readonly snapshots = new Map<string, { readonly expires: number; readonly value: Promise<RepositorySnapshot>; }>();
	private readonly reads = new Set<CancellationTokenSource>();
	private generation = 0;
	private authorization: Promise<readonly GitHubAccount[]> | undefined;

	constructor(
		@IGitHubService private readonly github: IGitHubService,
		@IAccountService accounts: IAccountService,
	) {
		super();
		this._register(accounts.onDidChangeAccounts(() => this.clear()));
	}

	public watch(): IDisposable { return Disposable.None; }

	public stat(resource: URI): Promise<IFileStat> {
		return this.read(resource, async (_repository, _token, snapshot, path) => this.metadata(resource, this.entry(snapshot, path)));
	}

	public readDirectory(resource: URI): Promise<readonly IFileEntry[]> {
		return this.read(resource, async (_repository, _token, snapshot, path) => {
			if (this.entry(snapshot, path).kind !== GitHubRepositoryEntryKind.Directory) { throw this.error(FileSystemProviderErrorCode.FileNotADirectory); }
			return (snapshot.directories.get(path) ?? []).map(child => {
				const name = child.slice(child.lastIndexOf('/') + 1);
				const childResource = URI.joinPath(resource, name);
				return { resource: childResource, name, kind: this.metadata(childResource, this.entry(snapshot, child)).kind };
			});
		});
	}

	public readFile(resource: URI): Promise<IFileBytes> {
		return this.read(resource, async (repository, token, snapshot, path) => {
			const entry = this.entry(snapshot, path);
			if (entry.kind === GitHubRepositoryEntryKind.Directory || entry.kind === GitHubRepositoryEntryKind.Submodule) { throw this.error(FileSystemProviderErrorCode.FileIsADirectory); }
			if (entry.size > 5 * 1024 * 1024) { throw this.error(FileSystemProviderErrorCode.FileTooLarge); }
			const blob = await this.github.readRepositoryBlob(repository, entry.sha, token);
			return { resource, bytes: blob.bytes, revision: blob.sha };
		});
	}

	public async writeFile(): Promise<never> { return this.rejectWrite(); }
	public async createFile(): Promise<never> { return this.rejectWrite(); }
	public async createDirectory(): Promise<never> { return this.rejectWrite(); }
	public async copy(): Promise<never> { return this.rejectWrite(); }
	public async rename(): Promise<never> { return this.rejectWrite(); }
	public async delete(): Promise<never> { return this.rejectWrite(); }

	private async read<T>(
		resource: URI,
		operation: (repository: GitHubRepository, token: CancellationToken, snapshot: RepositorySnapshot, path: string) => Promise<T>,
	): Promise<T> {
		if (this.isDisposed) { throw new CancellationError(); }
		const parts = resource.path.replace(/\/$/, '').split('/').slice(1);
		const host = resource.authority === 'github' ? 'github.com' : resource.authority;
		if (resource.scheme !== GITHUB_REMOTE_FILE_SCHEME
			|| !/^[a-z0-9.-]+$/i.test(host)
			|| parts.length < 3
			|| parts.some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f]/.test(part))
			|| resource.fragment) {
			throw this.error(FileSystemProviderErrorCode.FileNotFound);
		}
		let decoded: string[];
		try { decoded = parts.slice(0, 3).map(decodeURIComponent); }
		catch { throw this.error(FileSystemProviderErrorCode.FileNotFound); }
		const [owner, name, reference] = decoded;
		if (!/^[a-z0-9_.-]+$/i.test(owner) || !/^[a-z0-9_.-]+$/i.test(name) || !reference) { throw this.error(FileSystemProviderErrorCode.FileNotFound); }
		const generation = this.generation;
		const source = new CancellationTokenSource();
		this.reads.add(source);
		try {
			// Account notifications retire this grant and its snapshots together. Reusing
			// the lookup avoids a backend round trip for every directory during search.
			const authorization = this.authorization ??= this.github.listAccounts(source.token);
			void authorization.catch(() => { if (this.authorization === authorization) { this.authorization = undefined; } });
			const accounts = await authorization;
			const accountId = new URLSearchParams(resource.query).get('account');
			const account = accounts.find(account => account.host === host && account.status === 'ready' && (!accountId || account.id === accountId));
			if (!account) { throw this.error(FileSystemProviderErrorCode.NoPermissions); }
			const repository = { host, owner, name, accountId: account.id };
			const key = JSON.stringify([host, owner, name, reference, account.id, account.credentialRevision.toString()]);
			let cached = this.snapshots.get(key);
			if (!cached || cached.expires <= Date.now()) {
				const value = this.snapshot(repository, reference, source.token);
				cached = { expires: Date.now() + 5 * 60_000, value };
				if (this.snapshots.size >= 32) { this.snapshots.delete(this.snapshots.keys().next().value!); }
				this.snapshots.set(key, cached);
				void value.catch(() => { if (this.snapshots.get(key)?.value === value) { this.snapshots.delete(key); } });
			}
			const snapshot = await cached.value;
			if (source.token.isCancellationRequested || generation !== this.generation) { throw new CancellationError(); }
			const result = await operation(repository, source.token, snapshot, parts.slice(3).join('/'));
			if (source.token.isCancellationRequested || generation !== this.generation) { throw new CancellationError(); }
			return result;
		} catch (error) {
			if (error instanceof GitHubError) {
				let code = FileSystemProviderErrorCode.Unavailable;
				switch (error.code) {
					case GitHubErrorCode.NotFound: code = FileSystemProviderErrorCode.FileNotFound; break;
					case GitHubErrorCode.AuthenticationRequired:
					case GitHubErrorCode.PermissionDenied: code = FileSystemProviderErrorCode.NoPermissions; break;
				}
				throw this.error(code);
			}
			throw error;
		} finally { this.reads.delete(source); source.dispose(); }
	}

	private async snapshot(repository: GitHubRepository, reference: string, token: CancellationToken): Promise<RepositorySnapshot> {
		const tree = await this.github.readRepositoryTree(repository, reference, token);
		const entries = new Map(tree.entries.map(entry => [entry.path, entry]));
		entries.set('', { path: '', kind: GitHubRepositoryEntryKind.Directory, sha: tree.sha, size: 0 });
		for (const entry of tree.entries) {
			let parent = entry.path;
			while (parent.includes('/')) {
				parent = parent.slice(0, parent.lastIndexOf('/'));
				if (entries.has(parent)) { break; }
				entries.set(parent, { path: parent, kind: GitHubRepositoryEntryKind.Directory, sha: tree.sha, size: 0 });
			}
		}
		const directories = new Map<string, string[]>();
		for (const path of entries.keys()) {
			if (!path) { continue; }
			const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
			const children = directories.get(parent) ?? [];
			children.push(path);
			directories.set(parent, children);
		}
		return { entries, directories };
	}

	private entry(snapshot: RepositorySnapshot, path: string): GitHubRepositoryTreeEntry {
		const entry = snapshot.entries.get(path);
		if (!entry) { throw this.error(FileSystemProviderErrorCode.FileNotFound); }
		return entry;
	}

	private metadata(resource: URI, entry: GitHubRepositoryTreeEntry): IFileStat {
		const kind = { file: FileKind.File, directory: FileKind.Directory, symbolicLink: FileKind.SymbolicLink, submodule: FileKind.Other }[entry.kind];
		return { resource, kind, sizeBytes: entry.size, readonly: true, modifiedAtMillis: undefined };
	}

	private error(code: FileSystemProviderErrorCode): FileSystemProviderError {
		let message: string;
		switch (code) {
			case FileSystemProviderErrorCode.NoPermissions:
				message = localize('github.files.accountRequired', 'Sign in to a GitHub account with access to this repository.'); break;
			case FileSystemProviderErrorCode.FileNotFound:
				message = localize('github.files.notFound', 'The GitHub repository, reference or file could not be found.'); break;
			case FileSystemProviderErrorCode.FileTooLarge:
				message = localize('github.files.tooLarge', 'This GitHub file exceeds the 5 MiB read limit.'); break;
			case FileSystemProviderErrorCode.FileIsADirectory:
				message = localize('github.files.isDirectory', 'The GitHub resource is a directory.'); break;
			case FileSystemProviderErrorCode.FileNotADirectory:
				message = localize('github.files.notDirectory', 'The GitHub resource is not a directory.'); break;
			default:
				message = localize('github.files.unavailable', 'The GitHub repository is unavailable. Try again.');
		}
		return new FileSystemProviderError(message, code);
	}

	private rejectWrite(): never {
		throw new FileSystemProviderError(localize('github.files.readOnly', 'GitHub repository files are read-only.'), FileSystemProviderErrorCode.NoPermissions);
	}

	private clear(): void {
		this.generation++;
		this.snapshots.clear();
		this.authorization = undefined;
		for (const source of this.reads) { source.cancel(); }
	}

	protected override disposeCore(): void {
		this.clear();
		super.disposeCore();
	}
}
