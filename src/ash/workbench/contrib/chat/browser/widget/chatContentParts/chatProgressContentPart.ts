import { h } from '../../../../../../base/browser/dom.js';
import { observeIntersection } from '../../../../../../base/browser/observer.js';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ChatWorkingLogo } from '../chatWorkingLogo.js';
import './media/chatProgressContentPart.css';

/** Shows active Turn progress and keeps it visible while the transcript is scrolled away. */
export class ChatWorkingProgressContentPart extends Disposable {
	readonly domNode: HTMLElement;
	private readonly sticky: HTMLElement;
	private readonly logo: ChatWorkingLogo;
	private readonly label: HTMLElement;
	private outsideViewport = false;
	private visible = false;
	private working = false;

	constructor(transcript: HTMLElement, overlayHost: HTMLElement, scrollRoot: HTMLElement, @IInstantiationService instantiationService: IInstantiationService) {
		super();
		const document = transcript.ownerDocument;
		this.logo = this._register(instantiationService.createInstance(ChatWorkingLogo, document));
		this.label = h(document, 'span');
		this.domNode = h(document, 'div', { className: 'ash-chat-transcript-working' }, this.logo.domNode, this.label);
		this.sticky = h(document, 'div', {
			className: 'ash-chat-transcript-working ash-chat-transcript-working-sticky',
			attributes: { 'aria-hidden': 'true', hidden: '' },
		});
		transcript.append(this.domNode);
		overlayHost.append(this.sticky);
		this._register(toDisposable(() => { this.domNode.remove(); this.sticky.remove(); }));
		this._register(observeIntersection(this.domNode, entry => {
			this.outsideViewport = !entry.isIntersecting && entry.boundingClientRect.height > 0 && !!entry.rootBounds?.height;
			this.updateVisibility();
		}, { root: scrollRoot }));
	}

	setWorking(working: boolean): void {
		this.working = working;
		this.domNode.hidden = !working;
		this.logo.setActive(working);
		const text = working ? localize('chat.transcript.working', 'Working on your request…') : '';
		this.label.textContent = text;
		this.sticky.textContent = text;
		if (!working) this.outsideViewport = false;
		this.updateVisibility();
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.updateVisibility();
	}

	private updateVisibility(): void {
		this.logo.setVisible(this.visible && this.working);
		this.sticky.hidden = !this.visible || !this.working || !this.outsideViewport;
	}
}
