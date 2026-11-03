import { throwIfCancelled } from '../../../base/common/cancellation.js';
import { canceled } from '../../../base/common/errors.js';
import { localize } from '../../../nls.js';
import { IRemoteAgentHostService } from '../../../platform/agentHost/common/remoteAgentHostService.js';
import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { IRemoteConnectionService } from '../../../platform/remote/common/remoteConnectionService.js';
import { sshAgentHostProviderId } from '../../common/agentHostSessionsProvider.js';

/** A conversation link may select a saved SSH target after explicit confirmation. */
export class SavedSSHConversationHost {
	constructor(
		@IRemoteConnectionService private readonly savedConnections: IRemoteConnectionService,
		@IRemoteAgentHostService private readonly remoteHosts: IRemoteAgentHostService,
		@IDialogService private readonly dialogs: IDialogService,
	) { }

	async connect(providerId: string, assertCurrent: () => void, signal: AbortSignal): Promise<boolean> {
		if (!this.savedConnections.available || !this.remoteHosts.isAvailable) return false;
		const matches = (await this.savedConnections.list()).filter(connection => sshAgentHostProviderId(connection) === providerId);
		throwIfCancelled(signal);
		assertCurrent();
		if (matches.length !== 1) return false;

		// Display and connect the saved definition. The Main lease revalidates it against the catalog.
		const target = matches[0]!;
		const result = await this.dialogs.confirm({
			custom: true,
			message: localize({ bundle: 'ash.workbench', key: 'agentHosts.openConversation.confirm' }, 'Connect to {0} and open the conversation?', target.name),
			detail: localize({ bundle: 'ash.workbench', key: 'agentHosts.openConversation.target' }, 'SSH host: {0}\nWorkspace: {1}', target.host, target.workspace),
			primaryButton: localize({ bundle: 'ash.workbench', key: 'agentHosts.openConversation.connect' }, 'Connect and Open'),
		});
		if (!result.confirmed) throw canceled();
		throwIfCancelled(signal);
		assertCurrent();
		await this.remoteHosts.connect(target, signal);
		return true;
	}
}
