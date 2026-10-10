import { localize } from '../../../../nls.js';
import { Disposable, DisposableStore, MutableDisposable, combinedDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { RemoteExtensionHost } from '../common/remoteExtensionHost.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Schemas } from '../../../../base/common/network.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IExtensionHostApi, type ExtensionHostRuntime, type ExtensionHostFleetSnapshot } from '../../../../platform/extensionHost/common/extensionHostApi.js';
import { IRemoteAuthorityResolverService, getRemoteAuthorityPrefix, RemoteConnectionType, RemoteAuthorityResolverError, RemoteAuthorityResolverErrorCode, type ResolverResult } from '../../../../platform/remote/common/remoteAuthorityResolver.js';
import { IRemoteSocketFactoryService } from '../../../../platform/remote/common/remoteSocketFactoryService.js';
import { BrowserSocketFactory } from '../../../../platform/remote/browser/browserSocketFactory.js';
import { MainThreadManagedSockets } from '../../../api/browser/mainThreadManagedSockets.js';
import { ExtensionHostManager } from '../common/extensionHostManager.js';

interface ExtensionHostRoute {
	api: IExtensionHostApi;
	epoch: number;
	runtime: ExtensionHostRuntime;
	generation: number;
	incarnation: number | undefined;
}

/** Resolves from the local fleet before the remote backend and Workbench are started. */
export class NativeExtensionService extends Disposable {
	private readonly managed = this._register(new MutableDisposable<MainThreadManagedSockets>());
	private remoteHost: RemoteExtensionHost | undefined;
	private windowApi: IExtensionHostApi | undefined;
	private readonly hostChanges = this._register(new Emitter<number>());
	private readonly connectionChanges = this._register(new Emitter<Awaited<ReturnType<IExtensionHostApi['getConnectionState']>>>());
	private hostGeneration = 1;
	private hosts = new Map<string, ExtensionHostRoute>();
	private remoteEpoch = 0;
	private localSnapshotGeneration = 0;
	private remoteSnapshotGeneration = 0;
	private nextIdentity = 0;
	private revision = 0;
	private authority: string | undefined;
	private runtime: ExtensionHostRuntime | undefined;

	constructor(@IExtensionHostApi private readonly api: IExtensionHostApi,
		@IRemoteAuthorityResolverService private readonly resolver: IRemoteAuthorityResolverService,
		@IRemoteSocketFactoryService factories: IRemoteSocketFactoryService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		this._register(factories.register(RemoteConnectionType.WebSocket, new BrowserSocketFactory(undefined)));
		const connection = api.onConnectionState(state => {
			if (state !== 'ready') { this.retireResolver(); }
		});
		this._register(toDisposable(() => connection.dispose()));
		const fleetChanges = api.onDidChange(() => {
			const runtime = this.runtime;
			const revision = this.revision;
			if (!runtime) { return; }
			void api.list().then(snapshot => {
				if (revision !== this.revision || this.isDisposed) { return; }
				const current = snapshot.extensions.find(entry => entry.id === runtime.id);
				const sameIncarnation = current?.lifecycle === 'ready' && current.incarnation === runtime.incarnation && current.activationGeneration === runtime.activationGeneration;
				const stillRegistered = current?.registrations.some(entry => entry.kind === 'remoteAuthorityResolver' && this.authority?.startsWith(`${entry.authorityPrefix}+`));
				if (!sameIncarnation || !stillRegistered) { this.retireResolver(); }
			}, error => {
				if (revision === this.revision && !this.isDisposed) { this.retireResolver(); }
				console.error('Failed to check the local resolver incarnation', error);
			});
		});
		this._register(toDisposable(() => fleetChanges.dispose()));
		this._register(toDisposable(() => {
			this.retireResolver();
			this.resolver._setCanonicalURIProvider(async () => { throw new CancellationError(); });
		}));
		resolver._setCanonicalURIProvider(async uri => {
			if (uri.scheme !== Schemas.ashRemote) { return uri; }
			if (this.authority && uri.authority !== this.authority) { throw new RemoteAuthorityResolverError('The URI belongs to another remote authority', RemoteAuthorityResolverErrorCode.InvalidAuthority); }
			this.assertNotDisposed();
			const revision = this.revision;
			const runtime = await this.getResolver(uri.authority);
			const canonical = await this.instantiation.createInstance(ExtensionHostManager, runtime).getCanonicalURI(uri.authority, uri);
			if (revision !== this.revision || this.isDisposed) { throw new CancellationError(); }
			return canonical ?? uri;
		});
	}

