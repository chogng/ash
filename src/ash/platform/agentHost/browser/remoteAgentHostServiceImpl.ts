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
	public readonly recovery: AppServerConnectionRecovery;
	private localConnectionEpoch = 0;

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
		this._register(options.onDidReconnectLocal(() => {
			if (this.isDisposed) return;
			this.localConnectionEpoch++;
			// Authority resolution and extension initialization belong to this local incarnation.
			this.client.disconnect();
			void this.connect().catch(() => { });
		}));
	}

	public connect(): Promise<void> {
		this.assertNotDisposed();
		return this.recovery.connect();
	}

	public whenConnected(): Promise<void> {
		return this.recovery.whenConnected();
	}

	private async open(): Promise<void> {
		for (; ;) {
			this.assertNotDisposed();
			const localConnectionEpoch = this.localConnectionEpoch;
			this.client.disconnect();
			try {
				await this.client.connect();
				this.assertNotDisposed();
				if (localConnectionEpoch !== this.localConnectionEpoch) continue;
				await this.options.initialize(this.client);
				this.assertNotDisposed();
				if (localConnectionEpoch !== this.localConnectionEpoch) continue;
				this.logService.debug('app-server', 'Remote App Server connection initialized');
				return;
			} catch (error) {
				if (this.isDisposed || localConnectionEpoch === this.localConnectionEpoch) throw error;
				// Recovery callers share this task until the latest local incarnation is ready.
			}
		}
	}
}
