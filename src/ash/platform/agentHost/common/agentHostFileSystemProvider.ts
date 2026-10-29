import type { IFileReadOptions } from '../../files/common/files.js';
import { localize } from '../../../nls.js';
import { Schemas } from '../../../base/common/network.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { posix } from '../../../base/common/path.js';
import { createFileSystemProviderError, FileSystemProviderErrorCode } from '../../files/common/files.js';
import type { IResourceApi, ResourceMetadataResult, ResourceReadResult } from './appServerApi.js';
import { AppServerRemoteError } from './appServerError.js';
import { decodeBase64, encodeBase64, VSBuffer } from '../../../base/common/buffer.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { canceled } from '../../../base/common/errors.js';
import { raceCancellationError } from '../../../base/common/async.js';
import { listenStream, newWriteableStream, type ReadableStream } from '../../../base/common/stream.js';
import { URI } from '../../../base/common/uri.js';
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
	type IFileContent,
	type IFilePathIdentity,
	type IFileSystemProviderWithPathIdentity,
	type IFileSystemProviderWithCopyScope,
	type IFileSystemProviderCopyScope,
	type IFileChangeEvent,
	type IFileEntry,
	type IFileSystemProviderWithFileReadStreamCapability,
	type IFileReadStreamOptions,
	type IFileStat,
	type IFileWriteOptions,
	type IFileWriteResult,
	type IWatchOptions,
} from '../../files/common/files.js';
import { workspaceRelativePath, workspaceResourceFromPath } from '../../workspace/common/workspace.js';
import { dirname, extUri } from '../../../base/common/resources.js';
import type { IFileApi, IFileSystemDirectory } from '../../files/common/fileApi.js';
import type { ISystemFileTransferService } from '../../files/common/systemFileTransferService.js';
import type { IWorkspaceConfigurationFileApi } from '../../workspace/common/workspaceIpc.js';

type FileInvalidation = { readonly type: 'pathsChanged'; readonly dirId?: string; readonly paths: readonly string[]; }
	| { readonly type: 'rescanRequired'; readonly dirId?: string; };
type BinaryFile = Awaited<ReturnType<IFileApi['readBinaryFile']>>;
type PathSensitivity = Awaited<ReturnType<IFileApi['readPathCaseSensitivity']>>['scopes'][number]['sensitivity'];

interface AgentHostFileSystemProviderOptions {
	readonly configurationFiles?: IWorkspaceConfigurationFileApi;
	/** Current window-owned metadata file, independent of backend-authorized directory roots. */
	readonly configuration?: () => URI | undefined;
	readonly api: IFileApi;
	readonly resourceApi: IResourceApi;
	/** Environment roots known by the host, independent of the visible Explorer selection. */
	readonly directories?: () => readonly IFileSystemDirectory[];
	readonly onDidChange?: Event<FileInvalidation>;
}

/** One connection's existing file domains and authorized roots, independent of the active editor. */
export interface IRemoteFilesystemConnection {
	readonly api: IFileApi;
	readonly resourceApi: IResourceApi;
	readonly directories: () => readonly IFileSystemDirectory[];
	readonly onDidChange?: Event<FileInvalidation>;
}

interface AuthorityRoute {
	readonly cancellation: CancellationTokenSource;
	provider: AgentHostFileSystemProvider | undefined;
}

interface AuthorityRoot {
	readonly resource: URI;
	route: AuthorityRoute | undefined;
}

interface PathIdentityState {
	readonly folder: IFileSystemDirectory;
	readonly rules: Map<string, PathSensitivity>;
	readonly requests: Map<string, Promise<void>>;
	readonly retained: Map<string, { readonly resource: URI; users: number; }>;
	epoch: number;
}

const MAX_TRANSIENT_PATH_RULES = 4096;

/**
 * Routes resource URIs to backend-authorized directories independently of the visible Workspace.
 */
export class AgentHostFileSystemProvider extends Disposable implements IFileSystemProviderWithFileReadStreamCapability, IFileSystemProviderWithPathIdentity, IFileSystemProviderWithCopyScope, ISystemFileTransferService {
	// Unknown rules preserve spelling; confirmed rules are applied per directory below.
	public get capabilities(): FileSystemProviderCapabilities {
		const capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileReadStream
			| FileSystemProviderCapabilities.FileWriteElevated | FileSystemProviderCapabilities.FileWriteUnlock
			| FileSystemProviderCapabilities.PathCaseSensitive;
		// One namespace can address several connections. Its global capability must
		// not promise a native copy between roots owned by different backends.
		for (const entries of this.authorities.values()) {
			for (const entry of entries.values()) {
				if (entry.route) { return capabilities; }
			}
		}
		return capabilities | FileSystemProviderCapabilities.FileFolderCopy;
	}
	private readonly capabilityChanges = this._register(new Emitter<void>());
	public readonly onDidChangeCapabilities = this.capabilityChanges.event;
	private readonly identityChanges = this._register(new Emitter<void>());
	public readonly onDidChangePathIdentity = this.identityChanges.event;
	private readonly pathIdentities = new Map<string, PathIdentityState>();
	private readonly api: IFileApi;
	private readonly configurationFiles: IWorkspaceConfigurationFileApi | undefined;
	private readonly configuration: () => URI | undefined;
	private readonly resourceApi: IResourceApi;
	private readonly directories: () => readonly IFileSystemDirectory[];
	private readonly resolvedDirectories = new Map<string, IFileSystemDirectory>();
	private readonly directoryRequests = new Map<string, Promise<IFileSystemDirectory>>();
	private readonly fileChanges = this._register(new Emitter<IFileChangeEvent>());
	private readonly reads = this._register(new DisposableMap<object, DisposableStore>());
	private connectionEpoch = 0;
	private readonly authorities = new Map<string, Map<string, AuthorityRoot>>();
	private readonly authorityLifetimes = this._register(new DisposableStore());
	private readonly copyScopes = this._register(new DisposableStore());

