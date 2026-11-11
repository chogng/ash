import { h } from '../../../../../../base/browser/dom.js';
import { appendIcon } from '../../../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../nls.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import type { PlanUpdate } from '../../../../../services/chat/common/chatService.js';
import { ChatContentMarkdownRenderer } from '../chatContentMarkdownRenderer.js';
import './media/chatTodoListWidget.css';

/** Displays the Turn's current plan as steps and their execution status. */
export class ChatTodoListWidget extends Disposable {
	readonly domNode: HTMLElement;
	private readonly explanation: HTMLElement;
	private readonly list: HTMLOListElement;
	private readonly markdown: ChatContentMarkdownRenderer;
	private readonly renderedExplanation = this._register(new MutableDisposable());
	private explanationText: string | undefined;

	constructor(document: Document, private readonly openLink: ((href: string) => void) | undefined, @IInstantiationService instantiation: IInstantiationService) {
		super();
		this.markdown = this._register(instantiation.createInstance(ChatContentMarkdownRenderer));
		this.explanation = h(document, 'div', { className: 'ash-chat-plan-explanation', attributes: { hidden: '' } });
		this.list = h(document, 'ol', { className: 'ash-chat-plan-steps', attributes: { role: 'list' } });
		this.domNode = h(document, 'div', { className: 'ash-chat-plan' }, this.explanation, this.list);
	}

	render(plan: PlanUpdate): void {
		const explanation = plan.explanation ?? undefined;
		if (explanation !== this.explanationText) {
			this.explanationText = explanation;
			this.explanation.replaceChildren();
			this.renderedExplanation.clear();
			if (explanation) {
				const rendered = this.markdown.render({ value: explanation }, { ownerDocument: this.explanation.ownerDocument, actionHandler: this.openLink });
				this.renderedExplanation.value = rendered;
				this.explanation.append(rendered.element);
			}
			this.explanation.hidden = !explanation;
		}
		this.list.hidden = !plan.steps.length;
		const document = this.list.ownerDocument;
		const rows = plan.steps.map(({ step, status }) => {
			const row = h(document, 'li', { className: 'ash-chat-plan-step' });
			row.dataset.status = status;
			if (status === 'inProgress') row.setAttribute('aria-current', 'step');
			const icon = status === 'completed' ? Lxicon.check : status === 'inProgress' ? Lxicon.play : Lxicon.ellipsis;
			appendIcon(icon, row);
			const statusText = status === 'completed' ? localize('chat.plan.stepCompleted', 'Completed')
				: status === 'inProgress' ? localize('chat.plan.stepInProgress', 'In progress')
					: localize('chat.plan.stepPending', 'Pending');
			row.append(h(document, 'span', { className: 'ash-chat-plan-status' }, statusText), ' ', h(document, 'span', step));
			return row;
		});
		this.list.replaceChildren(...rows);
	}
}
