import { DeferredPromise } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { parseJsonc } from '../../../base/common/jsonc.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IConfigurationResourceService, type IConfigurationResourceSnapshot } from '../../configuration/common/configurationResourceService.js';
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
	private configurationRevision = -1;

	constructor(@IConfigurationResourceService configuration: IConfigurationResourceService) {
		super();
		this._register(configuration.onDidChangeResource(snapshot => this.applyConfiguration(snapshot)));
		this.whenConnectionStateInitialized = Promise.all([
			configuration.read().then(snapshot => this.applyConfiguration(snapshot)),
			this.firstObservation.p,
		]).then(() => { });
	}

	get isConnectionMetered(): boolean {
		return this.setting === 'on' || this.setting === 'auto' && this.browserMetered;
	}

	public setIsBrowserConnectionMetered(value: boolean): void {
		this.assertNotDisposed();
		const previous = this.isConnectionMetered;
		this.browserMetered = value;
		void this.firstObservation.complete();
		if (previous !== this.isConnectionMetered) this.changes.fire(this.isConnectionMetered);
	}

	private applyConfiguration(snapshot: IConfigurationResourceSnapshot): void {
		if (this.isDisposed || snapshot.revision <= this.configurationRevision) return;
		this.configurationRevision = snapshot.revision;
		// External edits may contain invalid settings. Keep the last valid policy,
		// and never let a delayed initial read overwrite a newer committed revision.
		try {
			const values = parseJsonc(snapshot.source) as Record<string, unknown>;
			const configured = values[METERED_CONNECTION_SETTING_KEY];
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
