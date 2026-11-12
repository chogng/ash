import { Lexer, Marked, type Token, type TokenizerThis, type Tokens } from '../../../../base/common/marked/marked.js';
import { basicMarkupHtmlTags, sanitizeHtmlToFragment } from '../../../../base/browser/domSanitize.js';
import { getDocument } from '../../../../base/browser/dom.js';
import { escapeMarkdownSyntaxTokens } from '../../../../base/common/htmlContent.js';
import { Icon } from '../../../../base/common/icon.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { getLxiconDefinition } from '../../../../base/common/lxiconsUtil.js';
import { isRecord } from '../../../../base/common/types.js';
import { renderAsPlaintext } from '../../../../base/browser/markdownRenderer.js';
import { escapeRegExpCharacters, htmlAttributeEncodeValue } from '../../../../base/common/strings.js';
import { localize } from '../../../../nls.js';
import type { ChatReplyReference, ChatReplyResource } from '../../../common/chatReplyBackend.js';
import { ChatMarkdownRichContentBuilder, type ChatMarkdownRichContent, type ChatMarkdownRichPart, type ChatMarkdownRichStyle } from '../../../../workbench/contrib/chat/common/model/chatMarkdownRichContent.js';
import { getMediaOrTextMime } from '../../../../base/common/mime.js';
import { chatGPTResourceKey, type ChatGPTImageGroup } from './chatGPTClient.js';
import type { ResponseCitation } from '../../../../platform/agentHost/common/agent.js';

interface RichTag {
	readonly name: string;
	readonly raw: string;
	readonly attributes: string;
	readonly closing: boolean;
	readonly selfClosing: boolean;
}

const inlineTags = new Set(['text', 'icon']);
const chatGPTFileLinkSchemes = ['sandbox', 'file-service', 'sediment'] as const;
const isChatGPTFileLink = (href: string): boolean => chatGPTFileLinkSchemes.some(scheme => href.startsWith(`${scheme}:`));
const mediaTags = new Set(['img', 'video', 'audio', 'iframe', 'canvas']);
// This is routing to the shared HTML renderer, not a second HTML implementation.
const htmlTags = new Set<string>([...basicMarkupHtmlTags, 'script', 'style', 'svg', 'path', 'line', 'title', 'desc', 'canvas', 'iframe', 'audio', 'math']);
const hiddenTags = new Set(['cite']);
const fallbackText = (): string => localize('sessions.chatgpt.viewContent', 'View this content in ChatGPT');
const iconText = new Map(Object.entries({ 'arrow-down': '↓', 'arrow-up': '↑', 'arrow-left': '←', 'arrow-right': '→', 'arrow-down-up': '⇅', check: '✓', x: '×', plus: '+', minus: '−', info: 'ⓘ', warning: '⚠' }));
const iconAliases = new Map([
	['arrow-down-up', Lxicon.sort.id],
	['minus', Lxicon.remove.id],
	['plus', Lxicon.add.id],
	['x', Lxicon.close.id],
]);

interface RichContent {
	readonly tag: RichTag;
	readonly raw: string;
	readonly body: string;
}

/** Read the component syntax as data; JSX expressions are never evaluated. */
function readTag(source: string, allowCaption: boolean): RichTag | undefined {
	const name = /^<\/?([a-z][\w-]*(?::[a-z][\w-]*)?)(?=[\s/>]|$)/iu.exec(source);
	if (!name) { return undefined; }
	const normalizedName = name[1].toLowerCase();
	if (htmlTags.has(normalizedName) && name[1] !== 'Cite' && !mediaTags.has(normalizedName) && !(allowCaption && normalizedName === 'caption')) { return undefined; }
	let quote = '', braces = 0;
	for (let index = name[0].length; index < Math.min(source.length, 8192); index++) {
		const character = source[index];
		if (quote) {
			if (character === '\\') { index++; }
			else if (character === quote) { quote = ''; }
		} else if (character === '"' || character === "'") { quote = character; }
		else if (character === '{') { braces++; }
		else if (character === '}') { braces--; }
		else if (character === '>' && braces === 0) {
			const raw = source.slice(0, index + 1);
			return { name: normalizedName, raw, attributes: raw.slice(name[0].length, -1).replace(/\/$/u, ''), closing: raw.startsWith('</'), selfClosing: raw.endsWith('/>') };
		}
		if (braces < 0) { return undefined; }
	}
	// A streaming reply can end inside an opening tag. Consume the unfinished
	// tag as a visible fallback instead of letting Marked drop the whole block.
	return { name: normalizedName, raw: source.slice(0, 8192), attributes: '', closing: false, selfClosing: true };
}

