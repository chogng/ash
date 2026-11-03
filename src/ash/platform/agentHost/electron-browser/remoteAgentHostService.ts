import { DeferredPromise, raceCancellationError } from '../../../base/common/async.js';
import { throwIfCancelled } from '../../../base/common/cancellation.js';
import { CancellationError, isCancellationError } from '../../../base/common/errors.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { localize } from '../../../nls.js';
import type { IFileSystemDirectory } from '../../files/common/fileApi.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { invoke } from '../../ipc/electron-browser/rendererIpc.js';
import type { DisposableHandle } from '../../ipc/common/ipc.js';
import { ILogService } from '../../log/common/log.js';
import { SSH_REMOTE_INITIALIZE_TIMEOUT_MS } from '../../remote/common/remote.js';
import { REMOTE_AGENT_HOST_OPEN_CHANNEL, REMOTE_AGENT_HOST_CLOSE_CHANNEL, REMOTE_AGENT_HOST_WSL_DISTROS_CHANNEL } from '../../remote/common/remoteConnectionIpc.js';
import type { IWorkspaceTrustApi } from '../../workspace/common/workspaceTrust.js';
import type { AppServerProtocolClient } from '../browser/appServerProtocolClient.js';
import { agentHostConnectionAddress } from '../common/agentHostConnectionsService.js';
import type { IAgentConnection } from '../common/agentService.js';
import type { AppServerConnectionState } from '../common/appServerApi.js';
import { canonicalAgentHostConnection, isSSHAgentHost, remoteAgentHostRoot, type RemoteAgentHostConnection, type IRemoteAgentHostService, type IRemoteAgentHostProtocolClient, type IRemoteAgentHostConnectionInfo } from '../common/remoteAgentHostService.js';
import { LocalAgentHostServiceClient } from './localAgentHostService.js';

interface RemoteAgentHostOptions {
	readonly browser: boolean;
	readonly onDidSuspendOS: (listener: () => void) => DisposableHandle;
	readonly onDidResumeOS: (listener: () => void) => DisposableHandle;
	readonly createApi: (lease: LocalAgentHostServiceClient, target: RemoteAgentHostConnection, resources: DisposableStore, id: string) => IAgentConnection;
	readonly initializeDirectories: (client: AppServerProtocolClient, trust: IWorkspaceTrustApi, directories: readonly { readonly id: string; readonly path: string; readonly remoteHostLabel: string; }[]) => Promise<void>;
}

interface HostScope {
	readonly id: string;
	target: RemoteAgentHostConnection;
	readonly resources: DisposableStore;
	readonly controller: AbortController;
	readonly ready: Promise<IRemoteAgentHostProtocolClient>;
	directory?: IFileSystemDirectory;
	lease?: LocalAgentHostServiceClient;
	host?: IRemoteAgentHostProtocolClient;
	initialization?: Promise<void>;
	initializing?: boolean;
	error?: unknown;
}

/** Owns additional window connections; disposing a scope never stops the shared server. */
export class RemoteAgentHostService extends Disposable implements IRemoteAgentHostService {
	readonly isAvailable = true;
	private readonly hostChanges = this._register(new Emitter<void>());
	readonly onDidChangeConnections = this.hostChanges.event;
	private readonly hostScopes = new Map<string, HostScope>();

	constructor(
		private readonly options: RemoteAgentHostOptions,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(toDisposable(() => {
			for (const scope of [...this.hostScopes.values()]) this.releaseScope(scope);
		}));
	}

	get connections(): readonly IRemoteAgentHostConnectionInfo[] {
		return [...this.hostScopes.values()].map(scope => ({ id: scope.id, connection: scope.target, state: this.hostState(scope), host: scope.host }));
	}

	listWSLDistros(): Promise<readonly string[]> {
		return invoke(REMOTE_AGENT_HOST_WSL_DISTROS_CHANNEL);
	}

