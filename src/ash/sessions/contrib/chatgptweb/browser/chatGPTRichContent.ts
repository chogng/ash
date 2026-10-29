import type { MarkedExtension, Token, TokenizerThis, Tokens } from '../../../../base/common/marked/marked.js';
import { basicMarkupHtmlTags, sanitizeHtmlToFragment } from '../../../../base/browser/domSanitize.js';
import { getDocument } from '../../../../base/browser/dom.js';
import {
	allowedMarkdownHtmlAttributes,
	renderAsPlaintext,
	renderWorkbenchMarkdown,
	type MarkdownRenderOptions,
} from '../../../../base/browser/markdownRenderer.js';
import { htmlAttributeEncodeValue } from '../../../../base/common/strings.js';
import { localize } from '../../../../nls.js';
import type { ChatGPTReference, ChatGPTResource } from './chatGPTClient.js';
import { isRecord } from '../../../../base/common/types.js';
import { getMediaOrTextMime } from '../../../../base/common/mime.js';

interface RichTag {
	readonly name: string;
	readonly raw: string;
	readonly attributes: string;
	readonly closing: boolean;
	readonly selfClosing: boolean;
}

const inlineTags = new Set(['text', 'icon']);
const mediaTags = new Set(['img', 'video', 'audio', 'iframe', 'canvas']);
// This is routing to the shared HTML renderer, not a second HTML implementation.
const htmlTags = new Set<string>([
	...basicMarkupHtmlTags,
	'script',
	'style',
	'svg',
	'path',
	'line',
	'title',
	'desc',
	'canvas',
	'iframe',
	'audio',
	'math',
]);
const hiddenTags = new Set(['cite']);
const iconText = new Map(
	Object.entries({
		'arrow-down': '↓',
		'arrow-up': '↑',
		'arrow-left': '←',
		'arrow-right': '→',
		check: '✓',
		x: '×',
		plus: '+',
		minus: '−',
		info: 'ⓘ',
		warning: '⚠',
	}),
);
const escapeHTML = htmlAttributeEncodeValue;
const fallbackText = (): string => localize('sessions.chatgpt.viewContent', 'View this content in ChatGPT');
const fallbackHTML = (): string =>
	`<a class="ash-chatgpt-rich-fallback" href="https://chatgpt.com/">${escapeHTML(fallbackText())}</a>`;

interface RichContent {
	readonly tag: RichTag;
	readonly raw: string;
	readonly body: string;
}

