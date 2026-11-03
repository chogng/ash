import { localize2 } from '../../../../../nls.js';
import { Action2 } from '../../../../../platform/actions/common/actions.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { AgentSessionsWelcomeInput } from '../../../welcomeAgentSessions/browser/agentSessionsWelcomeInput.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';

export class OpenAgentSessionsWelcomeAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.openAgentSessionsWelcome',
			title: localize2('agentSessionsWelcome.open', 'Open Agent Sessions Welcome'),
			precondition: ChatContextKeys.enabled.isEqualTo(true),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		if (accessor.get(IConfigurationService).getValue<boolean>(ChatAIDisabledSettingId)) { return; }
		await accessor.get(IEditorService).openEditor(new AgentSessionsWelcomeInput());
	}
}
