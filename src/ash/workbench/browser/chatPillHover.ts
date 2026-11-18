import './media/chatPillHover.css';
import { h } from '../../base/browser/dom.js';
import type { HoverContentValue } from '../../base/browser/ui/hover/hover.js';
import { CancellationToken } from '../../base/common/cancellation.js';
import { DisposableStore, type IDisposable } from '../../base/common/lifecycle.js';

interface IChatPillHoverContent {
	readonly element: HTMLElement;
	readonly disposable?: IDisposable;
}

interface IChatPillHoverContentProvider {
	readonly fallback: string;
	readonly sizing?: 'content' | 'preview';
	readonly createContent: () => IChatPillHoverContent | undefined;
}

/** Binds a pill preview to the Workbench hover's current opening. */
export function createChatPillHover(provider: IChatPillHoverContentProvider): (token: CancellationToken) => HoverContentValue {
	return token => {
		// The native title delegate needs text and does not own a content lifetime.
		if (token === CancellationToken.None) return provider.fallback;
		if (token.isCancellationRequested) return undefined;

		const content = provider.createContent();
		if (!content) return provider.fallback;
		if (content.disposable) {
			const resources = new DisposableStore();
			resources.add(content.disposable);
			resources.add(token.onCancellationRequested(() => resources.dispose()));
		}
		const element = h(content.element.ownerDocument, 'div', {
			className: 'ash-chat-pill-hover-content',
		}, content.element);
		element.classList.toggle('preview-sized', provider.sizing === 'preview');
		return element;
	};
}
