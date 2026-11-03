import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { isChatResponseFeedbackTarget, markResponseHelpful } from '../../common/chatResponseFeedback.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { IChatWidgetService } from '../chat.js';

export const MarkHelpfulActionId = 'workbench.action.chat.markHelpful';

export function registerChatTitleActions(): DisposableStore {
	const registrations = new DisposableStore();
	registrations.add(registerAction2(class MarkHelpfulAction extends Action2 {
		constructor() { super({ id: MarkHelpfulActionId, title: localize2('chat.response.helpful', 'Helpful') }); }
		override run(accessor: ServicesAccessor, target?: unknown): boolean {
			if (!isChatResponseFeedbackTarget(target)) throw new TypeError(localize('chat.response.feedbackInvalid', 'A completed Chat response is required.'));
			return markResponseHelpful(accessor.get(IStorageService), target);
		}
	}));
	registrations.add(registerAction2(class RetryChatAction extends Action2 {
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
	}));
	return registrations;
}
