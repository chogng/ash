import { h } from '../../../../../../base/browser/dom.js';
import { localize } from '../../../../../../nls.js';

export const chatMarkdownTableScrollClass = 'ash-chat-markdown-table-scroll';

/** Keep the semantic table intact inside a native, keyboard-scrollable viewport. */
export function wrapTablesWithScrollable(root: HTMLElement): void {
	for (const table of root.querySelectorAll('table')) {
		if (table.parentElement?.classList.contains(chatMarkdownTableScrollClass)) continue;
		const viewport = h(root.ownerDocument, 'div', { className: chatMarkdownTableScrollClass });
		viewport.tabIndex = 0;
		viewport.setAttribute('role', 'region');
		viewport.setAttribute('aria-label', localize('chat.markdown.tableScroll', 'Scrollable table'));
		table.before(viewport);
		viewport.append(table);
	}
}

/** Reveal a Find match without scrolling the surrounding transcript horizontally. */
export function revealMarkdownTableRange(range: Range, rect: DOMRect): void {
	const element = range.startContainer.parentElement;
	const viewport = element?.closest<HTMLElement>(`.${chatMarkdownTableScrollClass}`);
	if (!viewport) return;
	const bounds = viewport.getBoundingClientRect();
	const left = bounds.left + viewport.clientLeft;
	const right = left + viewport.clientWidth;
	if (rect.left < left) viewport.scrollLeft += rect.left - left;
	else if (rect.right > right) viewport.scrollLeft += Math.min(rect.left - left, rect.right - right);
}
