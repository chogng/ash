import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { isChatResponseFeedbackTarget, markResponseHelpful, setResponseVote } from '../../common/chatResponseFeedback.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IsSessionsWindowContext } from '../../../../common/contextkeys.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { getCompletedChatResponseSource } from '../../common/model/chatViewModel.js';
import { ChatResponseActionContext, IChatWidgetService } from '../chat.js';

export const MarkHelpfulActionId = 'workbench.action.chat.markHelpful';
const canVote = ContextKeyExpr.and(IsSessionsWindowContext.isEqualTo(true), ChatContextKeys.responseHasConversationLink.isEqualTo(true));

export function registerChatTitleActions(): DisposableStore {
	const registrations = new DisposableStore();
	registrations.add(registerAction2(class MarkHelpfulAction extends Action2 {
		constructor() {
			super({
				id: MarkHelpfulActionId, title: localize2('chat.response.good', 'Good response'), icon: Lxicon.thumbsup,
				toggled: ChatContextKeys.responseVote.isEqualTo('up'),
				menu: { id: MenuId.ChatMessageFooter, group: '2_feedback', order: 1, when: canVote },
			});
		}
		override run(accessor: ServicesAccessor, target?: unknown): boolean {
			if (target instanceof ChatResponseActionContext) {
				const source = target.visible && getCompletedChatResponseSource(target.item);
				if (!source) return false;
				const saved = markResponseHelpful(accessor.get(IStorageService), source);
				if (saved) status(localize('chat.response.helpfulSaved', 'Marked helpful in Ash.'));
				return saved;
			}
			if (!isChatResponseFeedbackTarget(target)) throw new TypeError(localize('chat.response.feedbackInvalid', 'A completed Chat response is required.'));
			return markResponseHelpful(accessor.get(IStorageService), target);
		}
	}));
	registrations.add(registerAction2(class MarkUnhelpfulAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.markUnhelpful', title: localize2('chat.response.bad', 'Bad response'), icon: Lxicon.thumbsdown,
				toggled: ChatContextKeys.responseVote.isEqualTo('down'),
				menu: { id: MenuId.ChatMessageFooter, group: '2_feedback', order: 2, when: canVote },
			});
		}
		override run(accessor: ServicesAccessor, target?: unknown): void {
			const source = target instanceof ChatResponseActionContext && target.visible && getCompletedChatResponseSource(target.item);
			if (source && setResponseVote(accessor.get(IStorageService), source, 'down')) {
				status(localize('chat.response.unhelpfulSaved', 'Marked unhelpful in Ash.'));
			}
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
