import {
	allowedMarkdownHtmlAttributes,
	allowedMarkdownHtmlTags,
	renderWorkbenchMarkdown,
	sanitizeMarkdownHtmlToFragment,
	type IRenderedMarkdown,
	type MarkdownRenderOptions,
} from '../../../../../base/browser/markdownRenderer.js';
import { addDisposableListener, getDocument, h } from '../../../../../base/browser/dom.js';
import type { URI } from '../../../../../base/common/uri.js';
import type { IMarkdownString } from '../../../../../base/common/htmlContent.js';
import { localize } from '../../../../../nls.js';
import { htmlAttributeEncodeValue } from '../../../../../base/common/strings.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IMarkdownRendererService, openLinkFromMarkdown, type IMarkdownRenderer } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { MarkedKatexSupport } from '../../../markdown/browser/markedKatexSupport.js';

/** Shared chat policy; provider adapters supply only their own syntax and resource transformations. */
function getChatMarkdownRenderOptions(options: MarkdownRenderOptions, mathSyntax: boolean): MarkdownRenderOptions {
	const sanitizer = {
		replaceWithPlaintext: true,
		...options.sanitizerConfig,
		remoteImageIsAllowed: (uri: URI) => !!options.imageResourceLoader && uri.scheme !== 'http' && uri.scheme !== 'https',
	};
	return {
		...options,
		markedOptions: { gfm: true, breaks: true, ...options.markedOptions },
		markedExtensions: [...(mathSyntax ? [MarkedKatexSupport.getExtension()] : []), ...(options.markedExtensions ?? [])],
		sanitizerConfig: {
			...sanitizer,
			...MarkedKatexSupport.getSanitizerOptions({
				allowedTags: sanitizer.allowedTags?.override ?? allowedMarkdownHtmlTags,
				allowedAttributes: sanitizer.allowedAttributes?.override ?? allowedMarkdownHtmlAttributes,
			}),
		},
	};
}

/** Uses the standard service for code rendering, links and the disposable render lifetime. */
export class ChatContentMarkdownRenderer extends Disposable implements IMarkdownRenderer {
	private readonly math = this._register(new MutableDisposable<MarkedKatexSupport>());
	private tails = new WeakMap<HTMLElement, { readonly raw: HTMLElement; readonly block: HTMLElement; readonly policy: string }>();
	constructor(
		@IMarkdownRendererService private readonly markdownRenderer: IMarkdownRendererService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IOpenerService private readonly opener: IOpenerService,
	) {
		super();
		this._register(
			toDisposable(() => {
				this.tails = new WeakMap();
			}),
		);
	}