function codeEnd(source: string, index: number): number | undefined {
	const marker = /^(?:`+|~{3,})/u.exec(source.slice(index))?.[0];
	if (!marker) { return undefined; }
	const end = source.indexOf(marker, index + marker.length);
	return end < 0 ? undefined : end + marker.length;
}

/** Writing metadata is a transport envelope, not Markdown or executable attributes. */
function readWriting(source: string): { raw: string; body: string; } | undefined {
	const prefix = /^ {0,3}:::writing\{/u.exec(source);
	if (!prefix) { return undefined; }
	let quote = false;
	for (let index = prefix[0].length; index < Math.min(source.length, 8192); index++) {
		const character = source[index];
		if (character === '\\' && quote) { index++; continue; }
		if (character === '"') { quote = !quote; }
		if (character !== '}' || quote) { continue; }
		const start = index + 1;
		for (index = start; index < source.length;) {
			const end = codeEnd(source, index);
			if (end !== undefined) { index = end; continue; }
			if (source.startsWith(':::', index) && /^(?:\s|$)/u.test(source.slice(index + 3))) {
				return { raw: source.slice(0, index + 3), body: source.slice(start, index).trim() };
			}
			index++;
		}
		// The body is useful before its closing delimiter arrives during streaming.
		return { raw: source, body: source.slice(start).trim() };
	}
	return source.length < 8192 ? { raw: source, body: '' } : undefined;
}

function readContent(source: string, allowCaption: boolean): RichContent | undefined {
	const tag = readTag(source, allowCaption);
	if (!tag) { return undefined; }
	if (tag.closing) { return { tag, raw: tag.raw, body: '' }; }
	if (tag.selfClosing) { return { tag, raw: tag.raw, body: '' }; }
	let depth = 1;
	for (let index = tag.raw.length; index < source.length;) {
		const end = codeEnd(source, index);
		if (end !== undefined) { index = end; continue; }
		if (source[index] === '<') {
			const nested = readTag(source.slice(index), allowCaption);
			if (nested) {
				if (nested.name === tag.name && !nested.selfClosing) { depth += nested.closing ? -1 : 1; }
				if (depth === 0) {
					let length = index + nested.raw.length;
					if (tag.name === 'canvas') {
						const script = /^\s*<script(?:\s[^>]*)?>[\s\S]*?<\/script\s*>/iu.exec(source.slice(length));
						if (script) length += script[0].length;
					}
					return { tag, raw: source.slice(0, length), body: source.slice(tag.raw.length, index) };
				}
				index += nested.raw.length;
				continue;
			}
		}
		index++;
	}
	// An unmatched wrapper must not swallow subsequent paragraphs while a reply
	// streams (or if a component is malformed). Its children are parsed normally.
	return { tag, raw: tag.raw, body: '' };
}

function attributes(tag: RichTag): Map<string, string> {
	const result = new Map<string, string>();
	const source = tag.attributes;
	for (let index = 0; index < source.length;) {
		const match = /^\s*([a-z][\w-]*)(\s*=\s*)?/iu.exec(source.slice(index));
		if (!match) { break; }
		index += match[0].length;
		if (!match[2]) { result.set(match[1], 'true'); continue; }
		const start = index, first = source[index];
		if (first === '"' || first === "'" || first === '{') {
			let quote = first === '{' ? '' : first, braces = first === '{' ? 1 : 0;
			for (index++; index < source.length; index++) {
				const character = source[index];
				if (character === '\\') { index++; continue; }
				if (quote) { if (character === quote) { quote = ''; if (!braces) { break; } } }
				else if (character === '"' || character === "'") { quote = character; }
				else if (character === '{') { braces++; }
				else if (character === '}' && --braces === 0) { break; }
			}
			result.set(match[1], source.slice(start + 1, index));
			index++;
		} else {
			while (index < source.length && !/\s/u.test(source[index])) { index++; }
			result.set(match[1], source.slice(start, index));
		}
	}
	return result;
}

function description(tag: RichTag): string {
	const values = attributes(tag);
	return [...new Set(['title', 'label', 'alt', 'caption', 'description', 'text'].flatMap(key => values.has(key) ? [values.get(key)!] : []))].join(' — ');
}

function componentData(tag: RichTag): string {
	const values = attributes(tag);
	const data = values.get('data');
	if (!data) {
		const properties = Object.fromEntries([...values].filter(([key]) => !['title', 'label', 'alt', 'caption', 'description', 'text'].includes(key)));
		return Object.keys(properties).length ? JSON.stringify(properties, null, 2) : '';
	}
	try { return JSON.stringify(JSON.parse(data), null, 2); }
	catch { return data; } // Retain unfamiliar expressions as text, never execute them.
}

function style(values: ReadonlyMap<string, string>): ChatMarkdownRichStyle {
	const border = values.get('border');
	return {
		radius: values.get('radius'), padding: values.get('padding'), gap: values.get('gap'),
		align: values.get('textAlign') ?? values.get('align'), justify: values.get('justify'), background: values.get('background'),
		color: values.get('color'), size: values.get('size'), border,
		borderColor: /\bcolor\s*:\s*["']([^"']+)["']/u.exec(border ?? '')?.[1],
	};
}

function gridColumns(value: string | undefined): 1 | 2 | 3 | 4 {
	switch (value?.trim()) {
		case '2': return 2;
		case '3': return 3;
		case '4': return 4;
		default: return 1;
	}
}

const lexerDepth = new WeakMap<TokenizerThis['lexer'], number>();
function tokenize(this: TokenizerThis, source: string, level: 'block' | 'inline', previous: readonly Token[]): Tokens.Generic | undefined {
	if (this.lexer.state.inRawBlock) { return undefined; }
	const depth = lexerDepth.get(this.lexer) ?? 0;
	const leading = /^ {0,3}(?=<)/u.exec(source)?.[0] ?? '';
	const markup = source.slice(leading.length);
	// A layout caption is distinct from the HTML caption that names a table.
	const isLayoutCaption = depth > 0 && level === 'block' && /^<\/?caption(?=[\s/>]|$)/iu.test(markup);
	// SVG's standard <text> element shares a spelling with the web component.
	// Let the shared HTML renderer own it while an SVG namespace is open.
	let svgDepth = 0, tableDepth = 0;
	for (const token of previous) {
		if (token.type !== 'html') { continue; }
		for (const match of token.raw.matchAll(/<\/?svg\b[^>]*>/giu)) {
			svgDepth += match[0].startsWith('</') ? -1 : match[0].endsWith('/>') ? 0 : 1;
		}
		if (isLayoutCaption) {
			for (const match of token.raw.matchAll(/<\/?table\b[^>]*>/giu)) {
				tableDepth += match[0].startsWith('</') ? -1 : 1;
			}
		}
	}
	if (svgDepth > 0) { return undefined; }
	const content = readContent(markup, isLayoutCaption && tableDepth === 0);
	if (!content) { return undefined; }
	const inline = inlineTags.has(content.tag.name) || level === 'inline';
	const lines = content.body.split('\n');
	let indentation = Infinity;
	for (const line of lines) {
		if (line.trim()) { indentation = Math.min(indentation, /^[ \t]*/u.exec(line)![0].length); }
	}
	// Remove the component's common indentation, preserving indentation inside code.
	const body = inline ? content.body : lines.map(line => line.slice(Number.isFinite(indentation) ? indentation : 0)).join('\n').trim();
	let tokens: Token[] = [];
	const literal = depth >= 32 || content.tag.name === 'code';
	if (!literal && !hiddenTags.has(content.tag.name)) {
		lexerDepth.set(this.lexer, depth + 1);
		try { tokens = inline ? this.lexer.inlineTokens(body) : this.lexer.blockTokens(body); }
		finally { lexerDepth.set(this.lexer, depth); }
	}
	return { type: 'chatgptRichContent', raw: leading + content.raw, tag: content.tag, tokens, inline, literal: literal ? renderAsPlaintext(body) : undefined, body };
}

function referencesFor(ids: readonly string[], references: readonly ChatReplyReference[]) {
	return [...new Set(ids)].flatMap(id => {
		const exact = references.find(reference => reference.id === id);
		const candidates = references.filter(reference => reference.id.replace(/^turn\d+/u, '') === id.replace(/^turn\d+/u, ''));
		const reference = exact ?? (candidates.length === 1 ? candidates[0] : undefined);
		const url = parseWebLink(reference?.url);
		return reference && url ? [{ ...reference, url, number: references.indexOf(reference) + 1 }] : [];
	});
}

function richContentLexer(): Marked {
	return new Marked({
		extensions: [...(['block', 'inline'] as const).map(level => ({
			name: 'chatgptRichContent', level,
			tokenizer(this: TokenizerThis, source: string, tokens: Token[]) { return tokenize.call(this, source, level, tokens); },
			childTokens: ['tokens'],
			start(source: string) {
				if (level === 'inline') return source.search(/<\/?[a-z][\w-]*(?::[a-z][\w-]*)?(?=[\s/>]|$)/iu);
				// Marked searches after the first character. Start only on a new line so code spans stay intact.
				const match = /\n {0,3}<\/?[a-z][\w-]*(?::[a-z][\w-]*)?(?=[\s/>]|$)/iu.exec(source);
				return match ? match.index + 1 : -1;
			},
		})), {
			name: 'chatgptWebReference', level: 'inline',
			start: source => source.indexOf('\uE200'),
			tokenizer(source) {
				if (this.lexer.state.inRawBlock) return undefined;
				const imageGroup = /^\uE200image_group\uE202[^\uE200\uE201\r\n]*(?:\uE201|$)/u.exec(source);
				if (imageGroup) return { type: 'chatgptWebReference', raw: imageGroup[0], kind: 'image_group' };
				const genui = /^\uE200genui\uE202([^\uE200\uE201\r\n]*)(?:\uE201|$)/u.exec(source);
				if (genui) return { type: 'chatgptWebReference', raw: genui[0], kind: 'genui', payload: genui[0].endsWith('\uE201') ? genui[1] : '' };
				const match = /^\uE200(cite|url|entity)\uE202([^\uE200\uE201\r\n]*)\uE201/u.exec(source);
				if (!match) return undefined;
				return { type: 'chatgptWebReference', raw: match[0], kind: match[1], payload: match[2] };
			},
		}, {
			name: 'chatgptWriting', level: 'block',
			start: source => /\n {0,3}:::writing\{/u.exec(source)?.index ?? -1,
			tokenizer(source) {
				const depth = lexerDepth.get(this.lexer) ?? 0;
				if (depth >= 32) return undefined;
				const writing = readWriting(source);
				if (!writing) return undefined;
				lexerDepth.set(this.lexer, depth + 1);
				try { return { type: 'chatgptWriting', raw: writing.raw, body: writing.body, tokens: this.lexer.blockTokens(writing.body) }; }
				finally { lexerDepth.set(this.lexer, depth); }
			},
		}],
	});
}

function dataUri(mimeType: string, source: string): string {
	return 'data:' + mimeType + ';charset=utf-8,' + encodeURIComponent(source);
}

function entityPart(label: string, category: unknown, disambiguation: unknown, block: boolean): ChatMarkdownRichPart {
	if (typeof category !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(category) || label.length > 256) {
		return { kind: 'textLiteral', label, block };
	}
	return { kind: 'entity', entity: { label, category, disambiguation: typeof disambiguation === 'string' ? disambiguation.slice(0, 1024) : '' }, block };
}

function readWebUrl(value: string | undefined): URL | undefined {
	const url = value ? URL.parse(value) : null;
	return url && (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url : undefined;
}

function stripChatGPTAttribution(href: string): string | undefined {
	const start = href.indexOf('?');
	const fragment = href.indexOf('#');
	if (start < 0 || (fragment >= 0 && fragment < start)) return undefined;
	const end = fragment < 0 ? href.length : fragment;
	// Keep the encoding and order of the site's other query fields.
	const fields = href.slice(start + 1, end).split('&');
	const kept = fields.filter(field => !new URLSearchParams('?' + field).has('utm_source', 'chatgpt.com'));
	if (kept.length === fields.length) return undefined;
	const query = kept.join('&');
	return href.slice(0, start) + (query ? '?' + query : '') + href.slice(end);
}

function parseWebLink(value: string | undefined): string | undefined {
	const url = readWebUrl(value);
	return url && (stripChatGPTAttribution(url.href) ?? url.href);
}

/** Projects Web-specific syntax and resources into Ash's response model. */
export function decodeChatGPTReply(text: string, references: readonly ChatReplyReference[] = [], conversationId?: string, imageGroups: readonly ChatGPTImageGroup[] = []): {
	readonly text: string;
	readonly richContent?: ChatMarkdownRichContent;
	readonly resources: readonly ChatReplyResource[];
	readonly citations?: readonly ResponseCitation[];
} {
	const normalized = text.replace(/\r\n?/gu, '\n');
	const citations = new Map<string, Extract<ResponseCitation, { type: 'web'; }>>();
	const addCitation = ({ url, title }: Pick<ChatReplyReference, 'url' | 'title'>): void => {
		if (!citations.has(url)) citations.set(url, { type: 'web', url, title });
	};
	for (const reference of references) {
		if (!reference.cited) continue;
		const url = parseWebLink(reference.url);
		if (url) addCitation({ url, title: reference.title });
	}
	if (!/[<\[\uE200]|:::writing\{/u.test(normalized) && !/(?:https?:\/\/|www\.)\S*\?/iu.test(normalized)) {
		return { text: normalized, resources: [], ...(citations.size && { citations: [...citations.values()] }) };
	}
	const resources: ChatReplyResource[] = [];
	const richContent = new ChatMarkdownRichContentBuilder(normalized);
	const fallback = {
		href: 'https://chatgpt.com/' + (conversationId ? 'c/' + encodeURIComponent(conversationId) : ''),
		label: fallbackText(),
	};

	function resourcePart(resource: ChatReplyResource, block: boolean, data?: string): ChatMarkdownRichPart {
		resources.push(resource);
		return { kind: 'resource', label: resource.name, markdown: '', block, data };
	}

	function citationPart(ids: readonly string[], block: boolean): ChatMarkdownRichPart | '' {
		const entries = referencesFor(ids, references);
		entries.forEach(addCitation);
		return entries.length ? { kind: 'citations', entries, block } : '';
	}

	function projectComponent(token: Tokens.Generic): ChatMarkdownRichPart | '' {
		const tag = token.tag as RichTag;
		if (tag.closing) return '';
		const block = !token.inline;
		const values = attributes(tag);
		if (tag.name === 'divider') return { kind: 'markdown', markdown: '---', block: true };
		if (tag.name === 'link') {
			const href = parseWebLink(values.get('url'));
			const label = values.get('title')?.trim() || values.get('label')?.trim() || renderAsPlaintext(token.body) || href || '';
			return href ? { kind: 'link', link: { href, label }, external: true, block } : { kind: 'textLiteral', label, block };
		}
		if (tag.name === 'asyncimage') {
			const query = values.get('query');
			const group = imageGroups.find(group => 'query' in group && group.query === query);
			return group ? { kind: 'imageGallery', images: group.images, compact: true, block } : { kind: 'unavailableMedia', fallback, block };
		}
		if (tag.name === 'entity') {
			// Saved replies can carry the label as an attribute or inside a data object.
			const value = values.get('value');
			if (value?.trim()) return entityPart(value, values.get('category'), values.get('disambig'), block);
			const data = values.get('data');
			if (data) {
				try {
					const entity: unknown = JSON.parse(data);
					if (typeof entity === 'object' && entity !== null && 'value' in entity && typeof entity.value === 'string' && entity.value.trim()) {
						return entityPart(entity.value, 'category' in entity ? entity.category : undefined, 'disambig' in entity ? entity.disambig : undefined, block);
					}
				} catch { /* Keep the generic fallback for malformed entity data. */ }
			}
		}
		const label = description(tag);
		if (hiddenTags.has(tag.name)) return citationPart(values.get('refs')?.match(/turn\d+[a-z]+\d+/giu) ?? [], block);
		if (mediaTags.has(tag.name)) {
			const name = label || localize('sessions.chatgpt.interactive', 'Interactive content');
			if (tag.name === 'canvas') return resourcePart({ uri: dataUri('text/html', token.raw), name, kind: 'html' }, block);
			if (tag.name === 'iframe' && values.has('srcdoc')) {
				// Decode the attribute as inert text. The shared preview owns its isolated document.
				const encoded = values.get('srcdoc')!.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
				const html = sanitizeHtmlToFragment(encoded, { ownerDocument: getDocument() }).textContent ?? '';
				return resourcePart({ uri: dataUri('text/html', html), name, kind: 'html' }, block);
			}
			const uri = values.get('src');
			if (uri && tag.name === 'iframe') {
				try {
					const url = new URL(uri);
					if (url.protocol === 'https:' && !url.username && !url.password) {
						return resourcePart({ uri: url.href, name, kind: 'html', frameOrigin: url.origin }, block);
					}
				} catch { /* Preserve the label for a malformed frame target. */ }
			}
			if (uri) {
				const kind = tag.name === 'img' ? 'image' : tag.name === 'iframe' ? 'html' : tag.name as 'audio' | 'video';
				return resourcePart({ uri, name: label || localize('sessions.chatgpt.media', 'Media'), kind }, block);
			}
			return { kind: 'unavailableMedia', fallback, block };
		}
		if (tag.name === 'icon') {
			const name = values.get('name') ?? '';
			const iconId = iconAliases.get(name) ?? name;
			const icon = getLxiconDefinition(iconId) ? Icon.fromId(iconId) : undefined;
			return { kind: 'icon', icon, label: iconText.get(name) ?? (label || name), style: style(values), fallback, block };
		}
		if (typeof token.literal === 'string') return { kind: 'textLiteral', label: token.literal, block };
		const markdown = decode(token.body, token.tokens ?? [], !block);
		if (tag.name === 'box' || tag.name === 'row' || tag.name === 'text') {
			return { kind: tag.name, markdown, style: style(values), fallback, block };
		}
		if (tag.name === 'grid') {
			return markdown ? { kind: 'grid', columns: gridColumns(values.get('columns')), markdown, style: style(values), block } : '';
		}
		if (tag.name === 'grid-item') {
			return { kind: 'gridItem', markdown, block };
		}
		if (tag.name === 'caption') {
			const presentation = style(values);
			return markdown ? { kind: 'text', markdown, style: { ...presentation, color: presentation.color ?? 'secondary', size: presentation.size ?? 'sm' }, block } : '';
		}
		const data = componentData(tag);
		if (tag.name === 'chart' && data) {
			try {
				JSON.parse(data);
				return resourcePart({ uri: dataUri('application/json', data), name: label || localize('chat.chart.label', 'Chart'), kind: 'chart' }, block, data);
			} catch { /* Display invalid chart data as inert text. */ }
		}
		return label || markdown || data ? { kind: 'details', label, data, markdown, block } : '';
	}

	function projectReference(token: Tokens.Generic): ChatMarkdownRichPart | '' {
		if (token.kind === 'image_group') {
			const group = imageGroups.find(group => 'marker' in group && group.marker === token.raw);
			// The marker contains search terms. Only its matching metadata can supply gallery images.
			return group ? { kind: 'imageGallery', images: group.images, block: true } : '';
		}
		const payload = token.payload as string;
		if (token.kind === 'genui') {
			if (!payload) return '';
			const group = imageGroups.find(group => 'marker' in group && group.marker === token.raw);
			if (group) return { kind: 'imageGallery', images: group.images, block: true };
			try {
				const value: unknown = JSON.parse(payload);
				if (isRecord(value) && 'citation' in value) {
					if (!isRecord(value.citation)) return '';
					const { ref, refs } = value.citation;
					const ids = [ref, ...(Array.isArray(refs) ? refs : [])];
					return citationPart(ids.filter((id): id is string => typeof id === 'string'), false);
				}
				const entities = isRecord(value) && isRecord(value.entity_thumbnail_list) ? value.entity_thumbnail_list.entities : undefined;
				if (Array.isArray(entities)) {
					const plain = (text: string) => escapeMarkdownSyntaxTokens(text.replace(/\s+/gu, ' ')).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
					const entries = entities.slice(0, 12).flatMap(entity => isRecord(entity) && typeof entity.name === 'string' && entity.name.trim()
						? [`- **${plain(entity.name.slice(0, 256))}**${typeof entity.desc === 'string' ? ` — ${plain(entity.desc.slice(0, 1024))}` : ''}`] : []);
					if (entries.length) return { kind: 'markdown', markdown: entries.join('\n'), block: true };
				}
			} catch { /* A malformed provider envelope has no renderable content. */ }
			return { kind: 'unavailableMedia', fallback, block: true };
		}
		if (token.kind === 'entity') {
			try {
				const entity: unknown = JSON.parse(payload);
				return Array.isArray(entity) && typeof entity[1] === 'string' && entity[1].trim() ? entityPart(entity[1], entity[0], entity[2], false) : '';
			} catch { return ''; }
		}
		const parts = payload.split('\uE202');
		if (token.kind === 'cite') return citationPart(parts, false);
		const [label = '', ...targets] = parts;
		const reference = references.find(reference => targets.includes(reference.id));
		const direct = targets.find(target => /^https?:\/\//iu.test(target));
		const href = parseWebLink(reference?.url) ?? parseWebLink(direct);
		const snippet = reference?.snippet.trim();
		const title = snippet && reference?.title && reference.title !== label ? `${reference.title}\n${snippet}` : snippet;
		if (href) addCitation({ url: href, title: reference?.title || label });
		return href ? { kind: 'link', link: { href, label }, title, block: false } : { kind: 'textLiteral', label, block: false };
	}

	function project(token: Token, inline: boolean): ChatMarkdownRichPart | '' | undefined {
		if (token.type === 'chatgptRichContent') return projectComponent(token);
		if (token.type === 'chatgptWebReference') return projectReference(token);
		if (token.type === 'chatgptWriting') {
			return { kind: 'markdown', markdown: decode(token.body, token.tokens ?? [], false), block: true };
		}
		if (token.type === 'html' && /^\s*<\/?(?:script|style)\b/iu.test(token.raw)) return '';
		if (token.type === 'image' && !token.href.startsWith('data:image/')) {
			return resourcePart({ uri: token.href, name: token.text || localize('sessions.chatgpt.image', 'Image'), kind: 'image' }, !inline);
		}
		if (token.type === 'link' && isChatGPTFileLink(token.href)) {
			const uri = chatGPTResourceKey(token.href);
			const name = token.text || token.href.split('/').at(-1) || localize('sessions.chatgpt.file', 'File');
			const mimeType = getMediaOrTextMime(token.href);
			let kind: ChatReplyResource['kind'] = 'document';
			if (mimeType?.startsWith('image/')) kind = 'image';
			else if (mimeType?.startsWith('audio/')) kind = 'audio';
			else if (mimeType?.startsWith('video/')) kind = 'video';
			else if (mimeType === 'text/html') kind = 'html';
			const available = conversationId || !uri.startsWith('sandbox:');
			if (available) resources.push({ uri, name, kind, mimeType });
			return { kind: 'resource', label: name, markdown: decode(token.text, token.tokens ?? [], true), uri: available ? uri : undefined, title: token.title ?? undefined, block: false };
		}
		return undefined;
	}

	function rewriteBodyLink(token: Tokens.Link, raw: string, tableCell: boolean): string | undefined {
		let href = token.href;
		if (!token.autolink && href.includes('&')) {
			let decoder: HTMLTextAreaElement | undefined;
			href = href.replace(/&(?:#(?:\d+|x[\da-f]+)|[a-z][a-z\d]*);/giu, entity => {
				decoder ??= getDocument().createElement('textarea');
				decoder.innerHTML = entity;
				return decoder.value;
			});
		}
		const target = stripChatGPTAttribution(href);
		if (!target || !readWebUrl(href)) return undefined;
		const escapeCell = (value: string) => tableCell ? value.replaceAll('|', '\\|') : value;
		const destination = escapeCell(htmlAttributeEncodeValue(target).replaceAll('\\', '\\\\'));
		if (token.autolink) {
			const visibleUrl = token.href === 'http://' + token.text ? target.slice('http://'.length) : target;
			const label = escapeCell(escapeMarkdownSyntaxTokens(htmlAttributeEncodeValue(visibleUrl)));
			return `[${label}](<${destination}>)`;
		}
		// Keep the original Markdown label, including escapes and inline formatting.
		const rules = Lexer.rules.inline.gfm;
		const link = rules.link.exec(raw);
		const label = link?.[1] ?? rules.reflink.exec(raw)?.[1] ?? rules.nolink.exec(raw)?.[1];
		if (label === undefined) return undefined;
		const title = link ? link[3] : token.title && `"${escapeCell(token.title.replace(/[\\"]/gu, '\\$&'))}"`;
		return `[${decode(label, token.tokens, true, tableCell)}](<${destination}>${title ? ' ' + title : ''})`;
	}

	function decode(source: string, tokens: readonly Token[], inline: boolean, tableCell = false): string {
		let cursor = 0;
		let result = '';
		let previous: Token | undefined;
		for (const token of tokens) {
			let raw = token.raw;
			const escapedPipe = tableCell && raw.includes('|');
			let start = escapedPipe ? -1 : source.indexOf(raw, cursor);
			const prefixedLines = raw.includes('\n') && (raw.includes('\uE200') || raw.includes('?'));
			if (start < 0 && (escapedPipe || prefixedLines)) {
				// Marked removes table escapes and strips prefixes from children of Markdown containers.
				let patternSource = escapeRegExpCharacters(raw);
				if (prefixedLines) patternSource = patternSource.replaceAll('\n', '\n[ \t>]*?');
				if (escapedPipe) patternSource = patternSource.replaceAll(String.raw`\|`, String.raw`\\\|`);
				const pattern = new RegExp(patternSource, 'gu');
				pattern.lastIndex = cursor;
				const match = pattern.exec(source);
				if (match) { start = match.index; raw = match[0]; }
			}
			if (start < 0) continue;
			result += source.slice(cursor, start);
			const part = project(token, inline);
			const link = part === undefined && token.type === 'link' ? rewriteBodyLink(token as Tokens.Link, raw, tableCell) : undefined;
			if (part !== undefined) {
				if (part && part.kind === 'citations' && previous?.type === 'paragraph' && !inline) {
					// Web replies also send citations on their own line after the paragraph they support.
					result = result.trimEnd() + ' ' + richContent.add({ ...part, block: false });
				} else if (part) {
					result += richContent.add(part);
				}
				if (!inline) result += '\n';
			} else if (link !== undefined) {
				result += link;
			} else if (token.type === 'list') {
				result += decode(raw, token.items, false);
			} else if (token.type === 'table') {
				result += decode(raw, [token.header, ...token.rows].flatMap(row => row.flatMap((cell: Tokens.TableCell) => cell.tokens)), true, true);
			} else if ('tokens' in token && Array.isArray(token.tokens) && token.tokens.length) {
				result += decode(raw, token.tokens, true, tableCell);
			} else {
				result += raw;
			}
			cursor = start + raw.length;
			if (token.type !== 'space') previous = token;
		}
		return result + source.slice(cursor);
	}

	const decoded = decode(normalized, richContentLexer().lexer(normalized), false);
	return { text: decoded, richContent: richContent.content, resources, ...(citations.size && { citations: [...citations.values()] }) };
}
