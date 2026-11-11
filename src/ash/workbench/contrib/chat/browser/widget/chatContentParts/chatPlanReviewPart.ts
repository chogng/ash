import { h } from '../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import type { AgentInteractionDecision, RequestUserInput } from '../../../../../../platform/agentHost/common/agent.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ChatContentMarkdownRenderer } from '../chatContentMarkdownRenderer.js';
import { ChatConfirmationWidget } from './chatConfirmationWidget.js';
import { ChatQuestionAnswerEditor, type ChatQuestionAnswerDraft } from './chatQuestionAnswerEditor.js';
import './media/chatPlanReview.css';

/** Reviews a proposal using the same pending interaction and answer validation as other questions. */
export class ChatPlanReviewPart extends Disposable {
	readonly domNode: HTMLFormElement;

	constructor(
		document: Document,
		request: RequestUserInput,
		fields: Map<string, ChatQuestionAnswerDraft>,
		resolve: (response: AgentInteractionDecision) => Promise<void>,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		const review = request.planReview!;
		const form = this._register(new ChatConfirmationWidget(document));
		this.domNode = form.domNode;
		this.domNode.classList.add('ash-chat-plan-review');
		const title = localize('chat.planReview.title', 'Review proposed plan');
		const reason = request.questions.find(question => question.id === review.decisionQuestionId)?.question;
		const renderer = this._register(instantiation.createInstance(ChatContentMarkdownRenderer));
		const markdown = this._register(renderer.render({ value: review.markdown }, { ownerDocument: document }));
		const body = h(document, 'div', {
			className: 'ash-chat-plan-review-body',
			attributes: { role: 'region', 'aria-label': title, tabindex: '0', 'aria-live': 'off' },
		}, markdown.element);
		this.domNode.append(h(document, 'strong', title));
		if (reason) this.domNode.append(h(document, 'div', reason));
		this.domNode.append(body);
		const question = request.questions.find(question => question.id === review.feedbackQuestionId);
		const feedbackLabel = localize('chat.planReview.feedback', 'Changes to the plan (optional)');
		const feedback = question && this._register(new ChatQuestionAnswerEditor(document, {
			...question, header: feedbackLabel, question: feedbackLabel,
		}, fields.get(question.id), draft => fields.set(question.id, draft), true));
		if (feedback) this.domNode.append(feedback.domNode);

		let responding = false;
		const respond = async (value: string) => {
			if (responding || !this.domNode.reportValidity()) return;
			responding = true;
			try {
				const text = feedback?.read().trim();
				await resolve({
					type: 'userInput', response: {
						answers: {
							[review.decisionQuestionId]: { value },
							...(text ? { [review.feedbackQuestionId]: { value: text } } : {}),
						}
					}
				});
			} finally {
				responding = false;
			}
		};
		form.setActions(
			localize('chat.planReview.revise', 'Keep planning'),
			localize('chat.planReview.approve', 'Approve and continue'),
			() => respond(review.reviseValue),
			() => respond(review.approveValue),
		);
	}
}