	public async resolveAuthority(authority: string, resolveAttempt: number): Promise<ResolverResult> {
		this.assertNotDisposed();
		if (this.remoteHost && this.authority !== authority) { throw new RemoteAuthorityResolverError('The window belongs to another remote authority', RemoteAuthorityResolverErrorCode.InvalidAuthority); }
		const revision = ++this.revision;
		if (this.authority && this.authority !== authority) { this.resolver._clearResolvedAuthority(this.authority); }
		this.authority = authority;
		this.runtime = undefined;
		this.resolver._clearResolvedAuthority(authority);
		this.managed.clear();
		try {
			const prefix = getRemoteAuthorityPrefix(authority);
			const runtime = await this.getResolver(authority);
			const result = await this.instantiation.createInstance(ExtensionHostManager, runtime).resolveAuthority(authority, resolveAttempt);
			if (revision !== this.revision || this.isDisposed) { throw new CancellationError(); }
			this.runtime = runtime;
			if (result.authority.connectTo.type === RemoteConnectionType.Managed) {
				const registration = runtime.registrations.find(entry => entry.kind === 'remoteAuthorityResolver' && entry.authorityPrefix === prefix)!;
				this.managed.value = this.instantiation.createInstance(MainThreadManagedSockets, runtime, registration.registrationId, -result.authority.connectTo.id);
			}
			this.resolver._setResolvedAuthority(result.authority, result.options);
			return this.resolver.resolveAuthority(authority);
		} catch (error) {
			if (revision === this.revision && !this.isDisposed) { this.resolver._setResolvedAuthorityError(authority, error); }
			throw error;
		}
	}

	public async startRemoteExtensionHost(api: IExtensionHostApi, authority: string): Promise<IExtensionHostApi> {
		this.assertNotDisposed();
		if (this.authority !== authority) { throw new CancellationError(); }
		if (!this.remoteHost) {
			const scope = this._register(new DisposableStore());
			const services = scope.add(this.instantiation.createChild(new ServiceCollection([IExtensionHostApi, api])));
			this.remoteHost = scope.add(services.createInstance(RemoteExtensionHost, authority));
			for (const host of [this.api, api]) {
				const changed = host.onDidChange(() => this.hostChanges.fire(++this.hostGeneration));
				scope.add(toDisposable(() => changed.dispose()));
			}
			const states = api.onConnectionState(state => {
				// Ready is published only after the new connection's extension handshake completes.
				if (state !== 'ready') {
					this.hosts.clear();
					this.connectionChanges.fire(state);
				}
			});
			scope.add(toDisposable(() => states.dispose()));
			this.windowApi = {
				start: () => { throw new Error('Remote extension startup belongs to the connection owner'); },
				isAvailable: () => api.isAvailable(),
				list: () => this.listExtensionHosts(),
				reconcile: async mode => {
					await this.remoteHost!.whenReady();
					await Promise.all([this.api.reconcile(mode), api.reconcile(mode)]);
					return this.listExtensionHosts();
				},
				activateByEvent: async request => {
					await this.listExtensionHosts();
					const host = this.hosts.get(request.extensionId);
					if (!host) { throw new CancellationError(); }
					await host.api.activateByEvent({ ...request, activationGeneration: this.sourceIdentity(host, request.activationGeneration, 'generation') });
					return this.listExtensionHosts();
				},
				invoke: async (request, signal) => {
					await this.remoteHost!.whenReady();
					const host = this.hosts.get(request.extensionId);
					if (!host) { throw new CancellationError(); }
					return host.api.invoke({
						...request,
						activationGeneration: this.sourceIdentity(host, request.activationGeneration, 'generation'),
						incarnation: this.sourceIdentity(host, request.incarnation, 'incarnation'),
					}, signal);
				},
				registerClientHandler: handler => {
					const local = this.api.registerClientHandler((operation, signal, source) => handler(operation, signal, this.clientIdentity(source, this.api)));
					try {
						const remote = api.registerClientHandler((operation, signal, source) => handler(operation, signal, this.clientIdentity(source, api)));
						return combinedDisposable(toDisposable(() => local.dispose()), toDisposable(() => remote.dispose()));
					} catch (error) {
						local.dispose();
						throw error;
					}
				},
				getConnectionState: async () => {
					const state = await api.getConnectionState();
					return state === 'ready' && !this.remoteHost!.isReady ? 'initializing' : state;
				},
				onDidChange: listener => this.hostChanges.event(listener),
				onConnectionState: listener => this.connectionChanges.event(listener),
			};
		}
		await this.remoteHost.start();
		this.remoteEpoch++;
		this.remoteSnapshotGeneration = 0;
		this.connectionChanges.fire('ready');
		this.hostChanges.fire(++this.hostGeneration);
		return this.windowApi!;
	}

