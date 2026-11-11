import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { equals } from '../../../../../../base/common/objects.js';
import { localize } from '../../../../../../nls.js';
import type { ResponseCitation } from '../../../../../../platform/agentHost/common/agent.js';
import { ChatCollapsibleContentPart } from './chatCollapsibleContentPart.js';

type CodeCitation = Extract<ResponseCitation, { type: 'code'; }>;

/** Keeps matching code and its license together in one keyboard-accessible disclosure. */
export class ChatCodeCitationContentPart extends ChatCollapsibleContentPart {
	private readonly links = this._register(new DisposableStore());
	private readonly list: HTMLUListElement;
	private citations: readonly CodeCitation[] = [];

	constructor(document: Document, private readonly openLink: (url: string) => void) {
		super(document, 'ash-chat-code-citations');
		this.list = h(document, 'ul');
		this.domNode.append(this.list);
	}

	render(citations: readonly CodeCitation[]): void {
		if (equals(this.citations, citations)) return;
		this.citations = citations;
		const document = this.domNode.ownerDocument;
		const focusedLink = this.list.contains(document.activeElement)
			? document.activeElement?.getAttribute('href')
			: undefined;
		this.summary.textContent = localize('chat.responseCitations.codeMatches', 'Code matches ({0})', citations.length);
		this.links.clear();
		this.list.replaceChildren();
		let replacement: HTMLAnchorElement | undefined;
		for (const citation of citations) {
			const item = h(document, 'li');
			const license = h(document, 'div', { className: 'ash-chat-code-citation-license' });
			const name = citation.license.trim();
			license.textContent = name && name !== 'NOASSERTION'
				? localize('chat.responseCitations.license', 'License: {0}', name)
				: localize('chat.responseCitations.unknownLicense', 'Unknown license');
			const link = h(document, 'a', { attributes: { href: citation.url } });
			link.textContent = citation.url;
			this.links.add(addDisposableListener(link, 'click', event => {
				event.preventDefault();
				this.openLink(citation.url);
			}));
			if (focusedLink === citation.url) replacement ??= link;
			const snippet = h(document, 'code');
			snippet.textContent = citation.snippet;
			const pre = h(document, 'pre');
			pre.append(snippet);
			item.append(license, link, pre);
			this.list.append(item);
		}
		if (focusedLink && document.activeElement === document.body) {
			(replacement ?? this.summary).focus({ preventScroll: true });
		}
	}
}
