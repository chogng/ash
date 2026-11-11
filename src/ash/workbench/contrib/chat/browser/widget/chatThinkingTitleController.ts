import type { IChatListItem } from '../../common/model/chatViewModel.js';
import { ChatAccessibilityProvider } from '../accessibility/chatAccessibilityProvider.js';

/** Keeps a live reasoning title stable while its body is receiving text. */
export class ChatThinkingTitleController {
	private readonly labels = new ChatAccessibilityProvider();
	private previousState: 'thinking' | 'complete' | undefined;

	constructor(private readonly disclosure: HTMLDetailsElement, private readonly title: HTMLElement) {
		title.setAttribute('aria-live', 'polite');
		title.setAttribute('aria-atomic', 'true');
	}

	update(item: IChatListItem): void {
		const state = item.transient ? 'thinking' : 'complete';
		const label = this.labels.getAriaLabel(item);
		if (this.previousState === state && this.title.textContent === label) return;
		this.previousState = state;
		if (item.transient) this.title.setAttribute('aria-busy', 'true');
		this.title.textContent = label;
		this.disclosure.dataset.state = state;
		if (!item.transient) this.title.setAttribute('aria-busy', 'false');
	}
}
