import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IMessageHistoryService } from '../../../../../platform/messageHistory/common/messageHistory.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import type { IAgentSession } from '../agentSessions/agentSessionsModel.js';
import { IAgentSessionsService } from '../agentSessions/agentSessionsService.js';
import { OpenAgentHostStateFileAction } from './openAgentHostStateFileAction.js';

function describeSession(session: IAgentSession): object {
	return {
		resource: session.resource.toString(), label: session.label, kind: session.kind, target: session.target,
		archived: session.isArchived(), pinned: session.isPinned(),
		children: session.children?.map(describeSession),
	};
}

export function registerChatDeveloperActions(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.logInputHistory',
				title: localize2('chat.developer.logInputHistory', 'Developer: Log Chat Input History'),
				f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true),
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const configuration = accessor.get(IConfigurationService);
			if (configuration.getValue<boolean>(ChatAIDisabledSettingId)) return;
			const history = accessor.get(IMessageHistoryService);
			if (!history) throw new Error(localize('chat.history.unavailable', 'Input history is unavailable on this connection.'));
			const log = accessor.get(ILogService);
			let before: string | undefined;
			do {
				const page = await history.read({ text: '', before, limit: 100 });
				if (configuration.getValue<boolean>(ChatAIDisabledSettingId)) return;
				// Profile history also serves terminals. This command reports Chat submissions only.
				const entries = page.entries.filter(entry => entry.kind !== 'shell');
				log.info('chat.inputHistory', JSON.stringify({ before, nextBefore: page.nextBefore, entries }));
				before = page.nextBefore;
			} while (before !== undefined);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.logChatIndex',
				title: localize2('chat.developer.logChatIndex', 'Developer: Log Chat Index'),
				f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true),
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const configuration = accessor.get(IConfigurationService);
			if (configuration.getValue<boolean>(ChatAIDisabledSettingId)) return;
			const model = accessor.get(IAgentSessionsService).model;
			const log = accessor.get(ILogService);
			await model.refresh?.();
			if (configuration.getValue<boolean>(ChatAIDisabledSettingId)) return;
			log.info('chat.index', JSON.stringify({ state: model.state, error: model.error, sessions: model.sessions.map(describeSession) }));
		}
	});

	registerAction2(OpenAgentHostStateFileAction);
}