	readonly onDidChangeFiles = this.fileChanges.event;

	constructor(options: AgentHostFileSystemProviderOptions) {
		super();
		this.api = options.api;
		this.configurationFiles = options.configurationFiles;
		this.configuration = options.configuration ?? (() => undefined);
		if (this.configurationFiles) this._register(this.configurationFiles.onDidChange(() => {
			const configuration = this.configuration();
			if (configuration) this.fileChanges.fire({ resources: [configuration] });
		}));
		this.resourceApi = options.resourceApi;
		this.directories = options.directories ?? (() => []);
		this._register(this.api.onDidChangeConnection(() => {
			this.connectionEpoch++;
			this.reads.clearAndDisposeAll();
			this.resolvedDirectories.clear();
			this.directoryRequests.clear();
			this.clearPathIdentity();
		}));
		this._register(toDisposable(() => { this.resetPathIdentities(); this.pathIdentities.clear(); this.resolvedDirectories.clear(); this.directoryRequests.clear(); }));
		if (options.onDidChange) this._register(options.onDidChange(change => this.acceptFileChange(change)));
	}

	/** Mounts roots on their originating connection; a retired root can never fall back to another host. */
	public registerAuthority(authority: string, connection: IRemoteFilesystemConnection): IDisposable {
		this.assertNotDisposed();
		const previousCapabilities = this.capabilities;
		const roots = connection.directories().map(directory => directory.uri);
		if (!authority || roots.length === 0 || roots.some(root => root.scheme !== Schemas.ashRemote || root.authority.toLowerCase() !== authority.toLowerCase())) {
			throw createFileSystemProviderError(localize('files.resourceAuthorityUnavailable', 'No filesystem route for the resource authority'), FileSystemProviderErrorCode.Unavailable);
		}
		const key = authority.toLowerCase();
		const entries = this.authorities.get(key) ?? new Map<string, AuthorityRoot>();
		for (const root of roots) {
			if (entries.get(extUri.getComparisonKey(root))?.route || this.directories().some(directory => extUri.isEqual(directory.uri, root))) {
				throw createFileSystemProviderError(localize('files.authorityRootRegistered', 'A filesystem connection already owns this resource root.'), FileSystemProviderErrorCode.Unavailable);
			}
		}
		const lifetime = new DisposableStore();
		const cancellation = lifetime.add(new CancellationTokenSource());
		const provider = lifetime.add(new AgentHostFileSystemProvider(connection));
		const route: AuthorityRoute = { cancellation, provider };
		this.authorities.set(key, entries);
		for (const root of roots) { entries.set(extUri.getComparisonKey(root), { resource: root, route }); }
		this.authorityLifetimes.add(lifetime);
		lifetime.add(toDisposable(() => {
			const previousCapabilities = this.capabilities;
			// Keep only the root identity after unmounting. Backend APIs and caches are released.
			// This blocks stale links even if the visible Workspace later projects the same URI.
			for (const entry of entries.values()) { if (entry.route === route) { entry.route = undefined; } }
			route.provider = undefined;
			cancellation.cancel();
			if (previousCapabilities !== this.capabilities) { this.capabilityChanges.fire(); }
			this.identityChanges.fire();
			this.fileChanges.fire({ resources: roots });
		}));
		lifetime.add(provider.onDidChangeFiles(event => {
			this.fileChanges.fire({ resources: event.resources ?? roots });
		}));
		lifetime.add(provider.onDidChangePathIdentity(() => this.identityChanges.fire()));
		if (previousCapabilities !== this.capabilities) { this.capabilityChanges.fire(); }
		this.identityChanges.fire();
		this.fileChanges.fire({ resources: roots });
		return toDisposable(() => { this.authorityLifetimes.delete(lifetime); lifetime.dispose(); });
	}

	private registeredRoute(resource: URI): AuthorityRoute | null | undefined {
		if (resource.scheme !== Schemas.ashRemote) { return undefined; }
		const entries = this.authorities.get(resource.authority.toLowerCase());
		if (!entries) { return undefined; }
		let length = -1;
		let selected: AuthorityRoute | null | undefined;
		for (const entry of entries.values()) {
			if (entry.resource.path.length >= length && extUri.isEqualOrParent(resource.with({ query: null, fragment: null }), entry.resource)) {
				length = entry.resource.path.length;
				selected = entry.route ?? null;
			}
		}
		if (length >= 0) { return selected; }
		return this.knownDirectory(resource) ? undefined : null;
	}

	private connectionRoute(resource: URI): AuthorityRoute | undefined {
		this.assertNotDisposed();
		const route = this.registeredRoute(resource);
		if (route === null) {
			throw createFileSystemProviderError(localize('files.resourceAuthorityUnavailable', 'No filesystem route for the resource authority'), FileSystemProviderErrorCode.Unavailable);
		}
		return route;
	}

	private async onRoute<T>(route: AuthorityRoute, operation: (provider: AgentHostFileSystemProvider) => Promise<T>): Promise<T> {
		const provider = route.provider;
		if (!provider) { throw canceled(); }
		const generation = provider.api.connectionGeneration;
		const epoch = provider.connectionEpoch;
		using cancellation = new CancellationTokenSource(route.cancellation.token);
		using changed = Event.once(provider.api.onDidChangeConnection)(() => cancellation.cancel());
		const result = await raceCancellationError(operation(provider), cancellation.token);
		if (provider.isDisposed || generation !== provider.api.connectionGeneration || epoch !== provider.connectionEpoch) { throw canceled(); }
		return result;
	}

