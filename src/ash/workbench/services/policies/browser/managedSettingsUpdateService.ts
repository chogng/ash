import { observableFromEvent, type IObservable } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { GitHubErrorCode } from '../../../../platform/github/common/githubService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IAccountPolicyService } from '../common/accountPolicyService.js';
import { IManagedSettingsUpdateService, type IManagedSettingsUpdateInfo } from '../common/managedSettingsUpdate.js';

export class ManagedSettingsUpdateService implements IManagedSettingsUpdateService {
	readonly _serviceBrand = undefined;
	readonly updateInfo: IObservable<IManagedSettingsUpdateInfo | undefined>;

	constructor(@IAccountPolicyService policies: IAccountPolicyService) {
		// Subscribers own their event registration; reads never fetch or retry backend policy.
		this.updateInfo = observableFromEvent(this, policies.onDidChangeState, () => {
			const state = policies.state;
			if (state.phase !== 'failed' || state.failure !== GitHubErrorCode.ManagedSettingsUpdateRequired) return undefined;
			return {
				title: localize('managedSettingsUpdate.title', 'Managed settings compatibility'),
				message: localize('github.settings.managedCompatibility', 'GitHub rejected this client’s compatibility for managed settings. Contact your administrator.'),
				// The backend supplies no minimum client version or supported recovery URL.
				detail: undefined,
				action: undefined,
				updateStatus: undefined,
			};
		});
	}
}

registerSingleton(IManagedSettingsUpdateService, ManagedSettingsUpdateService, InstantiationType.Delayed);
