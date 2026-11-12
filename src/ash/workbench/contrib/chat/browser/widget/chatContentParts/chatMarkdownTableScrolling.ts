import { h } from '../../../../../../base/browser/dom.js';
import { ScrollableElement } from '../../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { localize } from '../../../../../../nls.js';

export const chatMarkdownTableScrollClass = 'ash-chat-markdown-table-scroll';
const viewportClass = 'ash-chat-markdown-table-viewport';

/** Keep the semantic table in the shared viewport and its actions outside the clipping area. */
export function wrapTableWithScrollable(table: HTMLTableElement, direction: 'horizontal' | 'both' = 'horizontal'): ScrollableElement {
	const container = h(table.ownerDocument, 'div', { className: chatMarkdownTableScrollClass });
	const scrollable = new ScrollableElement(container, {
		direction,
		wheel: { scrollYToX: false },
		ariaLabel: localize('chat.markdown.tableScroll', 'Scrollable table'),
	});
	scrollable.scrollableElement.classList.add(viewportClass);
	// The ScrollableElement's region already owns the keyboard entry point.
	scrollable.scrollableElement.tabIndex = -1;
	table.before(container);
	scrollable.contentElement.append(table);
	return scrollable;
}

/** Reveal a Find match without scrolling the surrounding transcript horizontally. */
export function revealMarkdownTableRange(range: Range, rect: DOMRect): void {
	const element = range.startContainer.parentElement;
	const viewport = element?.closest<HTMLElement>(`.${viewportClass}`);
	if (!viewport) return;
	const bounds = viewport.getBoundingClientRect();
	const left = bounds.left + viewport.clientLeft;
	const right = left + viewport.clientWidth;
	if (rect.left < left) viewport.scrollLeft += rect.left - left;
	else if (rect.right > right) viewport.scrollLeft += Math.min(rect.left - left, rect.right - right);
}
