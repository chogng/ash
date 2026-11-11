import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import type { AgentInteractionDecision, RequestUserInput } from '../../../../../../platform/agentHost/common/agent.js';
import { ChatConfirmationWidget } from './chatConfirmationWidget.js';
import { ChatQuestionAnswerEditor, type ChatQuestionAnswerDraft } from './chatQuestionAnswerEditor.js';
import './media/chatQuestionCarousel.css';

/** Presents the current request and borrows the draft retained by the originating input. */
export class ChatQuestionCarouselPart extends Disposable {
	readonly domNode: HTMLFormElement;

	constructor(document: Document, request: RequestUserInput, fields: Map<string, ChatQuestionAnswerDraft>, resolve: (response: AgentInteractionDecision) => Promise<void>) {
		super();
		const form = this._register(new ChatConfirmationWidget(document));
		this.domNode = form.domNode;
		this.domNode.classList.add('ash-chat-questions');
		const editors = request.questions.map(question => {
			const editor = this._register(new ChatQuestionAnswerEditor(document, question, fields.get(question.id), value => fields.set(question.id, value)));
			this.domNode.append(editor.domNode);
			return { id: question.id, editor };
		});
		form.setActions(
			localize('chat.interaction.cancelQuestion', 'Cancel question'),
			localize('chat.interaction.submit', 'Submit answers'),
			() => resolve({ type: 'cancelUserInput' }),
			() => {
				const answers = Object.fromEntries(editors.flatMap(({ id, editor }) => {
					const value = editor.read();
					return value === '' ? [] : [[id, { value }]];
				}));
				return resolve({ type: 'userInput', response: { answers } });
			},
		);
	}
}
