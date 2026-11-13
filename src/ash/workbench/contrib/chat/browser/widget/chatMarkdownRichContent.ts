import { convertHtmlToMarkdown } from '../../../../../base/browser/htmlToMarkdown.js';
import { renderAsPlaintext, renderWorkbenchMarkdown } from '../../../../../base/browser/markdownRenderer.js';
import '../../../../../base/browser/ui/countBadge/countBadge.css';
import { escapeIcons } from '../../../../../base/common/iconLabels.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { Marked, type MarkedExtension, type Token } from '../../../../../base/common/marked/marked.js';
import { extname } from '../../../../../base/common/path.js';
import { escapeRegExpCharacters, htmlAttributeEncodeValue as escapeHTML } from '../../../../../base/common/strings.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { parseGitHubLinkTarget } from '../../../../../platform/github/common/githubUrls.js';
import type { ChatMarkdownRichContent, ChatMarkdownRichPart, ChatMarkdownRichStyle } from '../../common/model/chatMarkdownRichContent.js';
import { getChatMarkdownExtensions } from './chatCjkMarkdown.js';

export const CHAT_RESPONSE_DOWNLOAD_SCHEME = 'chat-response-download';
export const CHAT_RESPONSE_ENTITY_SCHEME = 'chat-response-entity';
export const CHAT_RESPONSE_WRITING_SCHEME = 'chat-response-writing';
export const CHAT_RESPONSE_IMAGE_SCHEME = 'chat-response-image';
export const chatSourcePreviewClass = 'ash-chat-source-preview';
export const chatCitationLinkClass = 'ash-chat-citation-link';
export const chatCitationClass = 'ash-chat-citation';
export const chatExternalLinkClass = 'ash-chat-external-link';

const fileIcons = new Map([
	['.csv', Lxicon.csvGreen],
	['.doc', Lxicon.docxBlue],
	['.docx', Lxicon.docxBlue],
	['.pdf', Lxicon.pdfRed],
	['.xls', Lxicon.xlsGreen],
	['.xlsx', Lxicon.xlsGreen],
]);

export function getChatFileIcon(name: string) {
	return fileIcons.get(extname(name).toLowerCase()) ?? Lxicon.file;
}

function colorClass(property: 'background' | 'border', value: string | undefined): string | undefined {
	const match = value && /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0(?:\.\d+)?|1(?:\.0+)?))?\s*\)$/u.exec(value);
	if (!match || match.slice(1, 4).some(channel => Number(channel) > 255)) return undefined;
	return `${property}-rgba-${match[1]}-${match[2]}-${match[3]}-${(match[4] ?? '1').replace('.', 'p')}`;
}

function classes(kind: 'box' | 'row' | 'grid' | 'text' | 'icon', style: ChatMarkdownRichStyle): string {
	const result = ['ash-chat-rich', `ash-chat-rich-${kind}`];
	const variants: ReadonlyArray<readonly [keyof ChatMarkdownRichStyle, readonly string[]]> = [
		['radius', ['sm', 'md', 'lg']], ['padding', ['0', '1', '2', '3', '4']], ['gap', ['0', '1', '2', '3', '4']],
		['align', ['start', 'center', 'end', 'stretch']], ['justify', ['start', 'center', 'end', 'between']],
		['flex', ['1']],
		['background', ['surface', 'surface-secondary']], ['color', kind === 'icon' ? ['secondary', 'success', 'danger'] : ['secondary']], ['size', ['xs', 'sm', 'lg']],
	];
	for (const [name, allowed] of variants) {
		const value = style[name];
		if (value && allowed.includes(value)) result.push(`${name}-${value}`);
	}
	if (style.border) result.push('border');
	const background = colorClass('background', style.background);
	const border = colorClass('border', style.borderColor);
	if (background) result.push(background);
	if (border) result.push(border);
	return result.join(' ');
}

function renderAnchor(href: string, content: string, preview?: string, presentationClass?: string): string {
	const classes = [preview && chatSourcePreviewClass, presentationClass].filter(Boolean).join(' ');
	const attributes = (classes ? ` class="${classes}"` : '') + (preview ? ` title="${escapeHTML(preview)}"` : '');
	return `<a href="${escapeHTML(href)}"${attributes}>${content}</a>`;
}

