import { getDocument, getWindow } from '../../../../../base/browser/dom.js';
import { allowedMarkdownHtmlAttributes, allowedMarkdownHtmlTags, type IRenderedMarkdown, type MarkdownRenderOptions } from '../../../../../base/browser/markdownRenderer.js';
import type { URI } from '../../../../../base/common/uri.js';
import type { IMarkdownString } from '../../../../../base/common/htmlContent.js';
import { localize } from '../../../../../nls.js';
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
		markedExtensions: [MarkedKatexSupport.getExtension(getWindow(options.ownerDocument ?? getDocument())), ...(options.markedExtensions ?? [])],
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
export class ChatContentMarkdownRenderer implements IMarkdownRenderer {
	constructor(@IMarkdownRendererService private readonly markdownRenderer: IMarkdownRendererService) { }

	public render(markdown: IMarkdownString, options: MarkdownRenderOptions = {}, outElement?: HTMLElement): IRenderedMarkdown {
		const result = this.markdownRenderer.render(markdown, getChatMarkdownRenderOptions({ ...options, ownerDocument: outElement?.ownerDocument ?? options.ownerDocument }), outElement);
		// When a caller chooses semantic fallback rather than literal HTML, retain
		// media descriptions after the base sanitizer has removed a blocked source.
		for (const media of result.element.querySelectorAll<HTMLElement>('img:not([src]),video:not([src]),audio:not([src])')) {
			const description = media.getAttribute('alt') || media.getAttribute('title') || (media.childNodes.length ? '' : localize('chat.markdown.mediaUnavailable', 'Media content is unavailable here.'));
			const placeholder = result.element.ownerDocument.createElement('span');
			placeholder.className = 'ash-chat-markdown-media';
			placeholder.textContent = description;
			// Invalid/self-closing HTML media can contain later paragraphs after
			// browser normalization. Replacing the source must retain those children.
			placeholder.append(...media.childNodes);
			media.replaceWith(placeholder);
		}
		return result;
	}
}
