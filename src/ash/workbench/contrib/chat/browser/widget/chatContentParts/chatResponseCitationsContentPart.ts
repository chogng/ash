import './media/chatResponseCitationsContentPart.css';
import { h } from '../../../../../../base/browser/dom.js';
import { appendIcon } from '../../../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { equals } from '../../../../../../base/common/objects.js';
import { localize } from '../../../../../../nls.js';
import type { ResponseCitation } from '../../../../../../platform/agentHost/common/agent.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { chatCitationClass } from '../chatMarkdownRichContent.js';
import { ChatCodeCitationContentPart } from './chatCodeCitationContentPart.js';
import { ChatMarkdownDecorationsRenderer } from './chatMarkdownDecorationsRenderer.js';
import { createChatLinkPreviewRow } from './chatRichLink.js';

type CodeCitation = Extract<ResponseCitation, { type: 'code'; }>;

/** Presents provider-attributed sources after the response body. */
export class ChatResponseCitationsContentPart extends Disposable {
	private readonly webContent = this._register(new DisposableStore());
	private readonly codeContent = this._register(new MutableDisposable<DisposableStore>());
	private readonly domNode: HTMLElement;
	private readonly web: HTMLElement;
	private citations: readonly ResponseCitation[] | undefined;
	private webLinks: readonly (readonly [string, string])[] = [];
	private codeMatches: ChatCodeCitationContentPart | undefined;

	constructor(
		private readonly body: HTMLElement,
		private readonly row: HTMLElement,
		private readonly openLink: (url: string) => void,
		private readonly onDidChangeHeight: () => void,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.domNode = h(body.ownerDocument, 'div', { className: 'ash-chat-response-citations' });
		this.web = h(body.ownerDocument, 'div');
		this.web.hidden = true;
		this.domNode.append(this.web);
		this._register(toDisposable(() => this.domNode.remove()));
	}

	render(citations: readonly ResponseCitation[] | undefined, beforeLayout?: () => void): boolean {
		if (equals(this.citations, citations)) return false;
		this.citations = citations;
		const links = new Map<string, string>();
		const matches: CodeCitation[] = [];
		for (const citation of citations ?? []) {
			const url = URL.parse(citation.url);
			if (!url || !['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) continue;
			if (citation.type === 'web') {
				if (!links.has(url.href)) links.set(url.href, citation.title);
			} else {
				matches.push({ ...citation, url: url.href });
			}
		}
		const document = this.domNode.ownerDocument;
		const active = document.activeElement;
		const hadFocus = this.domNode.contains(active);
		if (!this.domNode.parentElement && !links.size && !matches.length) return false;
		beforeLayout?.();
		this.renderWebSources([...links]);
		if (matches.length) {
			if (!this.codeMatches) {
				const lifetime = this.codeContent.value = new DisposableStore();
				this.codeMatches = lifetime.add(new ChatCodeCitationContentPart(document, this.openLink));
				lifetime.add(this.codeMatches.onDidChangeHeight(this.onDidChangeHeight));
				this.domNode.append(this.codeMatches.domNode);
			}
			this.codeMatches.render(matches);
		} else {
			this.codeMatches = undefined;
			this.codeContent.clear();
		}
		if (links.size || matches.length) {
			if (!this.domNode.parentElement) this.body.append(this.domNode);
		} else {
			this.domNode.remove();
		}
		if (hadFocus && document.activeElement === document.body) {
			(this.domNode.querySelector<HTMLElement>('button, summary') ?? this.row).focus({ preventScroll: true });
		}
		return true;
	}

	private renderWebSources(links: readonly (readonly [string, string])[]): void {
		if (equals(this.webLinks, links)) return;
		this.webLinks = links;
		this.webContent.clear();
		this.web.replaceChildren();
		this.web.hidden = !links.length;
		if (links.length) {
			const document = this.web.ownerDocument;
			const citation = h(document, 'span', { className: chatCitationClass });
			const label = h(document, 'span', { className: 'ash-chat-citation-label' });
			appendIcon(Lxicon.link, label);
			label.append(localize('chat.responseCitations.sources', 'Sources ({0})', links.length));
			const chevron = h(document, 'span', { className: 'ash-chat-citation-chevron' });
			appendIcon(Lxicon.chevronDown, chevron);
			label.append(chevron);
			const list = h(document, 'span', { className: 'ash-chat-citation-list' });
			for (const [href, title] of links) list.append(createChatLinkPreviewRow(document, href, title));
			citation.append(label, list);
			this.web.append(citation);
			this.webContent.add(this.instantiationService.createInstance(ChatMarkdownDecorationsRenderer, this.web, this.openLink));
		}
	}
}