const link = (href: string, label: string, title?: string, external = false): string => {
	const icon = external ? `$(${Lxicon.linkExternal.id})` : '';
	return renderAnchor(href, escapeHTML(external ? escapeIcons(label) : label) + icon, title, external ? chatExternalLinkClass : undefined);
};

function renderCitations(part: Extract<ChatMarkdownRichPart, { kind: 'citations'; }>, inLink: boolean, textOnly: boolean): string {
	if (inLink || textOnly) {
		const references = part.entries.map(entry => `[${entry.number}]`).join(' ');
		if (inLink) return references;
		return `<details><summary>${references}</summary>${part.entries.map(entry => `<div>${link(entry.url, entry.title)}<p>${escapeHTML(entry.snippet)}</p></div>`).join('')}</details>`;
	}
	const count = part.entries.length;
	const label = count === 1 ? localize('chat.citation.source', '{0} source', count) : localize('chat.citation.sources', '{0} sources', count);
	const entries = part.entries.map(entry => {
		const url = URL.parse(entry.url);
		const domain = url?.hostname ?? '';
		const title = entry.title.trim() || domain || entry.url;
		const isGitHub = url?.hostname === 'github.com';
		const target = isGitHub ? parseGitHubLinkTarget(URI.parse(entry.url)) : undefined;
		const repository = target?.kind === 'repository' ? `${target.owner}/${target.repo}` : undefined;
		const domainSuffix = ` - ${domain}`;
		let shortTitle = title;
		if (repository && (title === domain || title === `GitHub - ${repository}` || title.startsWith(`GitHub - ${repository}:`))) {
			shortTitle = repository;
		} else if (domain && title.toLowerCase().endsWith(domainSuffix)) {
			shortTitle = title.slice(0, -domainSuffix.length);
		}
		const preview = [title, entry.snippet.trim()].filter(Boolean).join('\n');
		const icon = isGitHub ? Lxicon.github : Lxicon.browserExplore;
		const content = `$(${icon.id})<span class="ash-chat-link-preview-text"><span class="ash-chat-citation-domain">${domain === shortTitle ? '' : escapeHTML(domain)}</span> `
			+ `<span class="ash-chat-citation-title">${escapeHTML(escapeIcons(shortTitle))}</span></span>$(${Lxicon.linkExternal.id})`;
		return renderAnchor(entry.url, content, preview, chatCitationLinkClass);
	}).join('');
	return `<span class="${chatCitationClass}"><span class="ash-chat-citation-label">$(${Lxicon.link.id})${escapeHTML(label)}<span class="ash-chat-citation-chevron">$(${Lxicon.chevronDown.id})</span></span><span class="ash-chat-citation-list">${entries}</span></span>`;
}

