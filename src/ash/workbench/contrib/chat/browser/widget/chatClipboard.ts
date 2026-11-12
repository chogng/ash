import { getDocument } from '../../../../../base/browser/dom.js';
import { renderWorkbenchMarkdown, sanitizeMarkdownHtmlToFragment } from '../../../../../base/browser/markdownRenderer.js';
import { decodeBase64, encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { appendEscapedMarkdownInlineCode, isPortableLinkTarget, isPortableMarkdownTarget } from '../../../../../base/common/htmlContent.js';
import { Lexer, type Token, type Tokens } from '../../../../../base/common/marked/marked.js';
import { escapeRegExpCharacters } from '../../../../../base/common/strings.js';
import type { IWebWorkerService } from '../../../../../platform/webWorker/browser/webWorkerService.js';
import { encodeImageBlobAsPng } from '../../../mediaPreview/browser/imageEncoder.js';
import type { ChatMarkdownRichContent } from '../../common/model/chatMarkdownRichContent.js';
import { getChatMarkdownRenderOptions } from './chatContentMarkdownRenderer.js';
import { chatMarkdownRichContentExtension } from './chatMarkdownRichContent.js';

/** The routing target takes precedence over the browser's fallback href. */
export function getLinkTarget(element: Element): string {
	return (element.getAttribute('data-href') || element.getAttribute('href') || '').trim();
}

/** Clones selected content without changing the live transcript or its selection. */
export function cloneVisibleSelection(range: Range, root: Node): DocumentFragment {
	const document = root.ownerDocument!;
	const result = document.createDocumentFragment();
	if (!root.contains(range.commonAncestorContainer) || range.collapsed) { return result; }
	const clone = (node: Node, whole = false): Node | undefined => {
		if (!whole && !range.intersectsNode(node)) { return undefined; }
		if (node.nodeType === 3) {
			const start = !whole && node === range.startContainer ? range.startOffset : 0;
			const end = !whole && node === range.endContainer ? range.endOffset : node.textContent!.length;
			return end > start ? document.createTextNode(node.textContent!.slice(start, end)) : undefined;
		}
		if (node.nodeType !== 1) { return undefined; }
		const element = node as Element;
		if (element.matches('style, script, button, [role="toolbar"], [role="status"]')) { return undefined; }
		const style = document.defaultView!.getComputedStyle(element);
		if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') { return undefined; }
		const copy = element.cloneNode(false);
		for (const child of element.childNodes) {
			const selected = clone(child, whole);
			if (selected) { copy.appendChild(selected); }
		}
		if (!copy.hasChildNodes() && !element.matches('img, br, hr')) { return undefined; }
		// A partial reference must retain its complete label in the rich clipboard flavor.
		return !whole && element.tagName === 'A' ? clone(node, true) : copy;
	};
	const copy = clone(root);
	if (copy) { result.append(...Array.from(copy.childNodes)); }
	return result;
}

/** Removes window-local destinations; returns whether native rich copying needs replacing. */
export function sanitizeChatClipboardFragment(fragment: DocumentFragment, embeddedImages?: ReadonlySet<string>): boolean {
	let changed = false;
	for (const element of fragment.querySelectorAll('a, img')) {
		const target = element.tagName === 'A' ? getLinkTarget(element) : element.getAttribute('src') ?? '';
		if (isPortableLinkTarget(target) || element.tagName === 'IMG' && embeddedImages?.has(target)) {
			if (element.tagName === 'A') {
				changed ||= element.getAttribute('href') !== target;
				element.setAttribute('href', target);
			}
			continue;
		}
		const label = element.tagName === 'A' ? element.textContent ?? '' : element.getAttribute('alt') ?? '';
		const code = element.ownerDocument.createElement('code');
		code.textContent = label;
		if (label.trim()) { element.replaceWith(code); }
		else { element.remove(); }
		changed = true;
	}
	for (const element of fragment.querySelectorAll('[data-href]')) { element.removeAttribute('data-href'); }
	return changed;
}

/** Produces the rich clipboard flavor without exporting SVG markup or window-owned URLs. */
export async function renderChatClipboardHtml(markdown: string, content: ChatMarkdownRichContent, document: Document, workers: IWebWorkerService): Promise<string> {
	const svgPrefix = 'data:image/svg+xml;base64,';
	const images = new Map<string, string>();
	const visited = new Set<string>();
	for (const part of content.parts) {
		if (part.kind !== 'image' || !part.uri.startsWith(svgPrefix) || visited.has(part.uri)) continue;
		visited.add(part.uri);
		try {
			const svg = new Blob([new Uint8Array(decodeBase64(part.uri.slice(svgPrefix.length)).buffer)], { type: 'image/svg+xml' });
			const png = await encodeImageBlobAsPng(svg, document, workers);
			images.set(part.uri, 'data:image/png;base64,' + encodeBase64(VSBuffer.wrap(new Uint8Array(png))));
		} catch {
			// An image that cannot be decoded still contributes its label and caption.
		}
	}
	const value = { value: markdown, supportHtml: true };
	const options = getChatMarkdownRenderOptions(markdown, { markedExtensions: [chatMarkdownRichContentExtension(content, true, images)] });
	const raw = renderWorkbenchMarkdown(value, false, options);
	const fragment = sanitizeMarkdownHtmlToFragment({ ownerDocument: document, markdown: value, sanitizerConfig: { ...options.sanitizerConfig, replaceWithPlaintext: false } }, raw);
	sanitizeChatClipboardFragment(fragment, new Set(images.values()));
	const container = document.createElement('div');
	container.append(fragment);
	return container.innerHTML;
}

function plainLabel(tokens: readonly Token[]): string {
	return tokens.map(token => token.type === 'br' ? '\n' : 'tokens' in token && token.tokens ? plainLabel(token.tokens) : 'text' in token ? token.text : '').join('');
}

function codeLabel(tokens: readonly Token[]): string {
	// Decode entities as text, without interpreting model-authored HTML as markup.
	const decoder = getDocument().createElement('textarea');
	decoder.innerHTML = plainLabel(tokens).replace(/</g, '&lt;');
	const text = decoder.value.trim().replace(/\s*\n\s*/g, ' ');
	if (!text) { return ''; }
	return appendEscapedMarkdownInlineCode(text);
}

/**
 * Rewrites parser-recognized links while retaining the author's surrounding Markdown.
 * Each token is located only after its preceding siblings, so code samples and repeated
 * labels cannot steal a later link's edit. Block prefixes may interrupt multiline tokens.
 */
export function toPortableMarkdown(markdown: string): string {
	const rewrite = (source: string, tokens: readonly Token[]): string => {
		let cursor = 0;
		let result = '';
		for (const token of tokens) {
			if (!token.raw) { continue; }
			const lines = token.raw.split('\n');
			const pattern = lines.map((line, index) => `${index ? `\\r?\\n${line ? '[ \\t>]*' : ''}` : ''}${escapeRegExpCharacters(line)}`).join('');
			const match = new RegExp(pattern, 'g');
			match.lastIndex = cursor;
			const found = match.exec(source);
			if (!found) { continue; }
			const raw = found[0];
			let replacement = raw;
			if (token.type === 'def') {
				replacement = '';
			} else if (token.type === 'link' || token.type === 'image') {
				const link = token as Tokens.Link | Tokens.Image;
				if (!isPortableMarkdownTarget(link.href)) {
					replacement = codeLabel(link.tokens);
				} else {
					replacement = rewrite(raw, link.tokens);
					if (!('autolink' in link && link.autolink) && !/^!?\[[\s\S]*\]\s*\(/.test(raw)) {
						// Reference definitions are removed, so retained references need inline targets.
						const label = rewrite(link.text, link.tokens);
						const title = link.title ? ` "${link.title.replace(/[\\"]/g, '\\$&')}"` : '';
						replacement = `${token.type === 'image' ? '!' : ''}[${label}](<${link.href.replace(/>/g, '%3E')}>${title})`;
					}
				}
			} else if (token.type === 'list') {
				replacement = rewrite(raw, (token as Tokens.List).items);
			} else if (token.type === 'table') {
				const table = token as Tokens.Table;
				replacement = rewrite(raw, [...table.header, ...table.rows.flat()].flatMap(cell => cell.tokens));
			} else if (token.type !== 'code' && token.type !== 'codespan' && token.type !== 'html' && 'tokens' in token && token.tokens) {
				replacement = rewrite(raw, token.tokens);
			}
			result += source.slice(cursor, found.index) + replacement;
			cursor = found.index + raw.length;
		}
		return result + source.slice(cursor);
	};
	return rewrite(markdown, Lexer.lex(markdown));
}
