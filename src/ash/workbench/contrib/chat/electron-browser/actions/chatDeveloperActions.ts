import { Schemas } from '../../../../../base/common/network.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../../../common/services.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { DebugAgentHostInDevToolsAction } from './debugAgentHostAction.js';
import { registerNetworkDiagnosticsAction } from './networkDiagnosticsAction.js';
import { ProfileAgentHostAction, StopAgentHostProfileAction } from './profileAgentHostAction.js';
import { RestartLocalAgentHostAction } from './restartAgentHostAction.js';

export function registerChatDeveloperActions(): void {
	registerAction2(OpenChatStorageFolderAction);
	registerAction2(RestartLocalAgentHostAction);
	registerAction2(DebugAgentHostInDevToolsAction);
	registerAction2(ProfileAgentHostAction);
	registerAction2(StopAgentHostProfileAction);
	registerNetworkDiagnosticsAction();
}

class OpenChatStorageFolderAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.openStorageFolder',
			title: localize2('chat.developer.openStorageFolder', 'Open Local Chat Storage Folder'),
			category: localize2('debugLogs.developer', 'Developer'),
			f1: true,
			precondition: ChatContextKeys.enabled.isEqualTo(true),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		if (accessor.get(IConfigurationService).getValue<boolean>(ChatAIDisabledSettingId)) {
			return;
		}
		// The native host supplies the local profile even when the workspace is remote.
		const profile = accessor.get(IWorkbenchEnvironmentService).userRoamingDataHome;
		if (profile?.scheme !== Schemas.file) {
			throw new Error(localize('chat.developer.storageUnavailable', 'The local Chat storage folder is unavailable.'));
		}
		await accessor.get(INativeHostService).revealFile(profile.fsPath);
	}
}
