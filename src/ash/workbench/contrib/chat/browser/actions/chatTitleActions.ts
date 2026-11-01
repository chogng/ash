import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { IChatWidgetService } from '../chat.js';

export function registerChatTitleActions(): IDisposable {
	return registerAction2(class RetryChatAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.retry', title: localize2('chat.retry.command', 'Chat: Retry Failed Request'),
				f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true)
			});
		}
		public override async run(accessor: ServicesAccessor): Promise<void> {
			const widget = accessor.get(IChatWidgetService).lastFocusedWidget;
			if (widget?.visible) { await widget.retryFailedTurn(); }
		}
	});
}
