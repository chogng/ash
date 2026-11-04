import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import './media/promptTimeline.css';

/** Presents the pinned prompt. The transcript owns prompt selection and navigation. */
export class PromptTimelineStickyHeader extends Disposable {
	readonly domNode: HTMLButtonElement;
	private readonly label: HTMLSpanElement;
	private readonly count: HTMLSpanElement;
	private readonly _onDidActivate = this._register(new Emitter<void>());
	readonly onDidActivate = this._onDidActivate.event;

	constructor(viewport: HTMLElement) {
		super();
		this.domNode = viewport.ownerDocument.createElement('button');
		this.domNode.type = 'button';
		this.domNode.className = 'ash-chat-sticky-prompt';
		this.label = viewport.ownerDocument.createElement('span');
		this.label.className = 'ash-chat-sticky-prompt-label';
		this.count = viewport.ownerDocument.createElement('span');
		this.count.className = 'ash-chat-sticky-prompt-count';
		this.domNode.append(this.label, this.count);
		viewport.before(this.domNode);
		this._register(addDisposableListener(this.domNode, 'click', () => this._onDidActivate.fire()));
		this._register(toDisposable(() => this.domNode.remove()));
	}

	update(text: string, index: number, total: number): void {
		const label = text.replace(/\s+/gu, ' ').trim() || localize('chat.stickyScroll.emptyPrompt', 'User message');
		this.label.textContent = label;
		this.count.textContent = localize('chat.stickyScroll.position', '{0}/{1}', index, total);
		this.domNode.title = label;
		this.domNode.setAttribute('aria-label', localize('chat.stickyScroll.goToPrompt', 'Go to user message {0} of {1}: {2}', index, total, label));
	}

	setVisible(visible: boolean): void {
		this.domNode.classList.toggle('visible', visible);
	}
}
