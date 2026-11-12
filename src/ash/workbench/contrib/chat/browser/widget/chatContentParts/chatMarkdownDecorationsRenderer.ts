import { addDisposableListener } from '../../../../../../base/browser/dom.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../../base/browser/ui/contextview/contextview.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../../../base/common/lifecycle.js';
import { ILinkPresentationService } from '../../../../../../platform/dataChannel/common/dataChannel.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hoverService.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { chatCitationClass, chatCitationLinkClass, chatExternalLinkClass, chatSourcePreviewClass } from '../chatMarkdownRichContent.js';
import { InlineAnchorWidget, renderFileAnchor } from './chatInlineAnchorWidget.js';
import { bindChatLinkPreviewActivation, ChatRichLinkDecorator, createChatLinkPreview } from './chatRichLink.js';

export const chatCitationButtonClass = 'ash-chat-citation-button';

/** Tracks the decorations attached to one response's sanitized Markdown. */
export class ChatMarkdownDecorationsRenderer extends Disposable {
	private readonly bindings = this._register(new DisposableMap<HTMLElement>());
	private readonly richLinks: ChatRichLinkDecorator;

	constructor(
		private readonly root: HTMLElement,
		private readonly openLink: (href: string) => void,
		@ILinkPresentationService private readonly links: ILinkPresentationService,
		@IHoverService private readonly hoverService: IHoverService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		this.richLinks = this._register(instantiation.createInstance(ChatRichLinkDecorator, openLink));
		this._register(links.onDidChangeLinkPresentationRules(() => {
			for (const element of this.bindings.keys()) {
				if (element.tagName === 'A' && !element.classList.contains(InlineAnchorWidget.className)) this.bindings.deleteAndDispose(element);
			}
			this.reconcile();
		}));
		this.reconcile();
	}

	reconcile(): void {
		for (const anchor of this.bindings.keys()) {
			if (!this.root.contains(anchor)) this.bindings.deleteAndDispose(anchor);
		}
		this.bind(this.root.querySelectorAll<HTMLElement>(this.selector));
	}

	applyPatch(removed: readonly ChildNode[], added: readonly ChildNode[]): void {
		if (this.bindings.size) {
			for (const element of matchingElements(removed, `a, .${chatCitationClass}`)) this.bindings.deleteAndDispose(element);
		}
		this.bind(matchingElements(added, this.selector));
	}

	decorateLink(anchor: HTMLAnchorElement): void {
		if (this.bindings.has(anchor)) return;
		const href = anchor.getAttribute('href');
		if (!href) return;
		const binding = this.bindAnchor(anchor, href);
		if (binding) this.bindings.set(anchor, binding);
	}

	/** Bind citations in a rendered copy, with a lifetime independent of the transcript. */
	bindCitations(root: HTMLElement): IDisposable {
		const bindings = new DisposableStore();
		for (const citation of root.querySelectorAll<HTMLElement>(`.${chatCitationClass}`)) {
			const binding = this.bindCitation(citation);
			if (binding) bindings.add(binding);
		}
		return bindings;
	}

	private get selector(): string {
		return this.links.linkPresentationRules.length
			? `a[href], .${chatCitationClass}`
			: `a[href^="file:" i], a[href].${chatSourcePreviewClass}[title], a[href].${chatExternalLinkClass}, .${chatCitationClass}`;
	}

	private bind(elements: Iterable<HTMLElement>): void {
		for (const element of elements) {
			if (this.bindings.has(element)) continue;
			if (element.classList.contains(chatCitationClass)) {
				const binding = this.bindCitation(element);
				if (binding) this.bindings.set(element, binding);
			} else if (element.tagName === 'A' && !element.closest(`.${chatCitationClass}`)) {
				this.decorateLink(element as HTMLAnchorElement);
			}
		}
	}

	private bindCitation(element: HTMLElement): IDisposable | undefined {
		// A rendered copy already has a button, but needs fresh state and listeners.
		const label = element.querySelector(`:scope > .ash-chat-citation-label, :scope > button.${chatCitationButtonClass}`);
		const sources = element.querySelectorAll<HTMLAnchorElement>(`:scope > .ash-chat-citation-list > a.${chatCitationLinkClass}[href]`);
		if (!label || !sources.length) return undefined;
		const binding = new DisposableStore();
		const document = element.ownerDocument;
		const button = document.createElement('button');
		button.type = 'button';
		button.className = chatCitationButtonClass;
		button.setAttribute('aria-haspopup', 'dialog');
		button.setAttribute('aria-expanded', 'false');
		button.append(...[...label.childNodes].map(node => node.cloneNode(true)));
		label.replaceWith(button);
		binding.add(toDisposable(() => button.replaceWith(label)));
		const active = binding.add(new MutableDisposable<DisposableStore>());
		const hover = binding.add(this.hoverService.setupHover({
			target: button,
			content: () => {
				const scope = active.value = new DisposableStore();
				const anchors = [...sources].map(source => source.cloneNode(true) as HTMLAnchorElement);
				const preview = createChatLinkPreview(document, anchors);
				this.richLinks.loadPreviewIcons(preview, scope);
				scope.add(bindChatLinkPreviewActivation(preview, button, () => hover.hide(), this.openLink));
				for (const anchor of anchors) {
					const href = anchor.getAttribute('href')!;
					scope.add(this.bindAnchor(anchor, href));
				}
				return preview;
			},
			dialogLabel: button.textContent ?? '',
			anchorAlignment: AnchorAlignment.Left,
			anchorPosition: AnchorPosition.Below,
			trapFocus: true,
			onDidHide: () => active.clear(),
		}));
		binding.add(addDisposableListener(button, 'click', () => hover.show(true)));
		return binding;
	}

	private bindAnchor(anchor: HTMLAnchorElement, href: string): DisposableStore | undefined {
		const binding = new DisposableStore();
		if (renderFileAnchor(anchor, this.instantiation, binding) || this.richLinks.decorate(anchor, href, binding)) return binding;
		binding.dispose();
		return undefined;
	}
}

function* matchingElements(nodes: readonly ChildNode[], selector: string): IterableIterator<HTMLElement> {
	for (const node of nodes) {
		if (node.nodeType !== 1) continue;
		const element = node as Element;
		if (element.matches(selector)) yield element as HTMLElement;
		yield* element.querySelectorAll<HTMLElement>(selector);
	}
}
