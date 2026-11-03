import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import './media/promptTimeline.css';

/** Presents the pinned prompt. The transcript owns prompt selection and navigation. */
export class PromptTimelineStickyHeader extends Disposable {
	readonly domNode: HTMLButtonElement;
	private readonly _onDidActivate = this._register(new Emitter<void>());
	readonly onDidActivate = this._onDidActivate.event;

	constructor(viewport: HTMLElement) {
		super();
		this.domNode = viewport.ownerDocument.createElement('button');
		this.domNode.type = 'button';
		this.domNode.className = 'ash-chat-sticky-prompt';
		viewport.before(this.domNode);
		this._register(addDisposableListener(this.domNode, 'click', () => this._onDidActivate.fire()));
		this._register(toDisposable(() => this.domNode.remove()));
	}

	update(text: string): void {
		const label = text.replace(/\s+/gu, ' ').trim() || localize('chat.stickyScroll.emptyPrompt', 'User message');
		this.domNode.textContent = label;
		this.domNode.title = label;
		this.domNode.setAttribute('aria-label', localize('chat.stickyScroll.goToPrompt', 'Go to user message: {0}', label));
	}

	setVisible(visible: boolean): void {
		this.domNode.classList.toggle('visible', visible);
	}
}