	connect(input: RemoteAgentHostConnection, signal: AbortSignal, ticket?: string): Promise<IRemoteAgentHostProtocolClient> {
		const target = canonicalAgentHostConnection(input);
		throwIfCancelled(signal);
		if (this.isDisposed) throw new CancellationError();
		const key = agentHostConnectionAddress(target);
		const existing = this.hostScopes.get(key);
		if (existing) {
			if (ticket && !isSSHAgentHost(target) && target.type === 'tunnel') this.releaseScope(existing);
			else return raceCancellationError(existing.ready, signal);
		}
		const controller = new AbortController();
		const resources = new DisposableStore();
		const ready = new DeferredPromise<IRemoteAgentHostProtocolClient>();
		const scope: HostScope = { id: generateUuid(), target, controller, resources, ready: ready.p };
		this.hostScopes.set(key, scope);
		resources.add(toDisposable(() => controller.abort()));
		resources.add(toDisposable(() => {
			void invoke(REMOTE_AGENT_HOST_CLOSE_CHANNEL, { id: scope.id }).catch(error => {
				if (!this.isDisposed) this.logService.error('app-server', 'Agent host release failed', error);
			});
		}));
		const cancel = (): void => this.releaseScope(scope);
		signal.addEventListener('abort', cancel, { once: true });
		resources.add(toDisposable(() => signal.removeEventListener('abort', cancel)));
		this.hostChanges.fire();
		void this.openHostScope(scope, ticket).then(host => {
			signal.removeEventListener('abort', cancel);
			void ready.complete(host);
		}, error => { void ready.error(error); });
		return ready.p;
	}

	disconnect(id: string): void {
		const scope = [...this.hostScopes.values()].find(scope => scope.id === id);
		if (scope) this.releaseScope(scope);
	}

	async reconnect(id: string): Promise<void> {
		const scope = [...this.hostScopes.values()].find(scope => scope.id === id);
		if (!scope) throw new CancellationError();
		await scope.ready;
		if (scope.resources.isDisposed) throw new CancellationError();
		await scope.host!.api.appServer.recovery!.reconnect();
	}

	private hostState(scope: HostScope): AppServerConnectionState {
		if (scope.resources.isDisposed) return 'stopped';
		const state = scope.lease?.client.state ?? 'starting';
		if (state !== 'ready') return state;
		return scope.error ? 'crashed' : scope.initializing ? 'initializing' : state;
	}

