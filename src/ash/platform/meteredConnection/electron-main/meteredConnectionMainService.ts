import { DeferredPromise } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { METERED_CONNECTION_SETTING_KEY, type IMeteredConnectionService, type MeteredConnectionSettingValue } from '../common/meteredConnection.js';

/** Owns one effective network state for every Desktop window and the updater. */
export class MeteredConnectionMainService extends Disposable implements IMeteredConnectionService {
	readonly _serviceBrand = undefined;
	private readonly changes = this._register(new Emitter<boolean>());
	readonly onDidChangeIsConnectionMetered = this.changes.event;
	private readonly firstObservation = new DeferredPromise<void>();
	readonly whenConnectionStateInitialized: Promise<void>;
	private browserMetered = false;
	private setting: MeteredConnectionSettingValue = 'auto';

	constructor(@IConfigurationService private readonly configuration: IConfigurationService) {
		super();
		this._register(
			configuration.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(METERED_CONNECTION_SETTING_KEY)) this.applyConfiguration();
			}),
		);
		this.applyConfiguration();
		this.whenConnectionStateInitialized = this.firstObservation.p;
	}

	get isConnectionMetered(): boolean {
		return this.setting === 'on' || (this.setting === 'auto' && this.browserMetered);
	}

	public setIsBrowserConnectionMetered(value: boolean): void {
		this.assertNotDisposed();
		const previous = this.isConnectionMetered;
		this.browserMetered = value;
		void this.firstObservation.complete();
		if (previous !== this.isConnectionMetered) this.changes.fire(this.isConnectionMetered);
	}

	private applyConfiguration(): void {
		if (this.isDisposed) return;
		try {
			const configured = this.configuration.getValue(METERED_CONNECTION_SETTING_KEY);
			const value = configured === undefined ? 'auto' : configured;
			if (value !== 'auto' && value !== 'on' && value !== 'off') throw new TypeError('Invalid metered connection setting');
			const previous = this.isConnectionMetered;
			this.setting = value;
			if (previous !== this.isConnectionMetered) this.changes.fire(this.isConnectionMetered);
		} catch (error) {
			console.error('Could not apply metered connection setting', error);
		}
	}
}
