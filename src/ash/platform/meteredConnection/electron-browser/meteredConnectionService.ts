import { addDisposableListener } from '../../../base/browser/dom.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { SyncDescriptor } from '../../instantiation/common/descriptors.js';
import { registerSingleton } from '../../instantiation/common/extensions.js';
import { IMainProcessService } from '../../ipc/common/mainProcessService.js';
import { IMeteredConnectionService, type NavigatorWithConnection, type NetworkInformation } from '../common/meteredConnection.js';
import { METERED_CONNECTION_CHANNEL, MeteredConnectionCommand } from '../common/meteredConnectionIpc.js';
import '../common/meteredConnection.config.contribution.js';

/** Reports browser signals and reads the main process's effective policy. */
export class ElectronMeteredConnectionService extends Disposable implements IMeteredConnectionService {
	readonly _serviceBrand = undefined;
	private readonly changes = this._register(new Emitter<boolean>());
	readonly onDidChangeIsConnectionMetered = this.changes.event;
	readonly whenConnectionStateInitialized: Promise<void>;
	private metered = true;
	private observationQueue: Promise<void> = Promise.resolve();

	constructor(connectionProvider: () => NetworkInformation | undefined, @IMainProcessService mainProcess: IMainProcessService) {
		super();
		const channel = mainProcess.getChannel(METERED_CONNECTION_CHANNEL);
		let observedChanges = 0;
		this._register(channel.listen<unknown>(MeteredConnectionCommand.OnDidChangeIsConnectionMetered)(value => {
			observedChanges++;
			this.acceptState(value);
		}));
		const connection = connectionProvider();
		const report = (): Promise<void> => {
			// Slow links do not establish billing status. Only explicit browser
			// signals participate in auto mode; the setting provides an override.
			const value = connection?.saveData === true || connection?.metered === true;
			this.observationQueue = this.observationQueue.catch(() => { }).then(async () => {
				if (!this.isDisposed) await channel.call(MeteredConnectionCommand.SetIsBrowserConnectionMetered, value);
			});
			return this.observationQueue;
		};
		const changed = () => { void report().catch(error => console.error('Could not report network state', error)); };
		if (connection) this._register(addDisposableListener(connection, 'change', changed));
		this.whenConnectionStateInitialized = report().then(async () => {
			if (this.isDisposed) return;
			const generation = observedChanges;
			const value = await channel.call<unknown>(MeteredConnectionCommand.IsConnectionMetered);
			// A snapshot reply can arrive after a more recent pushed state.
			if (generation === observedChanges) this.acceptState(value);
		});
		void this.whenConnectionStateInitialized.catch(error => console.error('Could not initialize network state', error));
	}

	get isConnectionMetered(): boolean { return this.metered; }

	private acceptState(value: unknown): void {
		if (typeof value !== 'boolean') throw new TypeError('Invalid metered connection state');
		if (this.isDisposed || value === this.metered) return;
		this.metered = value;
		this.changes.fire(value);
	}
}

registerSingleton(IMeteredConnectionService, new SyncDescriptor(ElectronMeteredConnectionService, [
	() => (navigator as NavigatorWithConnection).connection,
], true));
