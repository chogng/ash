import { IMainProcessService } from '../../ipc/common/mainProcessService.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import type { IChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IMeteredConnectionService } from '../../meteredConnection/common/meteredConnection.js';
import '../../meteredConnection/electron-browser/meteredConnectionService.js';
import {
	DESKTOP_UPDATE_POLICY_SETTING,
	type DesktopUpdatePolicy,
	type IUpdateService,
	type UpdateCheckResult,
	type UpdateReadyResult,
	type UpdateState,
} from '../common/updateService.js';

/** Desktop renderer adapter for the local signed update host. */
export class ElectronUpdateService extends Disposable implements IUpdateService {
	private readonly updates: IChannel;
	private readonly stateChanges = this._register(new Emitter<UpdateState>());
	readonly onDidChangeState = this.stateChanges.event;
	private currentState: UpdateState = 'idle';
	get state(): UpdateState {
		return this.currentState;
	}
	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@IMeteredConnectionService private readonly meteredConnection: IMeteredConnectionService,
	) {
		super();
		this.updates = mainProcessService.getChannel('update');
		let changed = false;
		this._register(
			this.updates.listen<unknown>('onDidChangeState')(value => {
				changed = true;
				this.acceptState(value);
			}),
		);
		void this.updates
			.call<unknown>('state')
			.then(value => {
				// A pushed state is newer than the startup snapshot, including in newly opened windows.
				if (!changed) this.acceptState(value);
			})
			.catch(error => console.error('Could not read update state', error));
	}

	private acceptState(value: unknown): void {
		if (value !== 'idle' && value !== 'downloading' && value !== 'ready' && value !== 'installing')
			throw new TypeError('Invalid update state');
		if (this.isDisposed || value === this.currentState) return;
		this.currentState = value;
		this.stateChanges.fire(value);
	}

	public checkForUpdates(): Promise<UpdateCheckResult> {
		return this.updates.call('checkForUpdates', this.channel());
	}

	public async checkAutomatically(): Promise<UpdateCheckResult | undefined> {
		const policy = this.policy();
		if (policy === 'never') return undefined;
		await this.meteredConnection.whenConnectionStateInitialized;
		const currentPolicy = this.policy();
		if (currentPolicy === 'never') return undefined;
		return this.updates.call('checkAutomatically', currentPolicy);
	}

	public downloadUpdate(): Promise<UpdateReadyResult> {
		return this.updates.call('downloadUpdate', this.channel());
	}

	public installUpdate(): Promise<void> {
		return this.updates.call('installUpdate');
	}

	private policy(): DesktopUpdatePolicy {
		return (
			this.configuration.inspect<DesktopUpdatePolicy>(DESKTOP_UPDATE_POLICY_SETTING).userLocalValue ?? 'latest'
		);
	}

	private channel(): 'latest' | 'stable' {
		const policy = this.policy();
		return policy === 'never' ? 'latest' : policy;
	}
}