	public acquireCopyScope(resource: URI): IFileSystemProviderCopyScope {
		const route = this.connectionRoute(resource);
		const provider = route ? route.provider : this;
		if (!provider) { throw canceled(); }
		const generation = provider.api.connectionGeneration;
		const epoch = provider.connectionEpoch;
		const lifetime = new DisposableStore();
		const cancellation = new CancellationTokenSource(route?.cancellation.token);
		lifetime.add(toDisposable(() => cancellation.dispose(true)));
		const token = cancellation.token;
		lifetime.add(Event.once(provider.api.onDidChangeConnection)(() => cancellation.cancel()));
		provider.copyScopes.add(lifetime);
		const assertCurrent = (uri: URI, operationToken: CancellationToken): void => {
			if (token.isCancellationRequested || operationToken.isCancellationRequested || this.isDisposed || provider.isDisposed || generation !== provider.api.connectionGeneration || epoch !== provider.connectionEpoch || this.connectionRoute(uri) !== route) { throw canceled(); }
			const entries = this.authorities.get(resource.authority.toLowerCase());
			// Recursive traversal and rollback cover descendants too. Crossing a nested
			// mount would access the parent backend beneath another connection's namespace.
			if (entries && [...entries.values()].some(entry => (extUri.isEqualOrParent(entry.resource, resource) || extUri.isEqualOrParent(entry.resource, uri)) && (!entry.route || entry.route !== route))) { throw canceled(); }
		};
		const run = async <T>(uri: URI, operation: (assertScope: () => void) => Promise<T>, operationToken: CancellationToken = CancellationToken.None): Promise<T> => {
			const assertScope = (): void => assertCurrent(uri, operationToken);
			assertScope();
			using pending = new CancellationTokenSource(token);
			using cancelled = operationToken.onCancellationRequested(() => pending.cancel());
			const result = await raceCancellationError(operation(assertScope), pending.token);
			assertScope();
			return result;
		};
		// The selected connection's execution methods bypass the mutable authority registry.
		// In particular, rollback cannot rediscover a newly mounted owner of the same URI.
		return Object.assign(toDisposable(() => { provider.copyScopes.delete(lifetime); lifetime.dispose(); }), {
			token,
			stat: (uri: URI, operationToken?: CancellationToken) => run(uri, check => provider.statOnConnection(uri, check), operationToken),
			readDirectory: (uri: URI, operationToken?: CancellationToken) => run(uri, check => provider.readDirectoryOnConnection(uri, check), operationToken),
			readFile: (uri: URI, operationToken?: CancellationToken) => run(uri, check => provider.readFileOnConnection(uri, check), operationToken),
			writeFile: (uri: URI, bytes: Uint8Array, options: IFileWriteOptions, operationToken?: CancellationToken) => run(uri, check => provider.writeContents(uri, bytes, undefined, options, undefined, check), operationToken),
			createDirectory: (uri: URI, operationToken?: CancellationToken) => run(uri, check => provider.createDirectoryOnConnection(uri, check), operationToken),
			rename: (source: URI, target: URI, existing: FileExistingTargetBehavior, operationToken?: CancellationToken) => run(source, check => {
				assertCurrent(target, operationToken ?? CancellationToken.None);
				return provider.renameOnConnection(source, target, existing, () => { check(); assertCurrent(target, operationToken ?? CancellationToken.None); });
			}, operationToken),
			delete: (uri: URI, missing: FileMissingTargetBehavior, mode: FileDeleteMode, operationToken?: CancellationToken) => run(uri, check => provider.deleteOnConnection(uri, missing, mode, check), operationToken),
		});
	}

	public getPathIdentity(resource: URI): IFilePathIdentity {
		const route = this.registeredRoute(resource);
		if (route) { return route.provider!.getPathIdentity(resource); }
		if (route === null) { return { comparisonResource: resource }; }
		const folder = this.knownDirectory(resource);
		return folder ? this.pathIdentity(resource, this.pathIdentityState(folder)) : { comparisonResource: resource };
	}

	public retainPathIdentity(resource: URI): IDisposable {
		const route = this.registeredRoute(resource);
		if (route) { return route.provider!.retainPathIdentity(resource); }
		if (route === null) { return Disposable.None; }
		this.assertNotDisposed();
		const folder = this.knownDirectory(resource);
		if (!folder) {
			return Disposable.None;
		}
		const state = this.pathIdentityState(folder);
		const key = resource.with({ query: null, fragment: null }).toString();
		let retained = state.retained.get(key);
		if (!retained) {
			retained = { resource, users: 0 };
			state.retained.set(key, retained);
		}
		retained.users++;
		return toDisposable(() => {
			if (--retained.users === 0) {
				state.retained.delete(key);
			}
			if (!this.isDisposed && this.trimPathRules(state)) {
				this.identityChanges.fire();
			}
		});
	}