	private async listExtensionHosts(): Promise<ExtensionHostFleetSnapshot> {
		await this.remoteHost!.whenReady();
		const epoch = this.remoteEpoch;
		const [local, remote] = await Promise.all([this.api.list(), this.remoteHost!.api.list()]);
		this.assertNotDisposed();
		if (epoch !== this.remoteEpoch || local.generation < this.localSnapshotGeneration || remote.generation < this.remoteSnapshotGeneration) {
			throw new CancellationError();
		}
		this.localSnapshotGeneration = local.generation;
		this.remoteSnapshotGeneration = remote.generation;
		const extensions = new Map<string, ExtensionHostRuntime>();
		const hosts: typeof this.hosts = new Map();
		const retain = (runtime: ExtensionHostRuntime, api: IExtensionHostApi, local: boolean): void => {
			const previous = this.hosts.get(runtime.id);
			const epoch = local ? 0 : this.remoteEpoch;
			const sameHost = previous?.api === api && previous.epoch === epoch;
			// Never reuse a front-end fence when a new backend connection restarts its counters.
			const generation = sameHost && previous.runtime.activationGeneration === runtime.activationGeneration ? previous.generation : ++this.nextIdentity;
			const incarnation = runtime.incarnation === undefined
				? undefined
				: sameHost && previous.runtime.incarnation === runtime.incarnation ? previous.incarnation : ++this.nextIdentity;
			const outputEvents = runtime.outputEvents
				.filter(event => event.activationGeneration === runtime.activationGeneration && event.incarnation === runtime.incarnation)
				.map(event => ({ ...event, activationGeneration: generation, incarnation: incarnation! }));
			extensions.set(runtime.id, { ...runtime, activationGeneration: generation, incarnation, outputEvents });
			hosts.set(runtime.id, { api, epoch, runtime, generation, incarnation });
		};
		for (const runtime of local.extensions) { retain(runtime, this.api, true); }
		for (const runtime of remote.extensions) {
			// Resolver and saved-connection providers continue executing on the local control client.
			const localRuntime = local.extensions.find(entry => entry.id === runtime.id);
			const localResolver = localRuntime?.registrations.some(entry => entry.kind === 'remoteAuthorityResolver' || entry.kind === 'remoteConnectionResolver')
				|| localRuntime?.activation?.events.includes('onDemand:remoteAuthorityResolver');
			if (localResolver) { continue; }
			retain(runtime, this.remoteHost!.api, false);
		}
		this.hosts = hosts;
		return { generation: this.hostGeneration, extensions: [...extensions.values()] };
	}

	private sourceIdentity(host: ExtensionHostRoute, value: number, field: 'generation' | 'incarnation'): number {
		if (host[field] !== value) { throw new CancellationError(); }
		return field === 'generation' ? host.runtime.activationGeneration : host.runtime.incarnation!;
	}

	private clientIdentity(source: Parameters<Parameters<IExtensionHostApi['registerClientHandler']>[0]>[2], api: IExtensionHostApi): typeof source {
		const host = this.hosts.get(source.extensionId);
		if (!host || host.api !== api || host.runtime.activationGeneration !== source.activationGeneration || host.runtime.incarnation !== source.incarnation) { throw new CancellationError(); }
		return { ...source, activationGeneration: host.generation, incarnation: host.incarnation! };
	}

	private retireResolver(): void {
		this.revision++;
		this.runtime = undefined;
		this.managed.clear();
		if (this.authority) { this.resolver._clearResolvedAuthority(this.authority); }
	}

	private async getResolver(authority: string): Promise<ExtensionHostRuntime> {
		let snapshot = await this.api.reconcile('refresh');
		const prefix = getRemoteAuthorityPrefix(authority);
		for (const runtime of snapshot.extensions.filter(extension => extension.lifecycle === 'dormant' && extension.activation?.events.includes('onDemand:remoteAuthorityResolver'))) {
			snapshot = await this.api.activateByEvent({ extensionId: runtime.id, activationGeneration: runtime.activationGeneration, event: { type: 'resolveAuthority', authorityPrefix: prefix } });
		}
		const candidates = snapshot.extensions.filter(runtime => runtime.lifecycle === 'ready' && runtime.registrations.some(entry => entry.kind === 'remoteAuthorityResolver' && entry.authorityPrefix === prefix));
		if (!candidates.length) { throw new RemoteAuthorityResolverError(localize('remote.authorityResolver.missing', "No enabled local extension can resolve '{0}'.", authority), RemoteAuthorityResolverErrorCode.NoResolverFound); }
		if (candidates.length > 1) { throw new RemoteAuthorityResolverError(localize('remote.resolver.duplicate', "More than one extension resolves '{0}'. Disable the duplicate resolver.", prefix)); }
		return candidates[0]!;
	}
}
