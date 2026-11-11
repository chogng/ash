import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import type { UserInputQuestion } from '../../../../../../platform/agentHost/common/agent.js';
import { isChatQuestionAnswerValid } from '../../../common/model/chatQuestionValidation.js';
import './media/chatQuestionAnswerEditor.css';

export interface ChatQuestionAnswerDraft {
	readonly choice?: number;
	readonly text: string;
}

/** Owns the native controls for a single question, including custom-answer validity. */
export class ChatQuestionAnswerEditor extends Disposable {
	readonly domNode: HTMLElement;
	readonly read: () => string;

	constructor(document: Document, question: UserInputQuestion, saved: ChatQuestionAnswerDraft | undefined, save: (draft: ChatQuestionAnswerDraft) => void, multiline = false) {
		super();
		const prompt = question.header && question.header !== question.question
			? localize('chat.interaction.questionPrompt', '{0} — {1}', question.header, question.question)
			: question.question;
		const label = h(document, 'label', prompt);
		this.domNode = h(document, 'div', { className: 'ash-chat-question-answer' }, label);
		const options = question.options;
		if (!options?.length) {
			const input = multiline ? h(document, 'textarea', { properties: { rows: 2 } }) : h(document, 'input');
			input.name = question.id;
			input.required = question.required;
			input.value = saved?.text ?? '';
			label.append(input);
			this.validate(input, question);
			this._register(addDisposableListener(input, 'input', () => save({ text: input.value })));
			this.read = () => input.value;
			return;
		}

		const select = h(document, 'select');
		select.name = question.id;
		select.required = question.required;
		const unanswered = h(document, 'option', question.required
			? localize('chat.interaction.chooseAnswer', 'Choose an answer')
			: localize('chat.interaction.unanswered', 'No answer'));
		unanswered.value = '';
		unanswered.disabled = question.required;
		select.append(unanswered);
		for (const option of options) {
			const element = h(document, 'option', option.description && option.description !== option.label
				? localize('chat.interaction.optionDescription', '{0} — {1}', option.label, option.description)
				: option.label);
			element.value = option.label;
			select.append(element);
		}
		label.append(select);
		if (!question.allowFreeForm) {
			select.selectedIndex = Math.min(saved?.choice ?? 0, select.length - 1);
			this._register(addDisposableListener(select, 'change', () => save({ choice: select.selectedIndex, text: '' })));
			this.read = () => select.value;
			return;
		}

		const custom = h(document, 'option', localize('chat.interaction.customOption', 'Enter a custom answer'));
		custom.value = 'custom';
		select.append(custom);
		const input = h(document, 'input');
		input.value = saved?.text ?? '';
		const customLabel = h(document, 'label', localize('chat.interaction.customAnswer', 'Custom answer for {0}', prompt), input);
		this.domNode.append(h(document, 'div', customLabel));
		const customField = customLabel.parentElement!;
		const isCustom = () => select.selectedIndex === custom.index;
		const updateCustomInput = () => {
			customField.hidden = !isCustom();
			input.disabled = !isCustom();
			input.required = isCustom();
		};
		select.selectedIndex = Math.min(saved?.choice ?? 0, select.length - 1);
		updateCustomInput();
		this.validate(input, question);
		const saveDraft = () => save({ choice: select.selectedIndex, text: input.value });
		this._register(addDisposableListener(select, 'change', () => { updateCustomInput(); saveDraft(); }));
		this._register(addDisposableListener(input, 'input', saveDraft));
		this.read = () => isCustom() ? input.value : select.value;
	}

	private validate(input: HTMLInputElement | HTMLTextAreaElement, question: UserInputQuestion): void {
		const { validation } = question;
		if (!validation) return;
		const update = () => {
			const invalid = input.value !== '' && !isChatQuestionAnswerValid(input.value, validation);
			input.setCustomValidity(invalid ? localize('chat.interaction.invalidAnswer', 'Enter an answer that matches the requested type and limits.') : '');
		};
		update();
		this._register(addDisposableListener(input, 'input', update));
	}
}
