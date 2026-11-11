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

/** Renders web sources in the action row and code matches in a separate disclosure. */
export class ChatResponseCitationsContentPart extends Disposable {
	private readonly webContent = this._register(new DisposableStore());
	private readonly codeContent = this._register(new MutableDisposable<DisposableStore>());
	private citations: readonly ResponseCitation[] | undefined;
	private webLinks: readonly (readonly [string, string])[] = [];
	private codeMatches: ChatCodeCitationContentPart | undefined;

	constructor(
		private readonly row: HTMLElement,
		private readonly web: HTMLElement,
		private readonly openLink: (url: string) => void,
		private readonly onDidChangeHeight: () => void,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this._register(toDisposable(() => this.web.remove()));
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
		if (!this.webLinks.length && !this.codeMatches && !links.size && !matches.length) return false;
		const document = this.row.ownerDocument;
		const active = document.activeElement;
		const hadFocus = this.web.contains(active) || this.codeMatches?.domNode.contains(active);
		beforeLayout?.();
		this.renderWebSources([...links]);
		if (matches.length) {
			if (!this.codeMatches) {
				const lifetime = this.codeContent.value = new DisposableStore();
				this.codeMatches = lifetime.add(new ChatCodeCitationContentPart(document, this.openLink));
				lifetime.add(this.codeMatches.onDidChangeHeight(this.onDidChangeHeight));
				this.row.append(this.codeMatches.domNode);
			}
			this.codeMatches.render(matches);
		} else {
			this.codeMatches = undefined;
			this.codeContent.clear();
		}
		if (hadFocus && document.activeElement === document.body) {
			const target = this.web.querySelector('button') ?? this.codeMatches?.domNode.querySelector('summary') ?? this.row;
			target.focus({ preventScroll: true });
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
