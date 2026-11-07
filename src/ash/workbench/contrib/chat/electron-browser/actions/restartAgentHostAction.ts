import { localize, localize2 } from '../../../../../nls.js';
import { Action2 } from '../../../../../platform/actions/common/actions.js';
import { restartLocalAppServer } from '../../../../../platform/agentHost/electron-browser/localAgentHostService.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { getWorkspaceRemoteAuthority, IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';

export class RestartLocalAgentHostAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.restartLocalAgentHost',
			title: localize2('chat.developer.restartLocalAgentHost', 'Restart Local App Server'),
			category: localize2('debugLogs.developer', 'Developer'),
			f1: true,
			precondition: ChatContextKeys.enabled.isEqualTo(true),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		if (accessor.get(IConfigurationService).getValue<boolean>(ChatAIDisabledSettingId)) {
			return;
		}
		if (getWorkspaceRemoteAuthority(accessor.get(IWorkspaceContextService).getWorkspace())) {
			throw new Error(localize('chat.developer.restartRemoteWindow', 'Restart the local App Server from a local desktop window.'));
		}
		try {
			await restartLocalAppServer();
		} catch (error) {
			throw new Error(localize('chat.developer.restartFailed', 'Could not restart the local App Server.'), { cause: error });
		}
	}
}
