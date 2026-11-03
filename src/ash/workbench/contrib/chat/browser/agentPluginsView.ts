import { localize2 } from '../../../../nls.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { OPEN_EXTENSIONS_COMMAND_ID, type ExtensionsOpenOptions } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ChatContextKeys } from '../common/actions/chatContextKeys.js';
import { CHAT_CATEGORY } from './actions/chatActions.js';

export class AgentPluginsBrowseCommand extends Action2 {
	static readonly ID = 'workbench.action.chat.managePlugins';

	constructor() {
		super({
			id: AgentPluginsBrowseCommand.ID,
			title: localize2('chat.plugins.manage', 'Plugins'), category: CHAT_CATEGORY,
			f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		if (accessor.get(IConfigurationService).getValue<boolean>(ChatAIDisabledSettingId)) return;
		await accessor.get(ICommandService).executeCommand(OPEN_EXTENSIONS_COMMAND_ID, { query: '@plugins ' } satisfies ExtensionsOpenOptions);
	}
}
