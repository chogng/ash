import { invoke } from '../../ipc/electron-browser/rendererIpc.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { DESKTOP_UPDATE_POLICY_SETTING, UPDATE_AUTO_CHECK_CHANNEL, UPDATE_CHECK_CHANNEL, UPDATE_DOWNLOAD_CHANNEL, UPDATE_INSTALL_CHANNEL, type DesktopUpdatePolicy, type IUpdateService, type UpdateCheckResult, type UpdateReadyResult } from '../common/updateService.js';

/** Desktop renderer adapter for the local signed update host. */
export class ElectronUpdateService implements IUpdateService {
	constructor(@IConfigurationService private readonly configuration: IConfigurationService) {}

	public checkForUpdates(): Promise<UpdateCheckResult> {
		return invoke<UpdateCheckResult>(UPDATE_CHECK_CHANNEL, this.channel());
	}

	public checkAutomatically(): Promise<UpdateCheckResult | undefined> {
		const policy = this.policy();
		return policy === 'never'
			? Promise.resolve(undefined)
			: invoke<UpdateCheckResult | undefined>(UPDATE_AUTO_CHECK_CHANNEL, policy);
	}

	public downloadUpdate(): Promise<UpdateReadyResult> {
		return invoke<UpdateReadyResult>(UPDATE_DOWNLOAD_CHANNEL, this.channel());
	}

	public installUpdate(): Promise<void> {
		return invoke<void>(UPDATE_INSTALL_CHANNEL);
	}

	private policy(): DesktopUpdatePolicy {
		return this.configuration.inspect<DesktopUpdatePolicy>(DESKTOP_UPDATE_POLICY_SETTING).userLocalValue ?? 'latest';
	}

	private channel(): 'latest' | 'stable' {
		const policy = this.policy();
		return policy === 'never' ? 'latest' : policy;
	}
}
