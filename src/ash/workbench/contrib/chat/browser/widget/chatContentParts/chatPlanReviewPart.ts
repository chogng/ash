import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import type { URI } from '../../../../../../base/common/uri.js';
import { createUuid } from '../../../../../../base/common/uuid.js';
import { localize } from '../../../../../../nls.js';
import type { AgentInteractionDecision, RequestUserInput } from '../../../../../../platform/agentHost/common/agent.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IAgentEditorCommentsBridge, type IAgentEditorComment } from '../../../../../services/agentEditorComments/common/agentEditorComments.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { isChatQuestionAnswerValid } from '../../../common/model/chatQuestionValidation.js';
import { ChatContentMarkdownRenderer } from '../chatContentMarkdownRenderer.js';
import { ChatConfirmationWidget } from './chatConfirmationWidget.js';
import { ChatQuestionAnswerEditor, type ChatQuestionAnswerDraft } from './chatQuestionAnswerEditor.js';
import './media/chatPlanReview.css';

export interface PlanReviewDraft {
	readonly markdown: string;
	readonly resource: URI;
	readonly comments: Map<string, IAgentEditorComment>;
}

/** Reviews a proposal using the same pending interaction and answer validation as other questions. */
export class ChatPlanReviewPart extends Disposable {
	readonly domNode: HTMLFormElement;

	constructor(
		document: Document,
		request: RequestUserInput,
		fields: Map<string, ChatQuestionAnswerDraft>,
		draft: PlanReviewDraft,
		resolve: (response: AgentInteractionDecision) => Promise<void>,
		@IInstantiationService instantiation: IInstantiationService,
		@IAgentEditorCommentsBridge comments: IAgentEditorCommentsBridge,
		@IEditorService editors: IEditorService,
		@INotificationService notifications: INotificationService,
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
		const error = h(document, 'div', {
			attributes: { role: 'alert' },
			properties: { hidden: true },
		}, localize('chat.planReview.feedbackLimit', 'Plan feedback exceeds the allowed length. Shorten the overall feedback or delete a line comment.'));
		if (question) {
			const change = this._register(new Emitter<void>());
			this._register(comments.registerProvider(draft.resource, {
				onDidChangeComments: change.event,
				getComments: () => [...draft.comments.values()],
				addComment: (range, body) => {
					const text = body.trim();
					if (responding || !text) return false;
					const id = createUuid();
					draft.comments.set(id, { id, resource: draft.resource, range, body: text });
					change.fire();
					return true;
				},
				deleteComment: id => {
					if (!responding && draft.comments.delete(id)) change.fire();
				},
			}));
			const open = h(document, 'button', {
				className: 'ash-chat-secondary-button',
				properties: { type: 'button' },
			});
			const update = () => {
				open.textContent = draft.comments.size
					? localize('chat.planReview.openEditorWithComments', 'Open plan in editor (Comments: {0})', draft.comments.size)
					: localize('chat.planReview.openEditor', 'Open plan in editor');
				error.hidden = true;
			};
			update();
			this._register(change.event(update));
			this._register(addDisposableListener(open, 'click', () => {
				void editors.openEditor({
					resource: draft.resource,
					label: title,
					initialText: draft.markdown,
					readOnly: true,
					languageId: 'markdown',
				}, { pinned: true }).catch(failure => notifications.error(failure));
			}));
			this._register(addDisposableListener(this.domNode, 'input', () => { error.hidden = true; }));
			this.domNode.append(open, error);
		}
		const respond = async (value: string) => {
			if (responding || !this.domNode.reportValidity()) return;
			const comments = [...draft.comments.values()].sort((first, second) => first.range.startLineNumber - second.range.startLineNumber || first.range.startColumn - second.range.startColumn);
			const text = [feedback?.read().trim(), ...comments.map(comment => {
				const { startLineNumber, endLineNumber, startColumn, endColumn } = comment.range;
				const location = startLineNumber === endLineNumber && startColumn === endColumn
					? `L${startLineNumber}`
					: `L${startLineNumber}:${startColumn}–L${endLineNumber}:${endColumn}`;
				return `[${location}] ${comment.body}`;
			})].filter(Boolean).join('\n\n');
			if (text && question?.validation && !isChatQuestionAnswerValid(text, question.validation)) {
				error.hidden = false;
				return;
			}
			responding = true;
			try {
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
