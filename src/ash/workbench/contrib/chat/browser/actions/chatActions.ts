import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IMessageHistoryService } from '../../../../../platform/messageHistory/common/messageHistory.js';
import { localize, localize2 } from '../../../../../nls.js';

export function registerChatActions(): void {
	registerAction2(class ClearChatInputHistoryAction extends Action2 {
		constructor() {
			super({ id: 'workbench.action.chat.clearInputHistory', title: localize2('chat.history.clear', 'Clear Input History'), category: localize2('chat.category', 'Chat'), f1: true });
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const history = accessor.get(IMessageHistoryService);
			if (!history) throw new Error(localize('chat.history.unavailable', 'Input history is unavailable on this connection.'));
			await history.clear();
		}
	});
}