	public async resolvePathIdentity(resource: URI): Promise<void> {
		const route = this.connectionRoute(resource);
		if (route) { return this.onRoute(route, provider => provider.resolvePathIdentity(resource)); }
		this.assertNotDisposed();
		if (this.isConfiguration(resource)) return;
		const generation = this.api.connectionGeneration;
		const directory = this.knownDirectory(resource) ?? await this.resolveDirectory(resource);
		if (this.isDisposed || generation !== this.api.connectionGeneration) { throw canceled(); }
		const target = this.directoryTarget(directory, resource);
		const state = this.pathIdentityState(directory);
		const existing = state.requests.get(target.path);
		if (existing) {
			return existing;
		}
		const epoch = state.epoch;
		const pending = (async (): Promise<void> => {
			const result = await this.api.readPathCaseSensitivity(target);
			if (this.isDisposed || generation !== this.api.connectionGeneration) { throw canceled(); }
			// A watcher invalidation retires these facts, not the caller's file operation.
			// Join a fresh observation before choosing an existing editor model.
			if (epoch !== state.epoch) { return this.resolvePathIdentity(resource); }
			const components = target.path === '.' ? [] : target.path.split('/');
			// Validate the complete observation before changing shared comparison facts.
			const observed = result.scopes.map((scope, index) => {
				const directory = scope.path === '.' ? state.folder.uri : workspaceResourceFromPath(state.folder.uri, scope.path);
				const path = directory ? workspaceRelativePath(state.folder.uri, directory) : undefined;
				const expected = index === 0 ? '.' : components.slice(0, index).join('/');
				if (!directory || path !== expected || index > components.length) {
					throw new Error(localize('files.invalidDirectoryScope', 'Filesystem casing scope is outside the authorized directory'));
				}
				return { scope, directory, path };
			});
			if (observed.length === 0) {
				throw new Error(localize('files.invalidDirectoryScope', 'Filesystem casing scope is outside the authorized directory'));
			}
			let changed = false;
			let invalidated = false;
			let covered = '.';
			for (const { scope, directory, path } of observed) {
				const rulePath = this.relativeComparisonPath(directory, state);
				if (state.rules.get(rulePath) !== scope.sensitivity) {
					if (state.rules.has(rulePath)) {
						invalidated = true;
					}
					// Descendant keys depend on their parents' lookup rules and cannot survive a changed parent.
					for (const path of state.rules.keys()) {
						if (path.startsWith(`${rulePath}/`)) {
							state.rules.delete(path);
							invalidated = true;
						}
					}
					changed = true;
				}
				state.rules.delete(rulePath);
				state.rules.set(rulePath, scope.sensitivity);
				covered = path;
			}
			// The first unconfirmed component also covers every former directory below it.
			const coveredLength = covered === '.' ? 0 : covered.split('/').length;
			if (coveredLength < components.length) {
				const unconfirmed = workspaceResourceFromPath(state.folder.uri, components.slice(0, coveredLength + 1).join('/'));
				if (!unconfirmed) {
					throw new Error(localize('files.invalidDirectoryScope', 'Filesystem casing scope is outside the authorized directory'));
				}
				const prefix = this.relativeComparisonPath(unconfirmed, state);
				for (const path of state.rules.keys()) {
					if (path === prefix || path.startsWith(`${prefix}/`)) {
						state.rules.delete(path);
						invalidated = true;
						changed = true;
					}
				}
			}
			if (invalidated) {
				state.requests.clear();
			}
			if (this.trimPathRules(state)) {
				changed = true;
			}
			if (changed) {
				this.identityChanges.fire();
			}
		})();
		state.requests.set(target.path, pending);
		if (state.requests.size > MAX_TRANSIENT_PATH_RULES) {
			state.requests.delete(state.requests.keys().next().value!);
		}
		try {
			await pending;
		} catch (error) {
			if (state.requests.get(target.path) === pending) {
				state.requests.delete(target.path);
			}
			throw error;
		}
	}

	private pathIdentityState(folder: IFileSystemDirectory): PathIdentityState {
		const key = JSON.stringify([folder.target, folder.uri.toString()]);
		let state = this.pathIdentities.get(key);
		if (!state) {
			state = { folder, rules: new Map(), requests: new Map(), retained: new Map(), epoch: 0 };
			this.pathIdentities.set(key, state);
		}
		return state;
	}

	private pathIdentity(resource: URI, state: PathIdentityState): IFilePathIdentity & { readonly rulePaths: readonly string[]; } {
		const root = state.folder.uri.toEncodedComponents().path.replace(/\/+$/u, '');
		const path = posix.normalize(resource.toEncodedComponents().path);
		const rootLength = root.split('/').filter(Boolean).length;
		const components = path.split('/').filter(Boolean);
		// A grant observes its children, not the spelling rules of ungranted ancestors.
		const prefix = rootLength ? `/${components.slice(0, rootLength).join('/')}` : '';
		const rulePaths: string[] = [];
		let compared = '';
		for (const segment of components.slice(rootLength)) {
			rulePaths.push(compared);
			const sensitivity = state.rules.get(compared);
			const name = decodeURIComponent(segment);
			// Sensitivity alone does not identify the filesystem's Unicode folding table.
			const folded = sensitivity === 'insensitive' ? name.replace(/[A-Z]/gu, letter => letter.toLowerCase()) : name;
			compared += `/${encodeURIComponent(folded)}`;
		}
		return { comparisonResource: resource.withEncodedPath(prefix + compared || '/'), rulePaths };
	}

	private relativeComparisonPath(resource: URI, state: PathIdentityState): string {
		const root = state.folder.uri.toEncodedComponents().path.replace(/\/+$/u, '');
		return this.pathIdentity(resource, state).comparisonResource.toEncodedComponents().path.slice(root.length);
	}

	private trimPathRules(state: PathIdentityState): boolean {
		if (state.rules.size <= MAX_TRANSIENT_PATH_RULES) {
			return false;
		}
		const retainedPaths = new Set<string>();
		for (const { resource } of state.retained.values()) {
			for (const path of this.pathIdentity(resource, state).rulePaths) {
				retainedPaths.add(path);
			}
		}
		let transientCount = [...state.rules.keys()].filter(path => !retainedPaths.has(path)).length;
		let changed = false;
		for (const path of state.rules.keys()) {
			if (transientCount <= MAX_TRANSIENT_PATH_RULES) {
				break;
			}
			if (!retainedPaths.has(path)) {
				state.rules.delete(path);
				transientCount--;
				changed = true;
			}
		}
		if (changed) {
			state.requests.clear();
		}
		return changed;
	}

	private resetPathIdentities(): void {
		for (const state of this.pathIdentities.values()) {
			state.epoch++;
			state.requests.clear();
			state.rules.clear();
		}
	}

	private clearPathIdentity(): void {
		this.resetPathIdentities();
		this.identityChanges.fire();
	}

	public watch(resource: URI, _options: IWatchOptions): IDisposable {
		const route = this.connectionRoute(resource);
		if (route) { return route.provider!.watch(resource, _options); }
		this.assertNotDisposed();
		// Rust owns continuous watches for authorized environment and Session roots, including Agent consumers.
		return Disposable.None;
	}

