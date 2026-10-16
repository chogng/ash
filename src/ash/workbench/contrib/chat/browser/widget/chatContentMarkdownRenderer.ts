import { allowedMarkdownHtmlAttributes, allowedMarkdownHtmlTags, type IRenderedMarkdown, type MarkdownRenderOptions } from '../../../../../base/browser/markdownRenderer.js';
import type { URI } from '../../../../../base/common/uri.js';
import type { IMarkdownString } from '../../../../../base/common/htmlContent.js';
import { localize } from '../../../../../nls.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IMarkdownRendererService, type IMarkdownRenderer } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { MarkedKatexSupport } from '../../../markdown/browser/markedKatexSupport.js';

/** Shared chat policy; provider adapters supply only their own syntax and resource transformations. */
function getChatMarkdownRenderOptions(options: MarkdownRenderOptions = {}): MarkdownRenderOptions {
	const sanitizer = {
		replaceWithPlaintext: true,
		...options.sanitizerConfig,
		remoteImageIsAllowed: (uri: URI) => !!options.imageResourceLoader && uri.scheme !== 'http' && uri.scheme !== 'https',
	};
	return {
		...options,
		markedOptions: { gfm: true, breaks: true, ...options.markedOptions },
		markedExtensions: [MarkedKatexSupport.getExtension(), ...(options.markedExtensions ?? [])],
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
	constructor(
		@IMarkdownRendererService private readonly markdownRenderer: IMarkdownRendererService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
	}

	public render(markdown: IMarkdownString, options: MarkdownRenderOptions = {}, outElement?: HTMLElement): IRenderedMarkdown {
		this.assertNotDisposed();
		let hasResourceImages = false;
		const result = this.markdownRenderer.render(markdown, getChatMarkdownRenderOptions({
			...options,
			ownerDocument: outElement?.ownerDocument ?? options.ownerDocument,
			imageResourceLoader: options.imageResourceLoader ? resource => {
				hasResourceImages = true;
				return options.imageResourceLoader!(resource);
			} : undefined,
			asyncRenderCallback: () => {
				// The base render has now finished installing resource image URLs.
				this.renderUnavailableMedia(result.element);
				options.asyncRenderCallback?.();
			},
		}), outElement);
		// A resource image has no src while its loader is pending. Keep its node
		// so the base render can install the result and own the object URL lifetime.
		this.renderUnavailableMedia(result.element, hasResourceImages);
		const store = new DisposableStore();
		store.add(result);
		if (result.element.querySelector('.ash-katex-container[data-latex]')) {
			this.math.value ??= this.instantiation.createInstance(MarkedKatexSupport);
			store.add(this.math.value.renderMath(result.element, options.asyncRenderCallback));
		}
		return Object.assign(toDisposable(() => store.dispose()), { element: result.element });
	}

	private renderUnavailableMedia(element: HTMLElement, imagesPending = false): void {
		// When a caller chooses semantic fallback rather than literal HTML, retain
		// media descriptions after the base sanitizer has removed a blocked source.
		const selector = imagesPending ? 'video:not([src]),audio:not([src])' : 'img:not([src]),video:not([src]),audio:not([src])';
		for (const media of element.querySelectorAll<HTMLElement>(selector)) {
			const description = media.getAttribute('alt') || media.getAttribute('title') || (media.childNodes.length ? '' : localize('chat.markdown.mediaUnavailable', 'Media content is unavailable here.'));
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