/** Read the component syntax as data; JSX expressions are never evaluated. */
function readTag(source: string): RichTag | undefined {
	const name = /^<\/?([a-z][\w-]*(?::[a-z][\w-]*)?)(?=[\s/>]|$)/iu.exec(source);
	if (!name || (htmlTags.has(name[1].toLowerCase()) && name[1] !== 'Cite' && !mediaTags.has(name[1].toLowerCase()))) {
		return undefined;
	}
	let quote = '',
		braces = 0;
	for (let index = name[0].length; index < Math.min(source.length, 8192); index++) {
		const character = source[index];
		if (quote) {
			if (character === '\\') {
				index++;
			} else if (character === quote) {
				quote = '';
			}
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (character === '{') {
			braces++;
		} else if (character === '}') {
			braces--;
		} else if (character === '>' && braces === 0) {
			const raw = source.slice(0, index + 1);
			return {
				name: name[1].toLowerCase(),
				raw,
				attributes: raw.slice(name[0].length, -1).replace(/\/$/u, ''),
				closing: raw.startsWith('</'),
				selfClosing: raw.endsWith('/>'),
			};
		}
		if (braces < 0) {
			return undefined;
		}
	}
	// A streaming reply can end inside an opening tag. Consume the unfinished
	// tag as a visible fallback instead of letting Marked drop the whole block.
	return {
		name: name[1].toLowerCase(),
		raw: source.slice(0, 8192),
		attributes: '',
		closing: false,
		selfClosing: true,
	};
}

function codeEnd(source: string, index: number): number | undefined {
	const marker = /^(?:`+|~{3,})/u.exec(source.slice(index))?.[0];
	if (!marker) {
		return undefined;
	}
	const end = source.indexOf(marker, index + marker.length);
	return end < 0 ? undefined : end + marker.length;
}

/** Writing metadata is a transport envelope, not Markdown or executable attributes. */
function readWriting(source: string): { raw: string; body: string } | undefined {
	const prefix = /^ {0,3}:::writing\{/u.exec(source);
	if (!prefix) {
		return undefined;
	}
	let quote = false;
	for (let index = prefix[0].length; index < Math.min(source.length, 8192); index++) {
		const character = source[index];
		if (character === '\\' && quote) {
			index++;
			continue;
		}
		if (character === '"') {
			quote = !quote;
		}
		if (character !== '}' || quote) {
			continue;
		}
		const start = index + 1;
		for (index = start; index < source.length;) {
			const end = codeEnd(source, index);
			if (end !== undefined) {
				index = end;
				continue;
			}
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

function readContent(source: string): RichContent | undefined {
	const tag = readTag(source);
	if (!tag) {
		return undefined;
	}
	if (tag.closing) {
		return { tag, raw: tag.raw, body: '' };
	}
	if (tag.selfClosing) {
		return { tag, raw: tag.raw, body: '' };
	}
	let depth = 1;
	for (let index = tag.raw.length; index < source.length;) {
		const end = codeEnd(source, index);
		if (end !== undefined) {
			index = end;
			continue;
		}
		if (source[index] === '<') {
			const nested = readTag(source.slice(index));
			if (nested) {
				if (nested.name === tag.name && !nested.selfClosing) {
					depth += nested.closing ? -1 : 1;
				}
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
		if (!match) {
			break;
		}
		index += match[0].length;
		if (!match[2]) {
			result.set(match[1], 'true');
			continue;
		}
		const start = index,
			first = source[index];
		if (first === '"' || first === "'" || first === '{') {
			let quote = first === '{' ? '' : first,
				braces = first === '{' ? 1 : 0;
			for (index++; index < source.length; index++) {
				const character = source[index];
				if (character === '\\') {
					index++;
					continue;
				}
				if (quote) {
					if (character === quote) {
						quote = '';
						if (!braces) {
							break;
						}
					}
				} else if (character === '"' || character === "'") {
					quote = character;
				} else if (character === '{') {
					braces++;
				} else if (character === '}' && --braces === 0) {
					break;
				}
			}
			result.set(match[1], source.slice(start + 1, index));
			index++;
		} else {
			while (index < source.length && !/\s/u.test(source[index])) {
				index++;
			}
			result.set(match[1], source.slice(start, index));
		}
	}
	return result;
}

function description(tag: RichTag): string {
	const values = attributes(tag);
	return [
		...new Set(
			['title', 'label', 'alt', 'caption', 'description', 'text'].flatMap(key =>
				values.has(key) ? [values.get(key)!] : [],
			),
		),
	].join(' — ');
}

function componentData(tag: RichTag): string {
	const values = attributes(tag);
	const data = values.get('data');
	if (!data) {
		const properties = Object.fromEntries(
			[...values].filter(([key]) => !['title', 'label', 'alt', 'caption', 'description', 'text'].includes(key)),
		);
		return Object.keys(properties).length ? JSON.stringify(properties, null, 2) : '';
	}
	try {
		return JSON.stringify(JSON.parse(data), null, 2);
	} catch {
		return data;
	} // Retain unfamiliar expressions as text, never execute them.
}

function colorClass(property: 'background' | 'border', value: string | undefined): string | undefined {
	const match =
		value &&
		/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0(?:\.\d+)?|1(?:\.0+)?))?\s*\)$/u.exec(value);
	if (!match || match.slice(1, 4).some(channel => Number(channel) > 255)) {
		return undefined;
	}
	return `${property}-rgba-${match[1]}-${match[2]}-${match[3]}-${(match[4] ?? '1').replace('.', 'p')}`;
}

function classes(tag: RichTag): string {
	const values = attributes(tag);
	const result = ['ash-chatgpt-rich', `ash-chatgpt-rich-${tag.name}`];
	// Only named presentation variants reach HTML. Unknown attributes, event
	// handlers and arbitrary expressions have no effect on the host document.
	const variants: ReadonlyArray<readonly [string, readonly string[]]> = [
		['radius', ['sm', 'md', 'lg']],
		['padding', ['0', '1', '2', '3', '4']],
		['gap', ['0', '1', '2', '3', '4']],
		['align', ['start', 'center', 'end', 'stretch']],
		['justify', ['start', 'center', 'end']],
		['background', ['surface', 'surface-secondary']],
		['color', ['secondary']],
		['size', ['xs', 'sm', 'lg']],
	];
	for (const [name, allowed] of variants) {
		const value = values.get(name);
		if (value && allowed.includes(value)) {
			result.push(`${name}-${value}`);
		}
	}
	if (values.has('border')) {
		result.push('border');
	}
	const background = colorClass('background', values.get('background'));
	const border = colorClass('border', /\bcolor\s*:\s*["']([^"']+)["']/u.exec(values.get('border') ?? '')?.[1]);
	if (background) {
		result.push(background);
	}
	if (border) {
		result.push(border);
	}
	return result.join(' ');
}

const lexerDepth = new WeakMap<TokenizerThis['lexer'], number>();
function tokenize(
	this: TokenizerThis,
	source: string,
	level: 'block' | 'inline',
	previous: readonly Token[],
): Tokens.Generic | undefined {
	if (this.lexer.state.inRawBlock) {
		return undefined;
	}
	// SVG's standard <text> element shares a spelling with the web component.
	// Let the shared HTML renderer own it while an SVG namespace is open.
	let svgDepth = 0;
	for (const token of previous) {
		if (token.type !== 'html') {
			continue;
		}
		for (const match of token.raw.matchAll(/<\/?svg\b[^>]*>/giu)) {
			svgDepth += match[0].startsWith('</') ? -1 : match[0].endsWith('/>') ? 0 : 1;
		}
	}
	if (svgDepth > 0) {
		return undefined;
	}
	const leading = /^ {0,3}(?=<)/u.exec(source)?.[0] ?? '';
	const content = readContent(source.slice(leading.length));
	if (!content) {
		return undefined;
	}
	const inline = inlineTags.has(content.tag.name) || level === 'inline';
	const lines = content.body.split('\n');
	let indentation = Infinity;
	for (const line of lines) {
		if (line.trim()) {
			indentation = Math.min(indentation, /^[ \t]*/u.exec(line)![0].length);
		}
	}
	// Remove the component's common indentation, preserving indentation inside code.
	const body = inline
		? content.body
		: lines
				.map(line => line.slice(Number.isFinite(indentation) ? indentation : 0))
				.join('\n')
				.trim();
	const depth = lexerDepth.get(this.lexer) ?? 0;
	let tokens: Token[] = [];
	const literal = depth >= 32 || content.tag.name === 'code';
	if (!literal && !hiddenTags.has(content.tag.name)) {
		lexerDepth.set(this.lexer, depth + 1);
		try {
			tokens = inline ? this.lexer.inlineTokens(body) : this.lexer.blockTokens(body);
		} finally {
			lexerDepth.set(this.lexer, depth);
		}
	}
	return {
		type: 'chatgptRichContent',
		raw: leading + content.raw,
		tag: content.tag,
		tokens,
		inline,
		literal: literal ? renderAsPlaintext(body) : undefined,
		hasBody: !!body,
	};
}

function resourceMarkup(resource: ChatGPTResource): string {
	return `<span class="ash-chatgpt-resource" data-chatgpt-resource="${escapeHTML(JSON.stringify(resource))}">${escapeHTML(resource.name)}</span>`;
}

function referenceMarkup(ids: readonly string[], references: readonly ChatGPTReference[]): string {
	const selected = [...new Set(ids)].flatMap(id => {
		const exact = references.find(reference => reference.id === id);
		const candidates = references.filter(
			reference => reference.id.replace(/^turn\d+/u, '') === id.replace(/^turn\d+/u, ''),
		);
		const reference = exact ?? (candidates.length === 1 ? candidates[0] : undefined);
		return reference ? [reference] : [];
	});
	if (!selected.length) return '';
	return `<details class="ash-chatgpt-citation"><summary>${selected.map(reference => `[${references.indexOf(reference) + 1}]`).join(' ')}</summary>${selected.map(reference => `<div><a href="${escapeHTML(reference.url)}">${escapeHTML(reference.title)}</a><p>${escapeHTML(reference.snippet)}</p></div>`).join('')}</details>`;
}

function createRichContentExtension(references: readonly ChatGPTReference[] = [], plaintext = false): MarkedExtension {
	return {
		renderer: {
			image(token) {
				if (token.href.startsWith('data:image/'))
					return `<img src="${escapeHTML(token.href)}" alt="${escapeHTML(token.text)}">`;
				return resourceMarkup({
					uri: token.href,
					name: token.text || localize('sessions.chatgpt.image', 'Image'),
					kind: 'image',
				});
			},
			link(token) {
				if (/^(?:sandbox:|file-service:|sediment:)/u.test(token.href)) {
					const mimeType = getMediaOrTextMime(token.href);
					let kind: ChatGPTResource['kind'] = 'document';
					if (mimeType?.startsWith('image/')) kind = 'image';
					else if (mimeType?.startsWith('audio/')) kind = 'audio';
					else if (mimeType?.startsWith('video/')) kind = 'video';
					else if (mimeType === 'text/html') kind = 'html';
					return resourceMarkup({
						uri: token.href,
						name: token.text || token.href.split('/').at(-1) || localize('sessions.chatgpt.file', 'File'),
						kind,
						mimeType,
					});
				}
				return false;
			},
		},
		extensions: [
			...(['block', 'inline'] as const).map((level): NonNullable<MarkedExtension['extensions']>[number] => ({
				name: 'chatgptRichContent',
				level,
				tokenizer(source, tokens) {
					return tokenize.call(this, source, level, tokens);
				},
				childTokens: ['tokens'],
				start: source => {
					if (level === 'inline') {
						return source.search(/<\/?[a-z][\w-]*(?::[a-z][\w-]*)?(?=[\s/>]|$)/iu);
					}
					// Marked searches after the first character. Requiring a newline avoids
					// splitting a code span whose opening backtick was that first character.
					const match = /\n {0,3}<\/?[a-z][\w-]*(?::[a-z][\w-]*)?(?=[\s/>]|$)/iu.exec(source);
					return match ? match.index + 1 : -1;
				},
				renderer(token) {
					const tag = token.tag as RichTag;
					if (tag.closing) {
						return '';
					}
					if (hiddenTags.has(tag.name)) {
						const ids =
							attributes(tag)
								.get('refs')
								?.match(/turn\d+[a-z]+\d+/giu) ?? [];
						return referenceMarkup(ids, references);
					}
					if (mediaTags.has(tag.name)) {
						const values = attributes(tag);
						if (tag.name === 'canvas')
							return resourceMarkup({
								uri: `data:text/html;charset=utf-8,${encodeURIComponent(token.raw)}`,
								name:
									description(tag) || localize('sessions.chatgpt.interactive', 'Interactive content'),
								kind: 'html',
							});
						if (tag.name === 'iframe' && values.has('srcdoc')) {
							// Decode the HTML attribute as inert text before handing its document
							// to the isolated host. The Workbench never inserts that HTML.
							const encoded = values.get('srcdoc')!.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
							const html =
								sanitizeHtmlToFragment(encoded, { ownerDocument: getDocument() }).textContent ?? '';
							return resourceMarkup({
								uri: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
								name:
									description(tag) || localize('sessions.chatgpt.interactive', 'Interactive content'),
								kind: 'html',
							});
						}
						const uri = values.get('src');
						if (uri && tag.name === 'iframe') {
							try {
								const url = new URL(uri);
								if (url.protocol === 'https:' && !url.username && !url.password)
									return resourceMarkup({
										uri: `data:text/html;charset=utf-8,${encodeURIComponent(`<iframe src="${escapeHTML(url.href)}" title="${escapeHTML(description(tag))}" style="border:0;width:100%;height:100vh" sandbox="allow-scripts allow-forms allow-same-origin"></iframe>`)}`,
										name:
											description(tag) ||
											localize('sessions.chatgpt.interactive', 'Interactive content'),
										kind: 'html',
										frameOrigin: url.origin,
									});
							} catch {
								/* Malformed destinations remain readable as unavailable media. */
							}
						}
						if (uri)
							return resourceMarkup({
								uri,
								name: description(tag) || localize('sessions.chatgpt.media', 'Media'),
								kind:
									tag.name === 'img'
										? 'image'
										: tag.name === 'iframe'
											? 'html'
											: (tag.name as 'audio' | 'video'),
							});
						return `<span class="ash-chat-markdown-media">${localize('chat.markdown.mediaUnavailable', 'Media content is unavailable here.')}</span>`;
					}
					const element = token.inline ? 'span' : 'div';
					const body =
						typeof token.literal === 'string'
							? escapeHTML(token.literal).replace(/&amp;(?=(?:#\d+|#x[\da-f]+|[a-z]+);)/giu, '&')
							: token.inline
								? this.parser.parseInline(token.tokens as Token[])
								: this.parser.parse(token.tokens as Token[]);
					if (tag.name === 'icon') {
						const name = attributes(tag).get('name') ?? '';
						return `<span class="${classes(tag)}">${escapeHTML(iconText.get(name) ?? (description(tag) || name)) || fallbackHTML()}</span>`;
					}
					if (['box', 'row', 'text'].includes(tag.name)) {
						return `<${element} class="${classes(tag)}">${body || fallbackHTML()}</${element}>`;
					}
					const label = escapeHTML(description(tag));
					const data = componentData(tag);
					const chart =
						tag.name === 'chart' && data && !plaintext ? chartDocument(description(tag), data) : undefined;
					if (chart)
						return resourceMarkup({
							uri: `data:text/html;charset=utf-8,${encodeURIComponent(chart)}`,
							name: description(tag) || localize('sessions.chatgpt.chart', 'Chart'),
							kind: 'html',
						});
					// Unknown web cards still have usable disclosure and readable data; no
					// arbitrary JSX or component expressions are evaluated in the Workbench.
					if (!label && !body && !data) return '';
					return `<details class="ash-chatgpt-rich" open><summary>${label || localize('sessions.chatgpt.content', 'Content')}</summary>${body}${data ? `<pre><code>${escapeHTML(data)}</code></pre>` : ''}</details>`;
				},
			})),
			{
				name: 'chatgptWebReference',
				level: 'inline',
				start: source => source.indexOf('\uE200'),
				tokenizer(source) {
					const match = /^\uE200(cite|url)\uE202([^\uE201]+)\uE201/u.exec(source);
					if (!match) return undefined;
					const parts = match[2]!.split('\uE202');
					return {
						type: 'chatgptWebReference',
						raw: match[0],
						label: match[1] === 'url' ? parts.shift() : undefined,
						ids: parts,
					};
				},
				renderer(token) {
					const ids = token.ids as string[];
					if (typeof token.label === 'string') {
						const reference = references.find(reference => ids.includes(reference.id));
						return reference
							? `<a href="${escapeHTML(reference.url)}">${escapeHTML(token.label)}</a>`
							: escapeHTML(token.label);
					}
					return referenceMarkup(ids, references);
				},
			},
			{
				name: 'chatgptWriting',
				level: 'block',
				// Marked omits the paragraph's first character here; an offset-zero match
				// would split a codespan whose opening backtick was that character.
				start: source => /\n {0,3}:::writing\{/u.exec(source)?.index ?? -1,
				tokenizer(source) {
					const depth = lexerDepth.get(this.lexer) ?? 0;
					if (depth >= 32) {
						return undefined;
					}
					const writing = readWriting(source);
					if (!writing) {
						return undefined;
					}
					lexerDepth.set(this.lexer, depth + 1);
					try {
						return {
							type: 'chatgptWriting',
							raw: writing.raw,
							tokens: this.lexer.blockTokens(writing.body),
						};
					} finally {
						lexerDepth.set(this.lexer, depth);
					}
				},
				renderer(token) {
					return this.parser.parse(token.tokens ?? []);
				},
			},
		],
	};
}

/** Map web component syntax to shared Markdown and inert attachment descriptors. */
export function getChatGPTMarkdownRenderOptions(
	role: 'user' | 'assistant',
	references?: readonly ChatGPTReference[],
): MarkdownRenderOptions {
	return {
		markedExtensions: role === 'assistant' ? [createRichContentExtension(references)] : [],
		sanitizerConfig: {
			replaceWithPlaintext: role === 'user',
			allowedAttributes: {
				override: [
					...allowedMarkdownHtmlAttributes,
					'data-chatgpt-resource',
					'open',
					{ attributeName: 'src', shouldKeep: (_element, data) => data.attrValue.startsWith('data:') },
				],
			},
		},
	};
}

/** Complete generated links and validated colors after sanitization, without loading message resources. */
export function completeChatGPTRichContent(root: HTMLElement, conversationId: string | undefined): void {
	for (const media of root.querySelectorAll<HTMLElement>('.ash-chat-markdown-media')) {
		if (media.querySelector('.ash-chatgpt-rich-fallback')) {
			continue;
		}
		const link = root.ownerDocument.createElement('a');
		link.className = 'ash-chatgpt-rich-fallback';
		link.textContent = fallbackText();
		media.append(link);
	}
	for (const link of root.querySelectorAll<HTMLAnchorElement>('.ash-chatgpt-rich-fallback')) {
		link.href = conversationId
			? `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`
			: 'https://chatgpt.com/';
	}
	for (const element of root.querySelectorAll<HTMLElement>('.ash-chatgpt-rich')) {
		for (const name of element.classList) {
			const match = /^(background|border)-rgba-(\d+)-(\d+)-(\d+)-(\d+(?:p\d+)?)$/u.exec(name);
			if (!match) {
				continue;
			}
			const color = `rgba(${match[2]},${match[3]},${match[4]},${match[5].replace('p', '.')})`;
			if (match[1] === 'background') {
				element.style.backgroundColor = color;
			} else {
				element.style.borderColor = color;
			}
		}
	}
}

/** The accessible view retains component text and arrows without exposing markup. */
export function getChatGPTRichContentText(source: string, references?: readonly ChatGPTReference[]): string {
	const html = renderWorkbenchMarkdown({ value: source, supportHtml: true }, false, {
		markedExtensions: [createRichContentExtension(references, true)],
	});
	return renderAsPlaintext(html, { useLinkFormatter: true });
}

/** A Chart web component carries data, not executable JSX. Its interaction runs inside the existing Webview host. */
function chartDocument(title: string, json: string): string | undefined {
	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch {
		return undefined;
	}
	let rows: unknown[] = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.data) ? data.data : [];
	if (isRecord(data) && Array.isArray(data.labels) && Array.isArray(data.datasets)) {
		const datasets = data.datasets.filter(isRecord);
		rows = data.labels.map((label, index) =>
			Object.fromEntries([
				['label', label],
				...datasets.map((dataset, series) => [
					typeof dataset.label === 'string' ? dataset.label : String(series + 1),
					Array.isArray(dataset.data) ? dataset.data[index] : null,
				]),
			]),
		);
	}
	const table = rows.map((row, index) => (isRecord(row) ? row : { index: index + 1, value: row }));
	const keys = [...new Set(table.flatMap(row => Object.keys(row)))];
	const content = JSON.stringify({ rows: table, keys }).replaceAll('<', '\\u003c');
	return `<!doctype html>
<html>
<meta charset="utf-8">
<style>body{font:14px system-ui;color:CanvasText;background:Canvas;margin:16px}canvas{width:100%;height:280px}fieldset{border:0;padding:0;display:flex;gap:12px;flex-wrap:wrap}table{border-collapse:collapse}td,th{padding:8px;border:1px solid GrayText}button,select,input{font:inherit}output{display:block;min-height:2em}</style>
<h3>${escapeHTML(title)}</h3>
<fieldset>
<label>${escapeHTML(localize('sessions.chatgpt.chartType', 'Chart type'))} <select id="type">
<option value="bar">${escapeHTML(localize('sessions.chatgpt.barChart', 'Bar'))}</option>
<option value="line">${escapeHTML(localize('sessions.chatgpt.lineChart', 'Line'))}</option>
</select>
</label>
<label>${escapeHTML(localize('sessions.chatgpt.chartZoom', 'Zoom'))} <input aria-label="${escapeHTML(localize('sessions.chatgpt.chartZoom', 'Zoom'))}" id="zoom" type="range" min="1" max="4" step="0.25" value="1">
</label>
<span id="series">
</span>
<button id="previous">${escapeHTML(localize('sessions.chatgpt.previous', 'Previous'))}</button>
<output id="page"></output>
<button id="next">${escapeHTML(localize('sessions.chatgpt.next', 'Next'))}</button>
</fieldset>
<canvas id="chart" role="img" aria-label="${escapeHTML(title)}" tabindex="0">
</canvas>
<output id="point" aria-live="polite">
</output>
<details open>
<summary>${escapeHTML(localize('sessions.chatgpt.chartData', 'Chart data'))}</summary>
<table>
<thead>
<tr>${keys.map(key => `<th>${escapeHTML(key)}</th>`).join('')}</tr>
</thead>
<tbody id="rows"></tbody>
</table>
</details>
<details><summary>${escapeHTML(localize('sessions.chatgpt.originalData', 'Original data'))}</summary><pre>${escapeHTML(json)}</pre></details><script>
(() => {
  const data = ${content};
  const canvas = document.getElementById('chart');
  const context = canvas.getContext('2d');
  const numeric = data.keys.filter(key => data.rows.some(row => typeof row[key] === 'number'));
  const label = data.keys.find(key => !numeric.includes(key)) ?? (data.keys.length > 1 ? data.keys[0] : undefined);
  const series = numeric.filter(key => key !== label);
  const enabled = new Set(series);
  const type = document.getElementById('type');
  const zoom = document.getElementById('zoom');
  const point = document.getElementById('point');
  let selected = 0;
  let page = 0;
  const pageSize = 100;
  for (const key of series) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.onchange = () => {
      box.checked ? enabled.add(key) : enabled.delete(key);
      draw();
    };
    const item = document.createElement('label');
    item.append(box, key);
    document.getElementById('series').append(item);
  }
  function describe(index) {
    const row = data.rows[index];
    point.textContent = row ? data.keys.map(key => key + ': ' + String(row[key] ?? '')).join(' · ') : '';
  }
  function draw() {
    const rows = data.rows.slice(page * pageSize, (page + 1) * pageSize);
    document.getElementById('previous').disabled = page === 0;
    document.getElementById('next').disabled = (page + 1) * pageSize >= data.rows.length;
    document.getElementById('page').textContent = (page + 1) + '/' + Math.max(1, Math.ceil(data.rows.length / pageSize));
    document.getElementById('rows').replaceChildren(...rows.map(row => {
      const tr = document.createElement('tr');
      for (const key of data.keys) {
        const td = document.createElement('td');
        td.textContent = row[key] && typeof row[key] === 'object' ? JSON.stringify(row[key]) : String(row[key] ?? '');
        tr.append(td);
      }
      return tr;
    }));
    canvas.width = Math.max(300, canvas.clientWidth) * devicePixelRatio;
    canvas.height = 280 * devicePixelRatio;
    context.scale(devicePixelRatio, devicePixelRatio);
    const width = canvas.width / devicePixelRatio;
    const active = series.filter(key => enabled.has(key));
    const maximum = rows.reduce((max, row) => active.reduce((max, key) => Math.max(max, Math.abs(Number(row[key]) || 0)), max), 1);
    context.clearRect(0, 0, width, 280);
    context.fillStyle = getComputedStyle(document.body).color;
    context.font = '12px system-ui';
    const slot = (width - 60) / Math.max(1, rows.length);
    active.forEach((key, seriesIndex) => {
      context.strokeStyle = context.fillStyle = 'hsl(' + ((seriesIndex * 137 + 210) % 360) + ' 65% 48%)';
      context.beginPath();
      rows.forEach((row, index) => {
        const value = Number(row[key]) || 0;
        const x = 40 + index * slot;
        const y = 240 - value / maximum * 190 * Number(zoom.value);
        if (type.value === 'bar') {
          context.fillRect(x + seriesIndex * slot / Math.max(1, active.length), Math.min(y, 240), Math.max(1, slot / Math.max(1, active.length) - 4), Math.abs(240 - y));
        } else {
          index ? context.lineTo(x + slot / 2, y) : context.moveTo(x + slot / 2, y);
        }
      });
      if (type.value === 'line') context.stroke();
    });
    context.fillStyle = getComputedStyle(document.body).color;
    rows.forEach((row, index) => context.fillText(String(row[label] ?? index + page * pageSize + 1).slice(0, 16), 40 + index * slot, 260));
    describe(selected);
  }
  type.onchange = zoom.oninput = draw;
  document.getElementById('previous').onclick = () => { page--; selected = page * pageSize; draw(); };
  document.getElementById('next').onclick = () => { page++; selected = page * pageSize; draw(); };
  canvas.onpointermove = event => {
    const count = Math.min(pageSize, data.rows.length - page * pageSize);
    selected = page * pageSize + Math.max(0, Math.min(count - 1, Math.floor((event.offsetX - 40) / ((canvas.clientWidth - 60) / Math.max(1, count)))));
    describe(selected);
  };
  canvas.onkeydown = event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      selected = Math.max(0, Math.min(data.rows.length - 1, selected + (event.key === 'ArrowLeft' ? -1 : 1)));
      describe(selected);
    }
  };
  new ResizeObserver(draw).observe(canvas);
  draw();
})();
</script></html>`;
}
