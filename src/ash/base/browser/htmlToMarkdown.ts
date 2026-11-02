import { appendEscapedMarkdownInlineCode, escapeMarkdownSyntaxTokens, isPortableMarkdownTarget } from '../common/htmlContent.js';
import { getDocument } from './dom.js';
import { createTrustedTypesPolicy } from './trustedTypes.js';

const clipboardHtmlPolicy = createTrustedTypesPolicy('ashHtmlToMarkdown', { createHTML: html => html });

/**
 * Converts inert clipboard HTML to Markdown. Nothing from the parsed fragment is mounted,
 * and destinations that need the source window are represented by their readable labels.
 * Empty output lets the caller fall back to the clipboard's plain-text representation.
 */
export function convertHtmlToMarkdown(html: string): string {
	if (!html || html.length > 200_000) { return ''; }
	const template = getDocument().createElement('template');
	template.innerHTML = (clipboardHtmlPolicy?.createHTML?.(html) ?? html) as string;
	// Formatting whitespace can be normalized, but literal code must survive byte for byte.
	const literals: string[] = [];
	const expand = (value: string): string => value.replace(/\0(\d+)\0/g, (_, index: string) => literals[Number(index)]!);
	const preserve = (value: string): string => `\0${literals.push(expand(value)) - 1}\0`;
	const children = (node: Node, depth: number): string => Array.from(node.childNodes, child => convert(child, depth + 1)).join('');
	const omitted = (element: HTMLElement): boolean => element.matches('script, style, template, noscript, head, iframe, object, button, input, select, textarea, [hidden], [role="toolbar"]')
		|| element.style.display === 'none' || element.style.visibility === 'hidden' || element.style.opacity === '0';
	const plain = (node: Node, depth = 0): string => {
		if (depth > 100 || node.nodeType === 1 && omitted(node as HTMLElement)) { return ''; }
		if (node.nodeType === 3) { return node.textContent ?? ''; }
		if (node.nodeType === 1 && (node as Element).tagName === 'IMG') { return (node as Element).getAttribute('alt') ?? ''; }
		return Array.from(node.childNodes, child => plain(child, depth + 1)).join('');
	};
	const destination = (value: string): string => value.replace(/[\s<>]/g, char => encodeURIComponent(char)).replace(/[\\()]/g, '\\$&');
	const convert = (node: Node, depth: number): string => {
		if (depth > 100) { return ''; }
		if (node.nodeType === 3) { return escapeMarkdownSyntaxTokens((node.textContent ?? '').replace(/\s+/g, ' ')); }
		if (node.nodeType !== 1) { return ''; }
		const element = node as HTMLElement;
		if (omitted(element)) { return ''; }
		const tag = element.tagName;
		if (tag === 'PRE') {
			const text = element.textContent ?? '';
			const fence = '`'.repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), run => run[0].length + 1)));
			return `\n\n${preserve(`${fence}\n${text.replace(/\n$/, '')}\n${fence}`)}\n\n`;
		}
		if (tag === 'CODE') { return preserve(appendEscapedMarkdownInlineCode(element.textContent ?? '')); }
		if (tag === 'BR') { return '\n'; }
		if (tag === 'HR') { return '\n\n---\n\n'; }
		if (tag === 'A' || tag === 'IMG') {
			const href = (element.getAttribute(tag === 'A' ? 'href' : 'src') ?? '').trim();
			// Public hrefs are authoritative for imported HTML; routing metadata is a fallback.
			const target = isPortableMarkdownTarget(href) ? href : element.getAttribute('data-href')?.trim() || href;
			const label = plain(element).trim();
			if (!label) { return ''; }
			return isPortableMarkdownTarget(target)
				? `${tag === 'IMG' ? '!' : ''}[${tag === 'IMG' ? escapeMarkdownSyntaxTokens(label) : children(element, depth)}](${destination(target)})`
				: preserve(appendEscapedMarkdownInlineCode(label));
		}
		if (tag === 'UL' || tag === 'OL') {
			const first = Number(element.getAttribute('start') ?? '1');
			let number = Number.isSafeInteger(first) ? first : 1;
			const lines = Array.from(element.children).filter(child => child.tagName === 'LI' && !omitted(child as HTMLElement)).map(child => {
				const marker = tag === 'OL' ? `${number++}. ` : '- ';
				const content = children(child, depth).trim();
				return marker + expand(content).replace(/\n/g, '\n' + ' '.repeat(marker.length));
			});
			return `\n\n${preserve(lines.join('\n'))}\n\n`;
		}
		if (tag === 'TABLE') {
			const rows = Array.from(element.querySelectorAll('tr')).filter(row => row.closest('table') === element && !omitted(row)).map(row =>
				Array.from(row.children).filter(cell => cell.matches('td,th')).map(cell => omitted(cell as HTMLElement) ? '' : children(cell, depth).trim().replace(/\n+/g, ' ').replace(/\|/g, '\\|')));
			const columns = Math.max(0, ...rows.map(row => row.length));
			if (!columns) { return ''; }
			const line = (cells: readonly string[]): string => '| ' + Array.from({ length: columns }, (_, index) => cells[index] ?? '').join(' | ') + ' |';
			return '\n\n' + [line(rows[0]!), line(Array.from({ length: columns }, () => '---')), ...rows.slice(1).map(line)].join('\n') + '\n\n';
		}
		const content = children(element, depth);
		if (/^H[1-6]$/.test(tag)) { return `\n\n${'#'.repeat(Number(tag[1]))} ${content.trim()}\n\n`; }
		if (tag === 'BLOCKQUOTE') { return '\n\n' + preserve(expand(content).trim().split('\n').map(line => `> ${line}`).join('\n')) + '\n\n'; }
		if (tag === 'STRONG' || tag === 'B') { return content ? `**${content}**` : ''; }
		if (tag === 'EM' || tag === 'I') { return content ? `*${content}*` : ''; }
		if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') { return content ? `~~${content}~~` : ''; }
		if (tag === 'P' || tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE') { return `\n\n${content.trim()}\n\n`; }
		return content;
	};
	return expand(children(template.content, 0).replace(/\u00a0/g, ' ').replace(/\n[ \t]+\n/g, '\n\n').replace(/\n{3,}/g, '\n\n').trim());
}