	async stat(resource: URI): Promise<IFileStat> {
		const route = this.connectionRoute(resource);
		if (route) { return this.onRoute(route, provider => provider.stat(resource)); }
		return this.statOnConnection(resource);
	}

	private async statOnConnection(resource: URI, assertScope?: () => void): Promise<IFileStat> {
		if (this.isConfiguration(resource)) return (await this.configurationFiles!.read(resource)).stat;
		let result;
		try { result = await this.onFileTarget(resource, target => this.api.getMetadata(target), assertScope); }
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
		const route = this.connectionRoute(resource);
		if (route) { return this.onRoute(route, provider => provider.readDirectory(resource)); }
		return this.readDirectoryOnConnection(resource);
	}

	private async readDirectoryOnConnection(resource: URI, assertScope?: () => void): Promise<readonly IFileEntry[]> {
		let result: Awaited<ReturnType<IFileApi['readDirectory']>>;
		try { result = await this.onFileTarget(resource, target => this.api.readDirectory(target), assertScope); }
		catch (error) { if (isFileNotFound(error)) throw new FileNotFoundError(resource); throw error; }
		return result.entries.map((entry) => ({
			resource: resource.joinPathSegment(entry.name),
			name: entry.name,
			kind: fileKind(entry.fileType),
		}));
	}

	async readFile(resource: URI): Promise<IFileBytes> {
		const route = this.connectionRoute(resource);
		if (route) { return this.onRoute(route, provider => provider.readFile(resource)); }
		return this.readFileOnConnection(resource);
	}

	private async readFileOnConnection(resource: URI, assertScope?: () => void): Promise<IFileBytes> {
		if (this.isConfiguration(resource)) return this.configurationFiles!.read(resource);
		const generation = this.resourceApi.connectionGeneration;
		const epoch = this.connectionEpoch;
		let result: BinaryFile;
		try {
			const target = await this.fileTarget(resource);
			this.assertResourceConnection(generation, epoch);
			assertScope?.();
			result = await this.api.readBinaryFile(target);
		}
		catch (error) { if (isFileNotFound(error)) throw new FileNotFoundError(resource); throw error; }
		try {
			this.assertResourceConnection(generation, epoch);
			const bytes = await this.readResourceBytes(result.resource, generation, epoch);
			this.assertResourceConnection(generation, epoch);
			return Object.freeze({ resource, bytes, revision: result.revision });
		} finally {
			// Closing a backend connection releases its resources. Opaque IDs from
			// that lease must never be sent through a replacement connection.
			try {
				if (this.isCurrentResourceConnection(generation, epoch)) {
					await this.resourceApi.release({ resourceId: result.resource.resourceId });
				}
			} finally {
				// Release is asynchronous too; its obsolete result cannot complete the read.
				this.assertResourceConnection(generation, epoch);
			}
		}
	}

	async readTextFile(resource: URI, encoding: string, options?: IFileReadOptions): Promise<IFileContent> {
		const route = this.connectionRoute(resource);
		if (route) { return this.onRoute(route, provider => provider.readTextFile(resource, encoding, options)); }
		if (this.isConfiguration(resource)) {
			const file = await this.configurationFiles!.read(resource);
			return { resource, content: new TextDecoder().decode(file.bytes), revision: file.revision, encoding: 'utf8' };
		}
		try {
			const result = await this.onFileTarget(resource, target => this.api.readFile({ ...target, encoding, ...options }));
			return { resource, content: result.content, revision: result.revision, ...(result.encoding === undefined ? {} : { encoding: result.encoding }) };
		} catch (error) {
			if (isFileNotFound(error)) throw new FileNotFoundError(resource);
			if (error instanceof AppServerRemoteError && error.errorName === 'FileSystemInvalidText') throw createFileSystemProviderError(localize('files.invalidTextEncoding', 'The file is not text in the selected encoding.'), FileSystemProviderErrorCode.FileNotText);
			throw error;
		}
	}