function renderPart(part: ChatMarkdownRichPart, index: number, body: string, inLink: boolean, textOnly: boolean, clipboardImages?: ReadonlyMap<string, string>): string {
	switch (part.kind) {
		case 'markdown': return body;
		case 'writing': {
			if (textOnly || inLink || part.awaitingPublication) return body;
			const label = part.resource ? localize('chat.writing.editInDocs', 'Edit in Docs')
				: localize('chat.writing.editCopyInDocs', 'Edit a copy in Docs');
			return `<div>${body}${link(`${CHAT_RESPONSE_WRITING_SCHEME}:${index}`, label)}</div>`;
		}
		case 'textLiteral': return escapeHTML(part.label);
		case 'entity': return textOnly || inLink ? escapeHTML(part.entity.label) : link(`${CHAT_RESPONSE_ENTITY_SCHEME}:${index}`, part.entity.label);
		case 'image': {
			const clipboardSource = clipboardImages?.get(part.uri);
			if (clipboardSource) return `<img src="${escapeHTML(clipboardSource)}" alt="${escapeHTML(part.label)}">`;
			if (textOnly || inLink) return escapeHTML(part.label);
			const image = `<img src="${CHAT_RESPONSE_IMAGE_SCHEME}:${index}" alt="${escapeHTML(part.label)}">`;
			return part.block ? `<div class="ash-chat-rich-image">${image}</div>` : image;
		}
		case 'imageGallery': {
			const label = localize('chat.imageGallery.label', 'Image gallery');
			if (textOnly || inLink) {
				const description = part.images.map(image => image.source && !inLink ? link(image.source, image.label) : escapeHTML(image.label)).join('<br>');
				return `<span>${escapeHTML(label)}<br>${description}</span>`;
			}
			return `<div class="ash-chat-image-gallery${part.compact ? ' compact' : ''}" data-ash-chat-gallery-index="${index}" role="group" aria-label="${escapeHTML(label)}"></div>`;
		}
		case 'link': {
			const rendered = inLink ? escapeHTML(part.link.label) : link(part.link.href, part.link.label, textOnly ? undefined : part.title, !textOnly && part.external);
			return part.block && !textOnly && !inLink ? `<div>${rendered}</div>` : rendered;
		}
		case 'resource': {
			const label = body || escapeHTML(part.label);
			if (textOnly) return `<span>${label}</span>${part.data ? `<pre>${escapeHTML(part.data)}</pre>` : ''}`;
			if (inLink || !part.uri) return label;
			const href = CHAT_RESPONSE_DOWNLOAD_SCHEME + ':' + index;
			const title = part.title ? ` title="${escapeHTML(part.title)}"` : '';
			const icon = getChatFileIcon(part.label);
			return `<a href="${href}"${title}><span class="ash-chat-file-link-icon">$(${icon.id})</span>${label}</a>`;
		}
		case 'box':
		case 'row':
		case 'text': {
			const tag = part.block ? 'div' : 'span';
			const fallback = part.fallback && link(part.fallback.href, part.fallback.label);
			const content = body || fallback || '';
			if (textOnly) return `<${tag}>${content}</${tag}>`;
			const badge = part.kind === 'text' && part.style.appearance === 'badge' ? ' ash-badge outlined' : '';
			return `<${tag} class="${classes(part.kind, part.style)}${badge}">${content}</${tag}>`;
		}
		case 'grid': {
			const tag = part.block ? 'div' : 'span';
			return textOnly ? `<${tag}>${body}</${tag}>` : `<${tag} class="${classes(part.kind, part.style)} columns-${part.columns}">${body}</${tag}>`;
		}
		case 'gridItem': {
			const tag = part.block ? 'div' : 'span';
			return textOnly ? `<${tag}>${body}</${tag}>` : `<${tag} class="ash-chat-rich-grid-item">${body}</${tag}>`;
		}
		case 'icon': {
			const label = escapeHTML(part.label);
			const fallback = label || link(part.fallback.href, part.fallback.label);
			if (textOnly) return fallback;
			const content = part.icon
				? `$(${part.icon.id})<span class="ash-chat-rich-icon-text">${label}</span>`
				: fallback;
			return `<span class="${classes('icon', part.style)}">${content}</span>`;
		}
		case 'details': {
			const label = escapeHTML(part.label.trim());
			const content = body + (part.data ? `<pre><code>${escapeHTML(part.data)}</code></pre>` : '');
			return label && content ? `<details class="ash-chat-rich" open><summary>${label}</summary>${content}</details>` : content || label;
		}
		case 'citations': return renderCitations(part, inLink, textOnly);
		case 'unavailableMedia':
			return `<span class="ash-chat-markdown-media">${localize('chat.markdown.mediaUnavailable', 'Media content is unavailable here.')} ${link(part.fallback.href, part.fallback.label)}</span>`;
	}
}

