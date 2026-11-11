import './media/chatConfirmationWidget.css';
import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

/** Hosts native confirmation forms so Enter and accessibility commands share submission. */
export class ChatConfirmationWidget extends Disposable {
	readonly domNode: HTMLFormElement;

	constructor(document: Document) {
		super();
		this.domNode = h(document, 'form', { className: 'ash-chat-interaction-form' });
	}

	setActions(cancelLabel: string, submitLabel: string, onCancel: () => Promise<void>, onSubmit: () => Promise<void>): void {
		const document = this.domNode.ownerDocument;
		const cancel = h(document, 'button', { className: 'ash-chat-secondary-button', attributes: { type: 'button' } }, cancelLabel);
		const submit = h(document, 'button', { className: 'ash-chat-send-button', attributes: { type: 'submit' } }, submitLabel);
		this.domNode.append(h(document, 'div', { className: 'ash-chat-interaction-actions' }, cancel, submit));
		this._register(addDisposableListener(cancel, 'click', () => { void onCancel().catch(() => undefined); }));
		this._register(addDisposableListener(this.domNode, 'submit', event => {
			event.preventDefault();
			if (this.domNode.reportValidity()) void onSubmit().catch(() => undefined);
		}));
	}
}