	public readFileStream(resource: URI, options: IFileReadStreamOptions, token: CancellationToken): ReadableStream<Uint8Array> {
		const route = this.connectionRoute(resource);
		if (route) {
			const lifetime = new DisposableStore();
			const cancellation = new CancellationTokenSource(token);
			lifetime.add(toDisposable(() => cancellation.dispose(true)));
			lifetime.add(route.cancellation.token.onCancellationRequested(() => cancellation.cancel()));
			lifetime.add(Event.once(route.provider!.api.onDidChangeConnection)(() => cancellation.cancel()));
			const stream = newWriteableStream<Uint8Array>(null, { highWaterMark: 1 });
			try {
				const source = route.provider!.readFileStream(resource, options, cancellation.token);
				const destroy = stream.destroy;
				stream.destroy = (): void => { lifetime.dispose(); source.destroy(); destroy(); };
				// Report retirement immediately while the original reader keeps ownership of
				// any late allocation response and releases its opaque resource on that connection.
				listenStream(source, {
					onData: chunk => {
						const drained = stream.write(chunk);
						if (drained) {
							source.pause();
							void drained.then(() => { if (!cancellation.token.isCancellationRequested) { source.resume(); } });
						}
					},
					onError: error => { stream.error(error); stream.end(); lifetime.dispose(); },
					onEnd: () => { stream.end(); lifetime.dispose(); },
				}, cancellation.token);
				return stream;
			} catch (error) {
				lifetime.dispose();
				stream.destroy();
				throw error;
			}
		}
		this.assertNotDisposed();
		if (this.isConfiguration(resource)) {
			const stream = newWriteableStream<Uint8Array>(null);
			void this.readFile(resource).then(file => {
				if (token.isCancellationRequested) throw canceled();
				stream.end(file.bytes.slice(options.position ?? 0, options.length === undefined ? undefined : (options.position ?? 0) + options.length));
			}).catch(error => { stream.error(error); stream.end(); });
			return stream;
		}
		const stream = newWriteableStream<Uint8Array>(null, { highWaterMark: 1 });
		const generation = this.resourceApi.connectionGeneration;
		const epoch = this.connectionEpoch;
		const lifetime = new DisposableStore();
		this.reads.set(lifetime, lifetime);
		const cancellation = new CancellationTokenSource(token);
		lifetime.add(toDisposable(() => cancellation.dispose(true)));
		const destroy = stream.destroy;
		stream.destroy = (): void => { this.reads.deleteAndDispose(lifetime); destroy(); };
		void (async () => {
			let snapshot: BinaryFile | undefined;
			try {
				if (cancellation.token.isCancellationRequested) { throw canceled(); }
				// The allocation request has no backend cancel method; retain its late response so it can be released.
				const known = this.knownDirectory(resource);
				const target = known ? this.directoryTarget(known, resource) : await this.fileTarget(resource);
				if (cancellation.token.isCancellationRequested) { throw canceled(); }
				this.assertResourceConnection(generation, epoch);
				snapshot = await this.api.readBinaryFile(target);
				this.assertResourceConnection(generation, epoch);
				for await (const chunk of this.resourceChunks(snapshot.resource, options, cancellation.token, generation, epoch)) {
					await raceCancellationError(Promise.resolve(stream.write(chunk)), cancellation.token);
				}
			} catch (error) {
				stream.error(isFileNotFound(error) ? new FileNotFoundError(resource) : error instanceof Error ? error : new Error(String(error)));
			} finally {
				if (snapshot && this.isCurrentResourceConnection(generation, epoch)) {
					try {
						await this.resourceApi.release({ resourceId: snapshot.resource.resourceId });
						if (cancellation.token.isCancellationRequested) { throw canceled(); }
						this.assertResourceConnection(generation, epoch);
					} catch (error) {
						if (cancellation.token.isCancellationRequested || !this.isCurrentResourceConnection(generation, epoch)) {
							stream.error(canceled());
						} else {
							stream.error(error instanceof Error ? error : new Error(String(error)));
						}
					}
				}
				this.reads.deleteAndDispose(lifetime);
				stream.end();
			}
		})();
		return stream;
	}

	async writeFile(resource: URI, content: Uint8Array, options: IFileWriteOptions, signal?: AbortSignal): Promise<IFileWriteResult> {
		const route = this.connectionRoute(resource);
		if (route) { return this.onRoute(route, provider => provider.writeFile(resource, content, options, signal)); }
		return this.writeContents(resource, content, undefined, options, signal);
	}

	async writeTextFile(resource: URI, content: string, encoding: string, options: IFileWriteOptions, signal?: AbortSignal): Promise<IFileWriteResult> {
		const route = this.connectionRoute(resource);
		if (route) { return this.onRoute(route, provider => provider.writeTextFile(resource, content, encoding, options, signal)); }
		return this.writeContents(resource, content, encoding, options, signal);
	}

