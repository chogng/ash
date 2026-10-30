import { IAppServerApi } from '../../../../platform/agentHost/common/appServerApi.js';
import { Emitter } from '../../../../base/common/event.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { CancellationError, getErrorMessage } from '../../../../base/common/errors.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ASH_REMOTE_SCHEME, getRemoteWorkspacePath, isRemoteResource } from '../../../../platform/remote/common/remote.js';
import { IWorkspaceContextService, getWorkspaceRemoteAuthority } from '../../../../platform/workspace/common/workspace.js';
import {
	DEVELOPMENT_DIR_PERMISSIONS,
	IWorkspaceTrustApi,
	IWorkspaceTrustManagementService,
	IWorkspaceTrustRequestService,
	READ_DIR_PERMISSIONS,
	type IWorkspaceTrustInfo,
	type IWorkspaceTrustTransitionParticipant,
	type IWorkspaceTrustUriInfo,
	type WorkspaceTrustPermission,
	type WorkspaceTrustRequestOptions,
} from '../../../../platform/workspace/common/workspaceTrust.js';
import { IRemoteAuthorityResolverService } from '../../../../platform/remote/common/remoteAuthorityResolver.js';

/** Projects Rust's effective directory capabilities into the window's trust lifecycle. */
export class WorkspaceTrustManagementService extends Disposable implements IWorkspaceTrustManagementService {
	private readonly change = this._register(new Emitter<boolean>());
	public readonly onDidChangeTrust = this.change.event;
	private readonly foldersChanged = this._register(new Emitter<void>());
	public readonly onDidChangeTrustedFolders = this.foldersChanged.event;
	private readonly resolved = new DeferredPromise<void>();
	public readonly workspaceResolved = this.resolved.p;
	private readonly initialized = new DeferredPromise<void>();
	public readonly workspaceTrustInitialized = this.initialized.p;
	private readonly participants = new Set<{ readonly participant: IWorkspaceTrustTransitionParticipant; }>();
	private projection: IWorkspaceTrustInfo | undefined;
	private publishedTrust = false;
	private refreshQueue = Promise.resolve();
	private mutationQueue = Promise.resolve();
	private permissionChange: DeferredPromise<void> | undefined;
	private generation = 0;
	private sourceGeneration = 0;

	constructor(
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IWorkspaceTrustApi private readonly trust: IWorkspaceTrustApi,
		@IRemoteAuthorityResolverService private readonly resolver: IRemoteAuthorityResolverService,
		@IAppServerApi private readonly api: IAppServerApi,
	) {
		super();
		this._register(workspace.onDidChangeWorkspace(() => this.invalidateTrust()));
		this._register(trust.onDidChangeTrust(() => this.invalidateTrust()));
		this._register(resolver.onDidChangeConnectionData(() => { this.sourceGeneration++; this.invalidateTrust(); }));
		const connection = api.onConnectionState(() => this.invalidateTrust());
		this._register(toDisposable(() => connection.dispose()));
		if (api.recovery) this._register(api.recovery.onDidChange(() => this.invalidateTrust()));
		void this.resolveWorkspaceTrust().catch(error => console.error('Workspace trust initialization failed', error));
	}

	public isWorkspaceTrusted(): boolean { return this.projection?.isTrusted ?? false; }

	public canSetWorkspaceTrust(): boolean {
		return !this.isDisposed && !!this.api.recovery && this.api.recovery.status === 'idle'
			&& this.workspace.getWorkspace().folders.length > 0;
	}