	public render(markdown: IMarkdownString, options: MarkdownRenderOptions = {}, outElement?: HTMLElement): IRenderedMarkdown {
		this.assertNotDisposed();
		let hasResourceImages = false;
		const mathSyntax = /[$\\]|`{3}|~{3}/u.test(markdown.value);
		const renderOptions = getChatMarkdownRenderOptions(
			{
				...options,
				ownerDocument: outElement?.ownerDocument ?? options.ownerDocument,
				imageResourceLoader: options.imageResourceLoader
					? resource => {
							hasResourceImages = true;
							return options.imageResourceLoader!(resource);
						}
					: undefined,
				asyncRenderCallback: () => {
					// The base render has now finished installing resource image URLs.
					this.renderUnavailableMedia(result.element);
					options.asyncRenderCallback?.();
				},
			},
			mathSyntax,
		);
		const tail =
			!options.markedExtensions?.length && !options.sanitizerConfig?.allowedTags && !options.sanitizerConfig?.allowedAttributes
				? this.renderTail(markdown, renderOptions, outElement)
				: undefined;
		if (tail) return tail;
		const result = this.markdownRenderer.render(markdown, renderOptions, outElement);
		// A resource image has no src while its loader is pending. Keep its node
		// so the base render can install the result and own the object URL lifetime.
		this.renderUnavailableMedia(result.element, hasResourceImages);
		const store = new DisposableStore();
		store.add(result);
		if ((mathSyntax || options.markedExtensions?.length) && result.element.querySelector('.ash-katex-container[data-latex]')) {
			this.math.value ??= this.instantiation.createInstance(MarkedKatexSupport);
			store.add(this.math.value.renderMath(result.element, options.asyncRenderCallback));
		}
		return Object.assign(
			toDisposable(() => store.dispose()),
			{ element: result.element },
		);
	}

	/** Reuses only nodes sanitized under the same policy; parser output stays inert until sanitized. */
	private renderTail(markdown: IMarkdownString, options: MarkdownRenderOptions, target?: HTMLElement): IRenderedMarkdown | undefined {
		if (markdown.value.length < 4096 || markdown.supportHtml || /[$\\<>]|!\[|`{3}|~{3}/u.test(markdown.value) || options.transformUri || (options.markedExtensions?.length ?? 0) > 1)
			return undefined;
		const document = target?.ownerDocument ?? options.ownerDocument ?? getDocument();
		const template = document.createElement('template');
		template.innerHTML = renderWorkbenchMarkdown(markdown, false, options);
		const raw = template.content.firstElementChild as HTMLElement | null;
		if (
			!raw ||
			!['P', 'UL', 'OL', 'TABLE'].includes(raw.tagName) ||
			[...template.content.childNodes].some(node => node !== raw && node.textContent?.trim()) ||
			[...raw.querySelectorAll('*')].some(node => !['P', 'LI', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'A', 'STRONG', 'EM', 'DEL', 'CODE', 'BR'].includes(node.tagName))
		)
			return undefined;
		const policy = JSON.stringify([markdown.isTrusted, markdown.baseUri?.toString(), options.markedOptions, options.sanitizerConfig]);
		const previous = target && this.tails.get(target);
		const element = target ?? h(document, 'div');
		element.classList.add('ash-markdown');
		let block: HTMLElement;
		const same =
			previous &&
			previous.policy === policy &&
			previous.raw.tagName === raw.tagName &&
			previous.raw.getAttributeNames().every(name => previous.raw.getAttribute(name) === raw.getAttribute(name)) &&
			previous.raw.attributes.length === raw.attributes.length;
		const oldBody = same && (raw.tagName === 'TABLE' ? previous.raw.querySelector('tbody') : previous.raw);
		const newBody = raw.tagName === 'TABLE' ? raw.querySelector('tbody') : raw;
		const body = same && (raw.tagName === 'TABLE' ? previous.block.querySelector('tbody') : previous.block);
		if (
			same &&
			oldBody &&
			newBody &&
			body &&
			oldBody.childNodes.length === body.childNodes.length &&
			(raw.tagName !== 'TABLE' || previous.raw.querySelector('thead')?.outerHTML === raw.querySelector('thead')?.outerHTML)
		) {
			block = previous.block;
			const before = [...oldBody.childNodes];
			const after = [...newBody.childNodes];
			const source = (node: ChildNode): string => (node.nodeType === 1 ? (node as Element).outerHTML : htmlAttributeEncodeValue(node.textContent ?? ''));
			let prefix = 0;
			while (prefix < Math.min(before.length, after.length) && source(before[prefix]) === source(after[prefix])) prefix++;
			let suffix = 0;
			while (suffix < Math.min(before.length, after.length) - prefix && source(before[before.length - suffix - 1]) === source(after[after.length - suffix - 1])) suffix++;
			const changed = after
				.slice(prefix, after.length - suffix)
				.map(source)
				.join('');
			const tag = newBody.tagName.toLowerCase();
			const wrapped = tag === 'tbody' ? `<table><tbody>${changed}</tbody></table>` : `<${tag}>${changed}</${tag}>`;
			const sanitized = sanitizeMarkdownHtmlToFragment({ ownerDocument: document, markdown, sanitizerConfig: options.sanitizerConfig }, wrapped);
			const replacement = tag === 'tbody' ? sanitized.querySelector('tbody')! : sanitized.firstElementChild!;
			const nodes = [...body.childNodes];
			const anchor = nodes[nodes.length - suffix] ?? null;
			for (const node of nodes.slice(prefix, nodes.length - suffix)) node.remove();
			for (const node of [...replacement.childNodes]) body.insertBefore(node, anchor);
		} else {
			const sanitized = sanitizeMarkdownHtmlToFragment({ ownerDocument: document, markdown, sanitizerConfig: options.sanitizerConfig }, template.innerHTML);
			element.replaceChildren(sanitized);
			block = element.firstElementChild as HTMLElement;
		}
		const state = { raw, block, policy };
		this.tails.set(element, state);
		const click = addDisposableListener<MouseEvent>(element, 'click', event => {
			const anchor = (event.target as Element | null)?.closest?.('a[href]');
			if (!anchor || !element.contains(anchor)) return;
			event.preventDefault();
			event.stopPropagation();
			const href = anchor.getAttribute('href')!;
			if (options.actionHandler) options.actionHandler(href, markdown);
			else void openLinkFromMarkdown(this.opener, href, markdown.isTrusted);
		});
		return Object.assign(
			toDisposable(() => {
				click.dispose();
				const ownsElement = this.tails.get(element) === state;
				if (ownsElement) this.tails.delete(element);
				if (!target && ownsElement) element.remove();
			}),
			{ element },
		);
	}

	private renderUnavailableMedia(element: HTMLElement, imagesPending = false): void {
		// When a caller chooses semantic fallback rather than literal HTML, retain
		// media descriptions after the base sanitizer has removed a blocked source.
		const selector = imagesPending ? 'video:not([src]),audio:not([src])' : 'img:not([src]),video:not([src]),audio:not([src])';
		for (const media of element.querySelectorAll<HTMLElement>(selector)) {
			const description =
				media.getAttribute('alt') || media.getAttribute('title') || (media.childNodes.length ? '' : localize('chat.markdown.mediaUnavailable', 'Media content is unavailable here.'));
			const placeholder = element.ownerDocument.createElement('span');
			placeholder.className = 'ash-chat-markdown-media';
			placeholder.textContent = description;
			// Invalid/self-closing HTML media can contain later paragraphs after
			// browser normalization. Replacing the source must retain those children.
			placeholder.append(...media.childNodes);
			media.replaceWith(placeholder);
		}
	}
}