	private async writeContents(resource: URI, content: string | Uint8Array, encoding: string | undefined, options: IFileWriteOptions, signal?: AbortSignal, assertScope?: () => void): Promise<IFileWriteResult> {
		if (this.isConfiguration(resource)) {
			if (signal?.aborted) throw canceled();
			return this.configurationFiles!.write(resource, typeof content === 'string' ? new TextEncoder().encode(content) : content, options);
		}
		let mode: NonNullable<Parameters<IFileApi['writeFile']>[0]['options']>['mode'];
		if (options.create) mode = options.overwrite ? 'createOrReplace' : 'create';
		else if (options.overwrite) mode = 'replace';
		else throw new FileOperationNotSupportedError(resource, 'writeFile');
		// The privileged contract binds replacement to a revision and creation to absence.
		// Other provider modes need their own backend conditions before they can be exposed.
		if (options.writeElevated && mode !== 'createOrReplace') {
			throw new FileOperationNotSupportedError(resource, 'writeFileElevated');
		}
		try {
			const result = await this.onFileTarget(resource, target => options.writeElevated
				? this.api.writeFileElevated({ ...target, operationId: generateUuid(), dataBase64: encodeBinaryFile(typeof content === 'string' ? new TextEncoder().encode(content) : content), ...(encoding === undefined ? {} : { encoding }), ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }) }, signal)
				: typeof content === 'string'
					? this.api.writeFile({ ...target, content, ...(encoding === undefined ? {} : { encoding }), options: { mode, ...(options.unlock ? { unlock: true } : {}), ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }) } })
					: this.api.writeBinaryFile({
						...target,
						dataBase64: encodeBinaryFile(content),
						options: { mode, ...(options.unlock ? { unlock: true } : {}), ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }) },
					}), assertScope);
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
			if (error instanceof AppServerRemoteError && error.errorName === 'FileSystemEncodingUnmappable') throw createFileSystemProviderError(localize('files.encodingUnmappable', 'The selected encoding cannot represent all characters. Your changes remain unsaved.'), FileSystemProviderErrorCode.Unavailable);
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
		const route = this.connectionRoute(resource);
		if (route) { return this.onRoute(route, provider => provider.createFile(resource, existing)); }
		const result = await this.onFileTarget(resource, target => this.api.createFile({ ...target, existing }));
		return { resource, kind: fileKind(result.fileType), sizeBytes: result.sizeBytes, readonly: result.readonly, modifiedAtMillis: result.modifiedAtMillis ?? undefined };
	}

	async createDirectory(resource: URI): Promise<IFileStat> {
		const route = this.connectionRoute(resource);
		if (route) { return this.onRoute(route, provider => provider.createDirectory(resource)); }
		return this.createDirectoryOnConnection(resource);
	}

	private async createDirectoryOnConnection(resource: URI, assertScope?: () => void): Promise<IFileStat> {
		const configuration = this.configuration();
		if (this.configurationFiles && configuration && dirname(configuration).toString() === resource.toString()) {
			// The metadata host already created this directory. This does not grant
			// browsing or mutation rights to other files beside the workspace file.
			return { resource, kind: FileKind.Directory, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined };
		}
		const result = await this.onFileTarget(resource, target => this.api.createDirectory(target), assertScope);
		return { resource, kind: fileKind(result.fileType), sizeBytes: result.sizeBytes, readonly: result.readonly, modifiedAtMillis: result.modifiedAtMillis ?? undefined };
	}

	async copy(source: URI, target: URI): Promise<void> {
		const generation = this.api.connectionGeneration;
		const epoch = this.connectionEpoch;
		const route = this.connectionRoute(source);
		if (route !== this.connectionRoute(target)) { throw new FileOperationNotSupportedError(source, 'copy'); }
		if (route) { return this.onRoute(route, provider => provider.copy(source, target)); }
		const from = await this.fileTarget(source);
		const to = await this.fileTarget(target);
		if (this.isDisposed || generation !== this.api.connectionGeneration || epoch !== this.connectionEpoch) { throw canceled(); }
		if (from.sessionDirectory || to.sessionDirectory) {
			if (JSON.stringify(from.sessionDirectory) !== JSON.stringify(to.sessionDirectory)) {
				throw new Error('Copying between Session directories is not supported.');
			}
			return this.api.copy({ sessionDirectory: from.sessionDirectory, source: from.path, target: to.path });
		}
		return this.api.copy({ sourceDirId: from.dirId, source: from.path, targetDirId: to.dirId, target: to.path });
	}

	async pasteSystemFiles(directory: URI, moveRequested: boolean): Promise<boolean> {
		const route = this.connectionRoute(directory);
		if (route) { return this.onRoute(route, provider => provider.pasteSystemFiles(directory, moveRequested)); }
		return this.onFileTarget(directory, target => this.api.pasteSystemFiles({ ...target, moveRequested }));
	}

	async rename(source: URI, target: URI, existing: FileExistingTargetBehavior): Promise<void> {
		const generation = this.api.connectionGeneration;
		const epoch = this.connectionEpoch;
		const route = this.connectionRoute(source);
		if (route !== this.connectionRoute(target)) { throw new FileOperationNotSupportedError(source, 'rename'); }
		if (route) { return this.onRoute(route, provider => provider.rename(source, target, existing)); }
		return this.renameOnConnection(source, target, existing, () => {
			if (this.isDisposed || generation !== this.api.connectionGeneration || epoch !== this.connectionEpoch) { throw canceled(); }
		});
	}

	private async renameOnConnection(source: URI, target: URI, existing: FileExistingTargetBehavior, assertScope: () => void): Promise<void> {
		const sourceDirectory = await this.resolveDirectory(source);
		const targetDirectory = await this.resolveDirectory(target);
		assertScope();
		if (JSON.stringify(sourceDirectory.target) !== JSON.stringify(targetDirectory.target)) {
			throw new Error(localize('files.crossDirectoryRename', 'Renaming across authorized directories is not supported'));
		}
		const { path, ...selector } = this.directoryTarget(sourceDirectory, source);
		return this.api.rename({ ...selector, source: path, target: workspaceRelativePath(targetDirectory.uri, target), existing });
	}

	async delete(resource: URI, missing: FileMissingTargetBehavior, mode: FileDeleteMode): Promise<void> {
		const route = this.connectionRoute(resource);
		if (route) { return this.onRoute(route, provider => provider.delete(resource, missing, mode)); }
		return this.deleteOnConnection(resource, missing, mode);
	}

	private deleteOnConnection(resource: URI, missing: FileMissingTargetBehavior, mode: FileDeleteMode, assertScope?: () => void): Promise<void> {
		return this.onFileTarget(resource, target => this.api.delete({ ...target, missing, mode }), assertScope);
	}

	private knownDirectory(resource: URI): IFileSystemDirectory | undefined {
		return [...this.directories(), ...this.resolvedDirectories.values()]
			.filter(directory => extUri.isEqualOrParent(resource.with({ query: null, fragment: null }), directory.uri))
			.sort((a, b) => b.uri.path.length - a.uri.path.length)[0];
	}

	private async resolveDirectory(resource: URI): Promise<IFileSystemDirectory> {
		this.assertNotDisposed();
		const known = this.knownDirectory(resource);
		if (known) { return known; }
		// A remote URI must belong to this provider's host authority, not merely have a
		// path that also exists on the connected server. Local file URIs use this host.
		if ((resource.scheme !== 'file' || resource.authority) && !this.directories().some(directory => directory.uri.scheme === resource.scheme && directory.uri.authority === resource.authority)) {
			throw new Error(localize('files.resourceAuthorityUnavailable', 'No filesystem route for the resource authority'));
		}
		const key = resource.with({ query: null, fragment: null }).toString();
		const existing = this.directoryRequests.get(key);
		if (existing) { return existing; }
		const generation = this.api.connectionGeneration;
		const pending = this.api.resolvePath(resource).then(directory => {
			if (this.isDisposed || generation !== this.api.connectionGeneration) { throw canceled(); }
			// A server response cannot alias another scheme/authority or escape its requested URI.
			if (!extUri.isEqualOrParent(resource.with({ query: null, fragment: null }), directory.uri)) {
				throw new Error(localize('files.invalidResourceDirectory', 'Filesystem directory does not contain the requested resource'));
			}
			this.resolvedDirectories.set(directory.uri.toString(), directory);
			return directory;
		}).finally(() => {
			if (this.directoryRequests.get(key) === pending) { this.directoryRequests.delete(key); }
		});
		this.directoryRequests.set(key, pending);
		return pending;
	}

	private async onFileTarget<T>(resource: URI, operation: (target: ReturnType<AgentHostFileSystemProvider['directoryTarget']>) => Promise<T>, assertScope?: () => void): Promise<T> {
		const generation = this.api.connectionGeneration;
		const epoch = this.connectionEpoch;
		const target = await this.fileTarget(resource);
		// Resolving even a known root yields to the caller. Retiring its mount or
		// connection during that await must prevent dispatch, especially for writes.
		if (this.isDisposed || generation !== this.api.connectionGeneration || epoch !== this.connectionEpoch) { throw canceled(); }
		assertScope?.();
		return operation(target);
	}

	private async fileTarget(resource: URI) {
		return this.directoryTarget(await this.resolveDirectory(resource), resource);
	}

	private directoryTarget(directory: IFileSystemDirectory, resource: URI): { dirId?: string; sessionDirectory?: { sessionId: string; path: string; }; path: string; } {
		const target = directory.target;
		return {
			...(target.type === 'environment' ? { dirId: target.dirId } : { sessionDirectory: { sessionId: target.sessionId, path: target.path } }),
			path: workspaceRelativePath(directory.uri, resource),
		};
	}

	private isConfiguration(resource: URI): boolean {
		return this.configurationFiles !== undefined && this.configuration()?.toString() === resource.toString();
	}

	private isCurrentResourceConnection(generation: number, epoch: number): boolean {
		return generation === this.resourceApi.connectionGeneration && epoch === this.connectionEpoch;
	}

	private assertResourceConnection(generation: number, epoch: number): void {
		if (this.isDisposed || !this.isCurrentResourceConnection(generation, epoch)) { throw canceled(); }
	}

	private async readResourceBytes(resource: ResourceMetadataResult, generation: number, epoch: number): Promise<Uint8Array> {
		if (!Number.isSafeInteger(resource.size) || resource.size < 0 || resource.size > MAX_FILE_READ_BYTES) {
			throw new Error('Workspace binary resource size is invalid');
		}
		const bytes = new Uint8Array(resource.size);
		let offset = 0;
		for await (const chunk of this.resourceChunks(resource, {}, CancellationToken.None, generation, epoch)) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	}

	private async *resourceChunks(resource: ResourceMetadataResult, options: IFileReadStreamOptions, token: CancellationToken, generation: number, epoch: number): AsyncIterable<Uint8Array> {
		if (!Number.isSafeInteger(resource.size) || resource.size < 0 || resource.size > MAX_FILE_READ_BYTES) {
			throw new Error('Workspace binary resource size is invalid');
		}
		if (options.limits?.size !== undefined && resource.size > options.limits.size) { throw new Error('File exceeds the read size limit'); }
		let offset = options.position ?? 0;
		const end = Math.min(resource.size, options.length === undefined ? resource.size : offset + options.length);
		while (offset < end) {
			if (token.isCancellationRequested) { throw canceled(); }
			this.assertResourceConnection(generation, epoch);
			const maxBytes = Math.min(MAX_RESOURCE_READ_BYTES, end - offset);
			const chunk = await this.resourceApi.read({
				resourceId: resource.resourceId,
				offset,
				maxBytes,
			});
			if (token.isCancellationRequested) { throw canceled(); }
			this.assertResourceConnection(generation, epoch);
			const chunkBytes = decodeResourceChunk(chunk, resource.resourceId, offset, resource.size);
			if (chunkBytes.byteLength > maxBytes) { throw new Error('Workspace binary resource response exceeds the requested range'); }
			offset += chunkBytes.byteLength;
			yield chunkBytes;
		}
		if (token.isCancellationRequested) { throw canceled(); }
	}

	private acceptFileChange(change: FileInvalidation): void {
		// File events retire earlier observations without discarding facts held by open documents.
		const folders = [...this.directories(), ...this.resolvedDirectories.values()];
		const matches = (folder: IFileSystemDirectory): boolean => folder.target.type === 'environment' && folder.target.dirId === change.dirId;
		const knownRoot = folders.some(matches);
		for (const state of this.pathIdentities.values()) {
			if (!knownRoot || matches(state.folder)) {
				state.epoch++;
				state.requests.clear();
			}
		}
		if (change.type === 'rescanRequired') {
			this.fileChanges.fire(Object.freeze({ resources: undefined }));
			return;
		}
		const folder = change.dirId
			? folders.find(matches)
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
	return error instanceof AppServerRemoteError && error.errorName === 'FileSystemRevisionConflict';
}