	public resolveWorkspaceTrust(): Promise<void> {
		if (this.permissionChange) return this.permissionChange.p.then(() => this.resolveWorkspaceTrust());
		const generation = this.generation;
		const operation = this.refreshQueue.then(async () => {
			if (!this.current(generation)) return;
			const state = await this.api.getConnectionState();
			if (!this.current(generation)) return;
			if (state !== 'ready' || this.api.recovery && this.api.recovery.status !== 'idle') {
				// Transient startup/recovery must not release consumers before directories are bound.
				if (this.api.recovery?.status === 'failed' || this.api.recovery?.status === 'unavailable'
					|| (!this.api.recovery || this.api.recovery.status === 'idle') && (state === 'stopped' || state === 'crashed')) this.finishInitialization();
				return;
			}
			const info = await this.getWorkspaceTrustInfo();
			if (!this.current(generation)) return;
			void this.resolved.complete();
			this.projection = info;
			const trusted = this.isWorkspaceTrusted();
			if (trusted !== this.publishedTrust) {
				for (const entry of [...this.participants]) {
					if (!this.current(generation)) return;
					if (this.participants.has(entry)) await entry.participant.participate(trusted);
				}
				if (!this.current(generation)) return;
				this.publishedTrust = trusted;
				this.change.fire(trusted);
			}
			void this.initialized.complete();
		});
		// Keep subsequent refreshes usable after a failed participant or backend read.
		this.refreshQueue = operation.catch(() => {
			if (this.current(generation)) { this.projection = undefined; this.finishInitialization(); }
		});
		return operation.then(() => {
			// A superseded read is not completion of the caller's request to resolve current trust.
			if (!this.isDisposed && (generation !== this.generation || this.permissionChange)) return this.resolveWorkspaceTrust();
		});
	}

	public addWorkspaceTrustTransitionParticipant(participant: IWorkspaceTrustTransitionParticipant): IDisposable {
		this.assertNotDisposed();
		const entry = { participant };
		this.participants.add(entry);
		return toDisposable(() => this.participants.delete(entry));
	}

	public setWorkspaceTrust(trusted: boolean): Promise<void> {
		return this.setUrisTrust(this.workspace.getWorkspace().folders.map(folder => folder.uri), trusted);
	}

	public setUrisTrust(uris: URI[], trusted: boolean, expectedRevision?: number): Promise<void> {
		const workspace = this.workspace.getWorkspace();
		const connectionGeneration = this.api.connectionGeneration;
		const sourceGeneration = this.sourceGeneration;
		const assertTarget = (): void => {
			if (this.isDisposed || this.workspace.getWorkspace() !== workspace || this.api.connectionGeneration !== connectionGeneration
				|| this.sourceGeneration !== sourceGeneration) throw new CancellationError();
		};
		const operation = this.mutationQueue.then(async () => {
			await this.workspaceTrustInitialized;
			assertTarget();
			if (!this.canSetWorkspaceTrust()) throw new Error(localize('workspaceTrust.hostOnly', 'Directory permissions can only be changed by an authorized desktop host.'));
			const paths = new Set<string>();
			for (const uri of uris) {
				const remote = isRemoteResource(uri);
				const authority = getWorkspaceRemoteAuthority(workspace);
				if (remote ? uri.authority !== authority : uri.scheme !== 'file' || !!authority) throw new Error(localize('workspaceTrust.unsupported', 'This host cannot manage directory permissions for this workspace.'));
				const canonical = remote && this.resolver.getConnectionData(uri.authority) ? await this.resolver.getCanonicalURI(uri) : uri;
				assertTarget();
				if (canonical.scheme !== uri.scheme || canonical.authority !== uri.authority) throw new Error(localize('workspaceTrust.unsupported', 'This host cannot manage directory permissions for this workspace.'));
				paths.add(remote ? getRemoteWorkspacePath(canonical.with({ query: null, fragment: null })) : canonical.fsPath);
			}
			if (!paths.size) return;
			const snapshot = await this.trust.listDirectories();
			assertTarget();
			if (expectedRevision !== undefined && snapshot.revision !== expectedRevision) throw new Error(localize('workspaceTrust.revisionChanged', 'Directory grants changed. Refresh before saving.'));
			let revision = snapshot.revision;
			let written = false;
			const permissionChange = this.permissionChange = new DeferredPromise<void>();
			try {
				try {
					for (const path of paths) {
						assertTarget();
						const result = await this.trust.setDirectoryPermissions(path, trusted ? DEVELOPMENT_DIR_PERMISSIONS : READ_DIR_PERMISSIONS, revision);
						written = true;
						revision = result.revision;
					}
				} finally {
					// Even a partially saved multi-root change must be reflected in the active environment.
					if (written) { assertTarget(); await this.api.recovery!.reconnect(); }
				}
			} finally {
				this.permissionChange = undefined;
				void permissionChange.complete();
				if (!this.isDisposed && this.workspace.getWorkspace() === workspace) await this.resolveWorkspaceTrust();
			}
		});
		this.mutationQueue = operation.catch(() => undefined);
		return operation;
	}