/** Renders the referenced part after Markdown has established the enclosing list, paragraph or table cell. */
export function chatMarkdownRichContentExtension(content: ChatMarkdownRichContent, textOnly = false, clipboardImages?: ReadonlyMap<string, string>): MarkedExtension {
	const pattern = escapeRegExpCharacters(content.markerPrefix) + '(\\d+):>';
	const marker = new RegExp('^' + pattern, 'u');
	const blockMarkers = new RegExp('\n' + pattern, 'gu');
	return {
		extensions: (['block', 'inline'] as const).map(level => ({
			name: level === 'block' ? 'chatRichBlock' : 'chatRichInline',
			level,
			start(source) {
				if (level === 'inline') return source.indexOf(content.markerPrefix);
				// A block reference can interrupt only from the start of a line.
				for (const match of source.matchAll(blockMarkers)) {
					if (content.parts[Number(match[1])]?.block) return match.index + 1;
				}
				return undefined;
			},
			tokenizer(source) {
				if (this.lexer.state.inRawBlock) return undefined;
				const match = marker.exec(source);
				const index = Number(match?.[1]);
				const part = content.parts[index];
				if (!match || !part || level === 'block' && !part.block) return undefined;
				const inLink = this.lexer.state.inLink;
				const tokens = 'markdown' in part && part.markdown
					? part.block ? this.lexer.blockTokens(part.markdown) : this.lexer.inlineTokens(part.markdown)
					: [];
				return { type: level === 'block' ? 'chatRichBlock' : 'chatRichInline', raw: match[0], part, index, tokens, inLink };
			},
			childTokens: ['tokens'],
			renderer(token) {
				const part = token.part as ChatMarkdownRichPart;
				const tokens = token.tokens as Token[];
				const body = part.block ? this.parser.parse(tokens) : this.parser.parseInline(tokens);
				return renderPart(part, token.index as number, body, token.inLink === true, textOnly, clipboardImages);
			},
		})),
	};
}

export function renderChatRichContentText(markdown: string, content: ChatMarkdownRichContent | undefined): string {
	if (!content) return renderChatMarkdownPlaintext(markdown, true);
	return renderAsPlaintext(renderChatRichContentHtml(markdown, content), { useLinkFormatter: true });
}

/** Projects a fragment as portable markup, without transcript-only controls or remote actions. */
export function renderChatRichContentHtml(markdown: string, content: ChatMarkdownRichContent): string {
	return renderWorkbenchMarkdown({ value: markdown, supportHtml: true }, false, { markedExtensions: getChatMarkdownExtensions(markdown, [chatMarkdownRichContentExtension(content, true)]) });
}

export function renderChatMarkdownPlaintext(markdown: string, useLinkFormatter = false): string {
	return renderAsPlaintext(markdown, { useLinkFormatter, markedExtensions: getChatMarkdownExtensions(markdown) });
}

/** Expands only the rich references so ordinary Markdown keeps its original formatting on copy. */
export function expandChatRichContentForCopy(markdown: string, content: ChatMarkdownRichContent | undefined): string {
	if (!content) return markdown;
	const parser = new Marked(...(getChatMarkdownExtensions(markdown, [chatMarkdownRichContentExtension(content, true)]) ?? []));
	const markers = new RegExp(escapeRegExpCharacters(content.markerPrefix) + '(\\d+):>', 'gu');
	return markdown.replace(markers, (marker: string, index: string, offset: number) => {
		const part = content.parts[Number(index)];
		if (!part) return marker;
		if (part.kind === 'writing') return expandChatRichContentForCopy(part.markdown, content);
		const end = offset + marker.length;
		const standaloneLayout = part.block && (offset === 0 || markdown[offset - 1] === '\n') && (end === markdown.length || markdown[end] === '\n')
			&& (part.kind === 'box' || part.kind === 'row' || part.kind === 'grid' || part.kind === 'gridItem' || part.kind === 'text');
		// Block parsing finalizes nested inline tokens. Keep the layout's line breaks so
		// adjacent labels and captions remain distinct when its wrappers are removed.
		const html = part.block ? parser.parse(marker, { async: false, breaks: standaloneLayout }) : parser.parseInline(marker, { async: false });
		if (standaloneLayout) {
			const body = convertHtmlToMarkdown(html);
			if (body) {
				const before = offset > 0 && markdown[offset - 2] !== '\n' ? '\n' : '';
				const after = end < markdown.length && markdown[end + 1] !== '\n' ? '\n' : '';
				return before + body + after;
			}
		}
		// A part embedded in a paragraph, list, or table must stay within its enclosing line.
		return html.replaceAll('\n', '&#10;').replaceAll('|', '&#124;');
	});
}