function isFileNotFound(error: unknown): boolean {
	return error instanceof AppServerRemoteError && error.errorName === 'FileSystemNotFound';
}

const MAX_RESOURCE_READ_BYTES = 262_144;
// Both backend file-read endpoints accept this limit; preview panes apply their own smaller bounds.
const MAX_FILE_READ_BYTES = 50 * 1024 * 1024;

function encodeBinaryFile(bytes: Uint8Array): string {
	return encodeBase64(VSBuffer.wrap(bytes.slice()));
}

function decodeResourceChunk(chunk: ResourceReadResult, resourceId: string, expectedOffset: number, totalSize: number): Uint8Array {
	if (chunk.resourceId !== resourceId || chunk.offset !== expectedOffset) {
		throw new Error('Workspace binary resource response is inconsistent');
	}
	const bytes = decodeBase64(chunk.dataBase64).buffer;
	if (chunk.decodedLength !== bytes.byteLength || bytes.byteLength === 0 || bytes.byteLength > totalSize - expectedOffset || chunk.eof !== (expectedOffset + bytes.byteLength === totalSize)) {
		throw new Error('Workspace binary resource response is inconsistent');
	}
	return bytes;
}

function fileKind(fileType: Awaited<ReturnType<IFileApi['getMetadata']>>['fileType']): FileKind {
	switch (fileType) {
		case 'directory':
			return FileKind.Directory;
		case 'file':
			return FileKind.File;
		case 'symbolicLink':
			return FileKind.SymbolicLink;
		case 'other':
			return FileKind.Other;
	}
}
