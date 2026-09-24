import createDOMPurify, {
	type Config as DOMPurifyConfig,
	type WindowLike,
} from "dompurify";

export type HtmlSanitizerConfig = DOMPurifyConfig;

export interface HtmlSanitizerOptions {
	readonly ownerDocument: Document;
	readonly config: HtmlSanitizerConfig;
	readonly afterSanitizeAttributes?: (element: Element) => void;
}

/**
 * Sanitizes untrusted HTML using a DOMPurify instance bound to its destination
 * document.
 *
 * Callers own the allowlist and any post-attribute policy. A new instance is
 * created per operation so hooks cannot leak between consumers or windows.
 */
export function sanitizeHtmlToFragment(
	rawHtml: string,
	options: HtmlSanitizerOptions,
): DocumentFragment {
	const ownerWindow = options.ownerDocument.defaultView;
	if (!ownerWindow) {
		throw new Error("HTML sanitization requires a document with a window");
	}
	const purifier = createDOMPurify(
		ownerWindow as unknown as WindowLike,
	);
	if (options.afterSanitizeAttributes) {
		const callback = options.afterSanitizeAttributes;
		purifier.addHook(
			"afterSanitizeAttributes",
			(element) => callback(element),
		);
	}
	return purifier.sanitize(rawHtml, {
		...options.config,
		RETURN_DOM_FRAGMENT: true,
	});
}