	public async getUriTrustInfo(uri: URI): Promise<IWorkspaceTrustUriInfo> {
		const generation = this.generation;
		const folder = this.workspace.getWorkspace().folders.find(folder => folder.uri.toString() === uri.toString());
		const remote = isRemoteResource(uri);
		if (!remote && uri.scheme !== 'file') { return { uri, trusted: false, permissions: undefined }; }
		const connected = remote && this.resolver.getConnectionData(uri.authority);
		const resolved = connected ? await this.resolver.resolveAuthority(uri.authority) : undefined;
		if (!this.current(generation)) { return { uri, trusted: false, permissions: undefined }; }
		const canonical = connected ? await this.resolver.getCanonicalURI(uri) : uri;
		// Resolver identities may narrow access, but cannot redirect a grant to another host or a local path.
		if (!this.current(generation) || remote && (canonical.scheme !== uri.scheme || canonical.authority !== uri.authority)) {
			return { uri, trusted: false, permissions: undefined };
		}
		const path = remote ? getRemoteWorkspacePath(canonical.with({ query: null, fragment: null })) : canonical.fsPath;
		// Active roots use their runtime grant on both local and remote hosts; saved grants can differ.
		const permissions = folder
			? await this.trust.readWorkspaceDirectory(folder.id)
			: (await this.trust.readDirectory(path)).permissions;
		if (!this.current(generation)) { return { uri, trusted: false, permissions: undefined }; }
		return { uri: canonical, trusted: resolved?.options?.isTrusted !== false && hasDevelopmentPermissions(permissions), permissions };
	}

	public async getWorkspaceTrustInfo(): Promise<IWorkspaceTrustInfo | undefined> {
		const generation = this.generation;
		const workspace = this.workspace.getWorkspace();
		const authority = getWorkspaceRemoteAuthority(workspace);
		const resolved = authority && this.resolver.getConnectionData(authority) ? await this.resolver.resolveAuthority(authority) : undefined;
		if (!this.current(generation)) return undefined;
		const folders = workspace.folders;
		if (folders.length === 0) {
			if (!authority || resolved?.options?.isTrusted === undefined) { return undefined; }
			// This URI identifies the remote namespace; it is never used to grant or read the filesystem root.
			const canonical = await this.resolver.getCanonicalURI(URI.from({ scheme: ASH_REMOTE_SCHEME, authority, path: '/' }));
			if (!this.current(generation)) return undefined;
			const sameHost = canonical.scheme === ASH_REMOTE_SCHEME && canonical.authority === authority;
			return { isTrusted: sameHost && resolved.options.isTrusted, isReadOnly: false };
		}
		const trustInfo = await Promise.all(folders.map(folder => this.getUriTrustInfo(folder.uri)));
		if (!this.current(generation)) return undefined;
		const permissions = trustInfo.map(info => info.permissions);
		if (permissions.some(allowed => allowed === undefined)) return undefined;
		return {
			// A resolver may restrict trust; only Rust's actual capabilities authorize development.
			isTrusted: resolved?.options?.isTrusted !== false && trustInfo.every(info => info.trusted),
			isReadOnly: permissions.every(allowed => allowed !== undefined
				&& READ_DIR_PERMISSIONS.every(permission => allowed.includes(permission))
				&& allowed.every(permission => READ_DIR_PERMISSIONS.includes(permission))),
		};
	}