	private releaseScope(scope: HostScope): void {
		const key = agentHostConnectionAddress(scope.target);
		if (this.hostScopes.get(key) !== scope) return;
		this.hostScopes.delete(key);
		scope.resources.dispose();
		this.hostChanges.fire();
	}
	private async openHostScope(scope: HostScope, ticket?: string): Promise<IRemoteAgentHostProtocolClient> {
		const { id, resources: hostResources, controller } = scope;
		const signal = controller.signal;
		const release = (): void => this.releaseScope(scope);
		try {
			throwIfCancelled(signal);
			const target = canonicalAgentHostConnection(await raceCancellationError(invoke(REMOTE_AGENT_HOST_OPEN_CHANNEL, { id, connection: scope.target, ...(ticket ? { ticket } : {}) }), signal));
			scope.target = target;
			throwIfCancelled(signal);
			if (hostResources.isDisposed) { throw new CancellationError(); }
			const lease = hostResources.add(this.instantiation.createInstance(LocalAgentHostServiceClient, {
				clientName: 'ash-desktop-agents', connection: { id }, initializeTimeoutMs: SSH_REMOTE_INITIALIZE_TIMEOUT_MS,
				capabilities: { ...(this.options.browser ? { browser: { version: 4, observe: true, input: true } } : {}), agentInteractions: { version: 1, kinds: ['approval', 'permissions', 'userInput', 'toolResultReview'] }, ...(isSSHAgentHost(target) || target.type === 'wsl' ? { directoryGrantsHost: { version: 1 } } : {}) },
			}));
			scope.lease = lease;
			hostResources.add(lease.client.onStateChange(state => {
				// Protocol readiness precedes restoring this scope's directory environment.
				if (state !== 'ready') scope.initializing = true;
				this.hostChanges.fire();
			}));
			// Each scope observes device power, but keeps its own retry and protocol generation.
			const suspend = this.options.onDidSuspendOS(() => lease.recovery.suspend());
			const resume = this.options.onDidResumeOS(() => lease.recovery.resume());
			hostResources.add(toDisposable(() => { suspend.dispose(); resume.dispose(); }));
			const enabled = await lease.connect();
			throwIfCancelled(signal);
			if (!enabled) { throw new Error(localize({ bundle: 'ash.workbench', key: 'agentHosts.unavailable' }, 'Agent host connections are unavailable in this window.')); }
			if (hostResources.isDisposed) { throw new CancellationError(); }
			let api = this.options.createApi(lease, target, hostResources, id);
			const connectionApi = api.appServer;
			hostResources.add(lease.recovery.onDidChange(() => this.hostChanges.fire()));
			const reconnect = async (): Promise<void> => {
				throwIfCancelled(signal);
				await lease.recovery.reconnect();
				await scope.initialization;
				throwIfCancelled(signal);
			};
			api = {
				...api, appServer: {
					isAvailable: connectionApi.isAvailable,
					get connectionGeneration() { return connectionApi.connectionGeneration; },
					get operatingSystem() { return connectionApi.operatingSystem; },
					get userHome() { return connectionApi.userHome; },
					recovery: {
						get phase() {
							return lease.recovery.status === 'idle' && (scope.initializing || scope.error) ? 'workspace' : 'connection';
						},
						get status() {
							const status = lease.recovery.status;
							return status === 'unavailable' || status === 'suspended' ? status : scope.error ? 'failed' : scope.initializing && status === 'idle' ? 'recovering' : status;
						},
						get error() { return lease.recovery.status === 'unavailable' ? lease.recovery.error : scope.error instanceof Error ? scope.error.message : lease.recovery.error; },
						onDidChange: this.hostChanges.event,
						reconnect,
					},
					getConnectionState: async () => this.hostState(scope),
					getSlashCommands: () => connectionApi.getSlashCommands(),
					onConnectionState: listener => {
						let previous = this.hostState(scope);
						return this.hostChanges.event(() => { const state = this.hostState(scope); if (state !== previous) { previous = state; listener(state); } });
					},
				}
			};
			const initialize = async (): Promise<void> => {
				const root = remoteAgentHostRoot(target, id);
				if (isSSHAgentHost(target) || target.type === 'wsl') {
					const host = isSSHAgentHost(target) ? target.host : target.distro;
					const remoteHostLabel = target.name === host ? host : `${target.name} (${host})`;
					await this.options.initializeDirectories(lease.client, api.workspaceTrust, [{ id: `agent-host:${id}`, path: target.workspace, remoteHostLabel }]);
				}
				// A Tunnel uses the Web session's existing grant, never Desktop host privileges.
				const directory = await api.fs.resolvePath(root);
				if (directory.uri.toString() !== root.toString()) throw new Error(localize('agentHost.rootChanged', 'The host returned a different workspace directory.'));
				scope.directory = directory;
			};
			const restoreDirectories = (): Promise<void> => {
				const task = scope.initialization = initialize();
				scope.initializing = true;
				scope.error = undefined;
				this.hostChanges.fire();
				void task.then(() => {
					if (scope.initialization !== task || hostResources.isDisposed) return;
					scope.initializing = false;
					this.hostChanges.fire();
				}, error => {
					if (scope.initialization !== task || hostResources.isDisposed) return;
					scope.initializing = false;
					scope.error = error;
					this.hostChanges.fire();
					if (!isCancellationError(error)) this.logService.error('app-server', 'Agent host directory recovery failed', error);
				});
				return task;
			};
			await restoreDirectories();
			throwIfCancelled(signal);
			if (hostResources.isDisposed) { throw new CancellationError(); }
			hostResources.add(lease.onDidReconnect(() => { void restoreDirectories().catch(() => { }); }));
			scope.host = { id, connection: target, api, get directory() { return scope.directory!; }, dispose: release, [Symbol.dispose]: release };
			this.hostChanges.fire();
			throwIfCancelled(signal);
			return scope.host;
		} catch (error) {
			release();
			throw error;
		}
	}
}
