import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IIssueFormService, IssueType, IWorkbenchIssueService } from '../../../issue/common/issue.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { IChatWidgetService } from '../chat.js';
import { CHAT_CATEGORY } from './chatActions.js';

export const ChatModelFeedbackSurveyActionId = 'workbench.action.chat.openModelFeedbackSurvey';

/** Ash feedback is an editable product report; opening it never submits a survey or a vote. */
export function registerChatModelFeedbackSurveyActions(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({ id: ChatModelFeedbackSurveyActionId, category: CHAT_CATEGORY, title: localize2('chat.modelFeedback.open', 'Give Model Feedback...'), f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true) });
		}
		override async run(accessor: ServicesAccessor): Promise<void> {
			if (accessor.get(IConfigurationService).getValue<boolean>(ChatAIDisabledSettingId)) return;
			const form = accessor.get(IIssueFormService);
			const reporter = accessor.get(IWorkbenchIssueService);
			if (form.state.submitting || form.state.createdIssue || form.state.issueTitle.trim() || form.state.issueBody.trim()) {
				accessor.get(INotificationService).info(localize('chat.modelFeedback.existingDraft', 'Finish or clear the existing issue report before starting model feedback.'));
				await reporter.openReporter();
				return;
			}
			const widget = accessor.get(IChatWidgetService).lastFocusedWidget;
			if (!widget?.visible) return;
			const source = widget.getFocus()?.feedbackSource;
			// An existing reply retains its own model when the composer selection changes.
			const model = source
				? widget.threadId === source.threadId ? widget.model?.thread?.turns.find(turn => turn.turnId === source.turnId)?.model : undefined
				: widget.model?.inputState.selectedModel;
			if (!model) throw new Error(localize('chat.modelFeedback.noModel', 'Select a model in Chat, or focus a completed reply with a known model, before giving model feedback.'));
			await reporter.openReporter({
				issueType: IssueType.Bug,
				issueTitle: localize('chat.modelFeedback.title', 'Model feedback: {0}', model.model),
				issueBody: [
					localize('chat.modelFeedback.connection', 'Connection: {0}', model.provider),
					localize('chat.modelFeedback.model', 'Model: {0}', model.model),
					'', localize('chat.modelFeedback.description', 'Describe the model behavior, the expected result, and how to reproduce it.'),
				].join('\n'),
			});
		}
	});
}