	private invalidateTrust(): void {
		// A notification also retires reads already in flight, including multi-folder snapshots.
		this.generation++;
		this.projection = undefined;
		this.foldersChanged.fire();
		if (!this.permissionChange) void this.resolveWorkspaceTrust().catch(error => console.error('Workspace trust refresh failed', error));
	}

	private finishInitialization(): void {
		void this.resolved.complete();
		void this.initialized.complete();
	}

	protected override disposeCore(): void {
		this.finishInitialization();
		this.participants.clear();
		super.disposeCore();
	}

	private current(generation: number): boolean {
		return !this.isDisposed && generation === this.generation;
	}
}

function hasDevelopmentPermissions(allowed: readonly WorkspaceTrustPermission[] | undefined): boolean {
	return allowed !== undefined && DEVELOPMENT_DIR_PERMISSIONS.every(permission => allowed.includes(permission));
}

/** One pending decision per workspace; UI listeners present it without owning its completion. */
export class WorkspaceTrustRequestService extends Disposable implements IWorkspaceTrustRequestService {
	private readonly requests = this._register(new Emitter<WorkspaceTrustRequestOptions | undefined>());
	public readonly onDidInitiateWorkspaceTrustRequest = this.requests.event;
	private readonly startupRequests = this._register(new Emitter<void>());
	public readonly onDidInitiateWorkspaceTrustRequestOnStartup = this.startupRequests.event;
	private pending: { readonly response: DeferredPromise<boolean | undefined>; completion?: Promise<void>; } | undefined;

	constructor(
		@IWorkspaceTrustManagementService private readonly management: IWorkspaceTrustManagementService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this._register(workspace.onDidChangeWorkspace(() => this.cancelWorkspaceTrustRequest()));
		this._register(management.onDidChangeTrust(trusted => { if (trusted && !this.pending?.completion) this.completePending(true); }));
	}

	public requestWorkspaceTrust(options?: WorkspaceTrustRequestOptions): Promise<boolean | undefined> {
		return this.request(false, options);
	}

	public requestWorkspaceTrustOnStartup(): void { void this.request(true); }

	private request(startup: boolean, options?: WorkspaceTrustRequestOptions): Promise<boolean | undefined> {
		this.assertNotDisposed();
		if (this.pending) return this.pending.response.p;
		const pending = this.pending = { response: new DeferredPromise<boolean | undefined>() };
		void this.management.workspaceTrustInitialized.then(async () => {
			await this.management.resolveWorkspaceTrust();
			if (this.pending !== pending) return;
			if (this.management.isWorkspaceTrusted()) this.completePending(true);
			else if (startup) this.startupRequests.fire();
			else this.requests.fire(options);
		}).catch(error => {
			if (this.pending === pending) {
				this.cancelWorkspaceTrustRequest();
				this.notifications.error(getErrorMessage(error));
			}
		});
		return pending.response.p;
	}

	public completeWorkspaceTrustRequest(trusted?: boolean): Promise<void> {
		const pending = this.pending;
		if (!pending) return Promise.resolve();
		return pending.completion ??= Promise.resolve().then(async () => {
			if (this.pending !== pending) return;
			try {
				if (trusted !== undefined && trusted !== this.management.isWorkspaceTrusted()) await this.management.setWorkspaceTrust(trusted);
				if (this.pending === pending) this.completePending(this.management.isWorkspaceTrusted());
			} catch (error) {
				if (this.pending === pending) {
					this.cancelWorkspaceTrustRequest();
					this.notifications.error(getErrorMessage(error));
				}
			}
		});
	}

	public cancelWorkspaceTrustRequest(): void { this.completePending(undefined); }

	private completePending(result: boolean | undefined): void {
		const pending = this.pending;
		this.pending = undefined;
		if (pending) void pending.response.complete(result);
	}

	protected override disposeCore(): void {
		this.cancelWorkspaceTrustRequest();
		super.disposeCore();
	}
}

registerSingleton(IWorkspaceTrustRequestService, WorkspaceTrustRequestService, InstantiationType.Delayed);
