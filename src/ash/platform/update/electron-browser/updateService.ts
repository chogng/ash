import { IMainProcessService } from '../../ipc/common/mainProcessService.js';
import type { IChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { DESKTOP_UPDATE_POLICY_SETTING, type DesktopUpdatePolicy, type IUpdateService, type UpdateCheckResult, type UpdateReadyResult } from '../common/updateService.js';

/** Desktop renderer adapter for the local signed update host. */
export class ElectronUpdateService implements IUpdateService {
	private readonly updates: IChannel;
	constructor(@IConfigurationService private readonly configuration: IConfigurationService, @IMainProcessService mainProcessService: IMainProcessService) {
		this.updates = mainProcessService.getChannel('update');
	}

	public checkForUpdates(): Promise<UpdateCheckResult> {
		return this.updates.call('checkForUpdates', this.channel());
	}

	public checkAutomatically(): Promise<UpdateCheckResult | undefined> {
		const policy = this.policy();
		return policy === 'never'
			? Promise.resolve(undefined)
			: this.updates.call('checkAutomatically', policy);
	}

	public downloadUpdate(): Promise<UpdateReadyResult> {
		return this.updates.call('downloadUpdate', this.channel());
	}

	public installUpdate(): Promise<void> {
		return this.updates.call('installUpdate');
	}

	private policy(): DesktopUpdatePolicy {
		return this.configuration.inspect<DesktopUpdatePolicy>(DESKTOP_UPDATE_POLICY_SETTING).userLocalValue ?? 'latest';
	}

	private channel(): 'latest' | 'stable' {
		const policy = this.policy();
		return policy === 'never' ? 'latest' : policy;
	}
}
