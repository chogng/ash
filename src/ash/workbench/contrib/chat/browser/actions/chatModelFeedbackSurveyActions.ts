import { localize, localize2 } from '../../../../../nls.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IIssueFormService, IssueType, IWorkbenchIssueService, type IssueReporterData } from '../../../issue/common/issue.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { isChatResponseFeedbackTarget } from '../../common/chatResponseFeedback.js';
import { IChatWidgetService, unwrapChatResponseActionContext } from '../chat.js';
import { CHAT_CATEGORY } from './chatActions.js';

export const ChatModelFeedbackSurveyActionId = 'workbench.action.chat.openModelFeedbackSurvey';

/** Ash feedback is an editable product report; opening it never submits a survey or a vote. */
export function registerChatModelFeedbackSurveyActions(): void {
	registerAction2(class OpenModelFeedbackSurveyAction extends Action2 {
		private readonly opening = new WeakSet<IWorkbenchIssueService>();

		constructor() {
			super({
				id: ChatModelFeedbackSurveyActionId,
				category: CHAT_CATEGORY,
				title: localize2('chat.modelFeedback.open', 'Give Model Feedback...'),
				shortTitle: localize2('chat.modelFeedback.messageAction', 'Give model feedback'),
				icon: Lxicon.comment,
				f1: true,
				precondition: ChatContextKeys.enabled.isEqualTo(true),
				menu: {
					id: MenuId.ChatMessageFooter,
					group: '2_feedback',
					order: 3,
					when: ContextKeyExpr.and(ChatContextKeys.enabled.isEqualTo(true), ChatContextKeys.responseHasFeedbackSurvey.isEqualTo(true)),
				},
			});
		}

		override async run(accessor: ServicesAccessor, target?: unknown): Promise<void> {
			target = unwrapChatResponseActionContext(target);
			if (accessor.get(IConfigurationService).getValue<boolean>(ChatAIDisabledSettingId)) return;
			const sourceFromMenu = target && typeof target === 'object' && 'type' in target && target.type === 'agentMessage'
				&& 'canGiveModelFeedback' in target && target.canGiveModelFeedback === true
				&& 'transient' in target && target.transient === false && !('isError' in target && target.isError)
				&& 'feedbackSource' in target ? target.feedbackSource : undefined;
			const sourceArg = sourceFromMenu ?? target;
			const explicit = isChatResponseFeedbackTarget(sourceArg) ? sourceArg : undefined;
			if (target !== undefined && !explicit) return;
			const form = accessor.get(IIssueFormService);
			const reporter = accessor.get(IWorkbenchIssueService);
			if (this.opening.has(reporter)) return;
			if (form.state.submitting || form.state.createdIssue || form.state.issueTitle.trim() || form.state.issueBody.trim()) {
				accessor.get(INotificationService).info(localize('chat.modelFeedback.existingDraft', 'Finish or clear the existing issue report before starting model feedback.'));
				await this.openReporter(reporter);
				return;
			}
			const widgets = accessor.get(IChatWidgetService);
			const widget = explicit ? widgets.getAllWidgets().find(candidate => candidate.visible
				&& candidate.sessionId === explicit.sessionId && candidate.threadId === explicit.threadId) : widgets.lastFocusedWidget;
			if (!widget?.visible) return;
			const source = explicit ?? widget.getFocus()?.feedbackSource;
			// An existing reply retains its own model when the composer selection changes.
			const model = source
				? widget.threadId === source.threadId ? widget.model?.thread?.turns.find(turn => turn.turnId === source.turnId
					&& (!explicit || (turn.status === 'completed' && turn.items.some(item => item.type === 'agentMessage' && item.itemId === explicit.itemId))))?.model : undefined
				: widget.model?.inputState.selectedModel;
			if (!model) throw new Error(localize('chat.modelFeedback.noModel', 'Select a model in Chat, or focus a completed reply with a known model, before giving model feedback.'));
			await this.openReporter(reporter, {
				issueType: IssueType.Bug,
				issueTitle: localize('chat.modelFeedback.title', 'Model feedback: {0}', model.model),
				issueBody: [
					localize('chat.modelFeedback.connection', 'Connection: {0}', model.provider),
					localize('chat.modelFeedback.model', 'Model: {0}', model.model),
					'', localize('chat.modelFeedback.description', 'Describe the model behavior, the expected result, and how to reproduce it.'),
				].join('\n'),
			});
		}

		private async openReporter(reporter: IWorkbenchIssueService, data?: Partial<IssueReporterData>): Promise<void> {
			this.opening.add(reporter);
			try {
				await reporter.openReporter(data);
			} finally {
				this.opening.delete(reporter);
			}
		}
	});
}
