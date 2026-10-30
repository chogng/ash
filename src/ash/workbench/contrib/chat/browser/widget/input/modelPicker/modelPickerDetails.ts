import { getActiveDocument, h } from '../../../../../../../base/browser/dom.js';
import { renderMarkdown } from '../../../../../../../base/browser/markdownRenderer.js';
import { MarkdownString } from '../../../../../../../base/common/htmlContent.js';
import type { DisposableStore } from '../../../../../../../base/common/lifecycle.js';
import type { URI } from '../../../../../../../base/common/uri.js';
import { localize } from '../../../../../../../nls.js';
import type { IOpenerService } from '../../../../../../../platform/opener/common/opener.js';

export function getMaxContextLabel(): string {
	return localize('chat.modelPicker.maxContext', 'Max context');
}

/** The caller owns a supplied target; the store owns rendering resources and link handlers. */
export function renderModelDescription(
	tooltip: string,
	openerService: IOpenerService,
	store: DisposableStore,
	learnMoreUrl?: URI,
	target?: HTMLElement,
): { readonly element: HTMLElement; readonly learnMoreLink: HTMLAnchorElement | undefined; } {
	const document = target?.ownerDocument ?? getActiveDocument();
	// Preserve literal catalog text in angle brackets while allowing ordinary Markdown formatting.
	const markdown = new MarkdownString(tooltip.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
	const rendered = store.add(renderMarkdown(markdown, {
		ownerDocument: document,
		sanitizerConfig: { remoteImageIsAllowed: () => false },
		actionHandler: href => { void openerService.open(href, { allowCommands: false, fromUserGesture: true }); },
	}, target));
	let learnMoreLink: HTMLAnchorElement | undefined;
	if (learnMoreUrl) {
		learnMoreLink = h(document, 'a');
		learnMoreLink.href = learnMoreUrl.toString();
		learnMoreLink.textContent = localize('chat.modelPicker.learnMore', 'Learn more');
		let paragraph = rendered.element.lastElementChild;
		if (paragraph?.tagName !== 'P') {
			paragraph = h(document, 'p');
			rendered.element.append(paragraph);
		}
		if (paragraph.textContent) { paragraph.append(document.createTextNode(' ')); }
		paragraph.append(learnMoreLink);
	}
	return { element: rendered.element, learnMoreLink };
}
