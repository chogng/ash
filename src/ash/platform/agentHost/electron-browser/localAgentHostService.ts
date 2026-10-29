import { IWebWorkerService } from '../../webWorker/browser/webWorkerService.js';
import { createAppServerFrameDecoder } from '../browser/appServerFrameDecoder.js';
import { appServerConnectionChannel, type AppServerConnectionTarget } from '../common/appServerTransport.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, MutableDisposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { invoke } from '../../ipc/electron-browser/rendererIpc.js';
import { ILogService } from '../../log/common/log.js';
import { ManagedRemoteConnection, RemoteConnectionType } from '../../remote/common/remoteAuthorityResolver.js';
import { IRemoteSocketFactoryService } from '../../remote/common/remoteSocketFactoryService.js';
import { AppServerConnectionRecovery, AppServerProtocolClient, type AppServerProtocolClientOptions } from '../browser/appServerProtocolClient.js';
import { AppServerSocketTransport } from '../browser/appServerSocketTransport.js';
import { AppServerProtocolIncompatibleError } from '../common/appServerProtocolCompatibility.js';
import { AppServerMessagePortTransport } from './appServerMessagePortTransport.js';

let nextConnectionId = 0;

/** Owns one of the window's App Server leases; the Rust process remains owned by Main. */
export class LocalAgentHostServiceClient extends Disposable {
	private readonly carrier: AppServerMessagePortTransport;
	private readonly factoryRegistration = this._register(new MutableDisposable<IDisposable>());
	private readonly reconnected = this._register(new Emitter<void>());
	public readonly onDidReconnect = this.reconnected.event;
	public readonly client: AppServerProtocolClient;
	public readonly recovery: AppServerConnectionRecovery;
	private connectionId = 0;
	private isEnabled = false;
	private readonly channelPrefix: string;
	private hasInitialized = false;

	constructor(
		options: AppServerProtocolClientOptions & { readonly connection?: AppServerConnectionTarget },
		@IRemoteSocketFactoryService private readonly factories: IRemoteSocketFactoryService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IWebWorkerService workers: IWebWorkerService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.channelPrefix = appServerConnectionChannel(options.connection ?? 'workspace');
		// Main validates the runtime before transferring the port, including cold SSH deployment.
		this.carrier = this._register(
			new AppServerMessagePortTransport(
				() => {
					// Recovery owns rejection reporting and the bounded retry budget.
					void this.connect().catch(() => {});
				},
				options.connection,
				options.initializeTimeoutMs,
			),
		);
		const transport = this._register(
			instantiationService.createInstance(AppServerSocketTransport, {
				getAddress: async () => ({
					connectTo: new ManagedRemoteConnection(this.connectionId),
					connectionToken: undefined,
				}),
				getMetadata: () => this.connectionMetadata,
			}),
		);
		this.client = new AppServerProtocolClient(transport, options, createAppServerFrameDecoder(workers));
		this._register(toDisposable(() => this.client.dispose()));
		this.recovery = this._register(
			new AppServerConnectionRecovery(
				this.client,
				() => this.open(),
				(message, error) => this.logService.error('app-server', message, error),
			),
		);
	}

	public get connectionMetadata(): unknown {
		return this.carrier.connectionMetadata;
	}

	public async connect(): Promise<boolean> {
		this.assertNotDisposed();
		await this.recovery.connect();
		return this.isEnabled;
	}

	public whenConnected(): Promise<void> {
		return this.recovery.whenConnected();
	}

	private async acquire(): Promise<boolean> {
		performance.mark('ash.appServer.acquire-start');
		this.factoryRegistration.clear();
		const enabled = await this.carrier.acquire();
		this.assertNotDisposed();
		performance.mark('ash.appServer.acquired');
		if (enabled) {
			const id = (this.connectionId = ++nextConnectionId);
			const socket = this.carrier.socket;
			let leased = false;
			this.factoryRegistration.value = this.factories.register(RemoteConnectionType.Managed, {
				supports: connection => connection.id === id,
				connect: async (_connection, path, query) => {
					if (leased || path || query || this.carrier.socket !== socket) {
						throw new Error('App Server connection endpoint was superseded');
					}
					// A port may be leased by one protocol incarnation only.
					leased = true;
					return socket;
				},
			});
		}
		return enabled;
	}

	private async open(): Promise<void> {
		this.assertNotDisposed();
		this.client.disconnect();
		this.isEnabled = await this.acquire();
		if (!this.isEnabled) {
			return;
		}
		try {
			await this.client.connect();
		} catch (error) {
			if (!(error instanceof AppServerProtocolIncompatibleError) || (await invoke(`${this.channelPrefix}:recover-runtime`, error.incompatibility)) !== true) {
				throw error;
			}
			this.assertNotDisposed();
			await this.acquire();
			await this.client.connect();
		}
		this.assertNotDisposed();
		await this.carrier.initialized();
		this.assertNotDisposed();
		performance.mark('ash.appServer.initialized');
		this.logService.debug('app-server', 'App Server connection initialized');
		if (this.hasInitialized) {
			this.reconnected.fire();
		}
		this.hasInitialized = true;
	}
}
