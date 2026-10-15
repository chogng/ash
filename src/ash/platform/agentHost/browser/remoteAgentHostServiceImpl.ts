import type { Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import type { IAddress } from '../../remote/common/remoteAgentConnection.js';
import { AppServerConnectionRecovery, AppServerProtocolClient, type AppServerProtocolClientOptions } from './appServerProtocolClient.js';
import { AppServerSocketTransport } from './appServerSocketTransport.js';

interface RemoteAgentHostConnectionOptions {
	readonly protocol: AppServerProtocolClientOptions;
	getAddress(): Promise<IAddress>;
	getMetadata(): unknown;
	/** Reestablish the extension-owned remote session after each protocol handshake. */
	initialize(client: AppServerProtocolClient): Promise<void>;
	readonly onDidReconnectLocal: Event<void>;
}

/** Owns one extension-resolved remote endpoint, independently of the local carrier. */
export class RemoteAgentHostService extends Disposable {

	public readonly client: AppServerProtocolClient;
	private readonly recovery: AppServerConnectionRecovery;

	constructor(
		private readonly options: RemoteAgentHostConnectionOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		const transport = this._register(instantiationService.createInstance(AppServerSocketTransport, options));
		this.client = new AppServerProtocolClient(transport, options.protocol);
		this._register(toDisposable(() => this.client.dispose()));
		this.recovery = this._register(new AppServerConnectionRecovery(
			this.client,
			() => this.open(),
			(message, error) => this.logService.error('app-server', message, error),
		));
		this._register(options.onDidReconnectLocal(() => { void this.connect().catch(() => { }); }));
	}

	public connect(): Promise<void> {
		this.assertNotDisposed();
		return this.recovery.connect();
	}

	public whenConnected(): Promise<void> {
		return this.recovery.whenConnected();
	}

	private async open(): Promise<void> {
		this.assertNotDisposed();
		this.client.disconnect();
		await this.client.connect();
		this.assertNotDisposed();
		await this.options.initialize(this.client);
		this.assertNotDisposed();
		this.logService.debug('app-server', 'Remote App Server connection initialized');
	}
}
