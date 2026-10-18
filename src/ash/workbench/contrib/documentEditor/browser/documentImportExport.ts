import { lexer, type MarkedToken, type Tokens } from '../../../../base/common/marked/marked.js';
import { URI } from '../../../../base/common/uri.js';
import type { DocumentNode, DocumentMark } from '../../../../editor/common/model/document.js';
import type { DocumentSchema } from '../../../../editor/common/model/documentSchema.js';
import { documentFromPlainText, documentToPlainText } from '../../../../editor/common/model/documentSerialization.js';
import { localize } from '../../../../nls.js';

export type DocumentTextFormat = 'text' | 'markdown';

/** Conversion errors identify the original source or node; they never flatten unsupported structure. */
export class DocumentConversionError extends Error {
	constructor(readonly feature: string, readonly location: string) {
		super(localize('document.conversion.unsupported', 'Cannot preserve {0} at {1}.', conversionFeatureLabel(feature), location));
		this.name = 'DocumentConversionError';
	}
}

/** Explicit import creates a new document; the source remains owned by its text editor. */
export function importDocumentText(text: string, format: DocumentTextFormat, schema: DocumentSchema, ownerDocument: Document, source: URI): DocumentNode {
	if (format === 'text') return documentFromPlainText(schema, text);
	const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
	const decoder = ownerDocument.createElement('textarea');
	const decode = (value: string): string => {
		decoder.innerHTML = value.replaceAll('<', '&lt;');
		return decoder.value;
	};
	const location = (offset: number): string => {
		const prefix = normalized.slice(0, offset);
		return `${prefix.split('\n').length}:${offset - prefix.lastIndexOf('\n')}`;
	};
	const fail = (feature: string, offset: number): never => { throw new DocumentConversionError(feature, location(offset)); };
	const destination = (href: string, offset: number): string => {
		let url: URL;
		try { url = new URL(href, source.toString()); } catch { return fail('link destination', offset); }
		if (['javascript:', 'vbscript:', 'blob:'].includes(url.protocol)) return fail(url.protocol, offset);
		if (url.protocol === 'data:' && !/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(href)) return fail('data URL', offset);
		if (source.scheme === 'untitled' && !/^[a-z][a-z0-9+.-]*:/i.test(href)) return fail('relative destination in an unsaved source', offset);
		return url.href;
	};
	const inline = (tokens: readonly MarkedToken[], offset: number, marks: readonly DocumentMark[] = []): DocumentNode[] => {
		const content: DocumentNode[] = [];
		let cursor = offset;
		for (const token of tokens) {
			const found = normalized.indexOf(token.raw, cursor);
			const at = found < 0 ? cursor : found;
			cursor = at + token.raw.length;
			switch (token.type) {
				case 'text': case 'escape': {
					const value = token.type === 'text' ? decode(token.text) : token.text;
					if (value) content.push(schema.createText(value, { marks }));
					break;
				}
				case 'strong': case 'em':
					content.push(...inline(token.tokens as MarkedToken[], at, [...marks, { type: token.type, attrs: {} }]));
					break;
				case 'codespan':
					if (token.text) content.push(schema.createText(token.text, { marks: [...marks, { type: 'code', attrs: {} }] }));
					break;
				case 'link':
					if (token.title) fail('link title', at);
					content.push(...inline(token.tokens as MarkedToken[], at, [...marks, { type: 'link', attrs: { href: destination(token.href, at) } }]));
					break;
				case 'image':
					if (token.title || marks.length) fail('image title or formatting', at);
					content.push(schema.createNode('image', { attrs: { src: destination(token.href, at), alt: decode(token.text) } }));
					break;
				case 'br': content.push(schema.createNode('hardBreak')); break;
				default: fail(token.type, at);
			}
		}
		return mergeTextRuns(content, schema);
	};
	const blocks = (tokens: readonly MarkedToken[], offset: number): DocumentNode[] => {
		const content: DocumentNode[] = [];
		let cursor = offset;
		for (const token of tokens) {
			const found = normalized.indexOf(token.raw, cursor);
			const at = found < 0 ? cursor : found;
			cursor = at + token.raw.length;
			switch (token.type) {
				case 'space': case 'def': break;
				case 'paragraph': case 'text':
					content.push(schema.createNode('paragraph', { content: token.tokens ? inline(token.tokens as MarkedToken[], at) : token.text ? [schema.createText(decode(token.text))] : [] }));
					break;
				case 'heading':
					content.push(schema.createNode('heading', { attrs: { level: token.depth }, content: inline(token.tokens as MarkedToken[], at) }));
					break;
				case 'code':
					if (token.lang && /\s/.test(token.lang)) fail('code fence metadata', at);
					content.push(schema.createNode('codeBlock', { attrs: { language: token.lang ?? 'text' }, content: token.text ? [schema.createText(token.text)] : [] }));
					break;
				case 'hr': content.push(schema.createNode('horizontalRule')); break;
				case 'blockquote': content.push(schema.createNode('blockquote', { content: blocks(token.tokens as MarkedToken[], at) })); break;
				case 'list':
					let itemCursor = at;
					content.push(schema.createNode(token.ordered ? 'orderedList' : 'bulletList', {
						...(token.ordered ? { attrs: { order: Number(token.start) } } : {}),
						content: token.items.map(item => {
							const found = normalized.indexOf(item.raw, itemCursor);
							const itemAt = found < 0 ? itemCursor : found;
							itemCursor = itemAt + item.raw.length;
							if (item.task) fail('task list', itemAt);
							return schema.createNode('listItem', { content: blocks(item.tokens as MarkedToken[], itemAt) });
						}),
					}));
					break;
				case 'table': {
					if (token.align.some(value => value !== null)) fail('table alignment', at);
					const row = (cells: readonly Tokens.TableCell[]): DocumentNode => schema.createNode('tableRow', {
						content: cells.map(cell => schema.createNode('tableCell', { content: [schema.createNode('paragraph', { content: inline(cell.tokens as MarkedToken[], at) })] })),
					});
					content.push(schema.createNode('table', { attrs: { markdownHeader: true }, content: [row(token.header), ...token.rows.map(row)] }));
					break;
				}
				default: fail(token.type, at);
			}
		}
		return content;
	};
	const content = blocks(lexer(normalized, { gfm: true }) as MarkedToken[], 0);
	return schema.createDocument(content.length ? content : [schema.createNode('paragraph')]);
}

/** Text export is explicitly plain; Markdown export rejects semantics outside its supported subset. */
export function exportDocumentText(document: DocumentNode, schema: DocumentSchema, format: DocumentTextFormat): string {
	if (format === 'text') return documentToPlainText(document, schema);
	const escape = (value: string): string => value
		.replace(/[\\`*_{}\[\]<>&#!|~.+():@\-]/g, character => character === '&' ? '&amp;' : `\\${character}`)
		.replace(/^[ \t]+|[ \t]+$/gm, whitespace => [...whitespace].map(character => character === '\t' ? '&#9;' : '&#32;').join(''));
	const fail = (node: DocumentNode, feature: string): never => { throw new DocumentConversionError(feature, node.id); };
	const attributes = (node: DocumentNode, allowed: readonly string[]): void => {
		for (const key of Object.keys(node.attrs)) if (!allowed.includes(key)) fail(node, key);
	};
	const inline = (nodes: readonly DocumentNode[]): string => mergeTextRuns(nodes, schema).map(node => {
		if (node.type === 'hardBreak') return '  \n';
		if (node.type === 'image') {
			attributes(node, ['src', 'alt']);
			if (node.marks.length) fail(node, 'image formatting');
			return `![${escape(String(node.attrs.alt ?? ''))}](<${String(node.attrs.src).replace(/[<>\s]/g, encodeURIComponent)}>)`;
		}
		if (node.type !== 'text') return fail(node, node.type);
		attributes(node, []);
		let value = escape(node.text ?? '');
		for (const mark of [...node.marks].reverse()) {
			switch (mark.type) {
				case 'strong': value = `**${value}**`; break;
				case 'em': value = `*${value}*`; break;
				case 'code': {
					const raw = node.text ?? '';
					if (node.marks.length > 1 || raw.includes('\n')) return fail(node, 'code formatting');
					const fence = '`'.repeat(Math.max(0, ...[...raw.matchAll(/`+/g)].map(match => match[0].length)) + 1);
					value = raw.trim().length ? `${fence} ${raw} ${fence}` : `${fence}${raw}${fence}`;
					break;
				}
				case 'link':
					if (Object.keys(mark.attrs).some(key => key !== 'href')) return fail(node, 'link attributes');
					value = `[${value}](<${String(mark.attrs.href).replace(/[<>\s]/g, encodeURIComponent)}>)`;
					break;
				default: return fail(node, mark.type);
			}
			if (mark.type !== 'link' && Object.keys(mark.attrs).length) return fail(node, 'mark attributes');
		}
		return value;
	}).join('');
	const blocks = (nodes: readonly DocumentNode[]): string => nodes.map(node => {
		if (node.marks.length) return fail(node, 'block formatting');
		switch (node.type) {
			case 'paragraph':
				attributes(node, []);
				if (!node.content.length && nodes.length > 1) return fail(node, 'empty paragraph');
				return inline(node.content);
			case 'heading': attributes(node, ['level']); return `${'#'.repeat(Number(node.attrs.level))} ${inline(node.content)}`;
			case 'horizontalRule': attributes(node, []); return '---';
			case 'codeBlock': {
				attributes(node, ['language']);
				if (node.content.some(child => child.type !== 'text' || child.marks.length || Object.keys(child.attrs).length)) return fail(node, 'code content');
				const value = node.content.map(child => child.text ?? '').join('');
				const fence = '`'.repeat(Math.max(2, ...[...value.matchAll(/`+/g)].map(match => match[0].length)) + 1);
				const language = String(node.attrs.language ?? 'text');
				if (!language || /[\s`]/.test(language)) return fail(node, 'code language');
				return `${fence}${language}\n${value}\n${fence}`;
			}
			case 'blockquote': attributes(node, []); return blocks(node.content).split('\n').map(line => `> ${line}`).join('\n');
			case 'bulletList': case 'orderedList':
				attributes(node, node.type === 'orderedList' ? ['order'] : []);
				return node.content.map((item, index) => {
					attributes(item, []);
					const marker = node.type === 'orderedList' ? `${Number(node.attrs.order ?? 1) + index}. ` : '- ';
					return blocks(item.content).split('\n').map((line, lineIndex) => `${lineIndex ? ' '.repeat(marker.length) : marker}${line}`).join('\n');
				}).join('\n\n');
			case 'table': {
				attributes(node, ['markdownHeader']);
				if (node.attrs.markdownHeader !== true) return fail(node, 'table without a Markdown header');
				const rows = node.content.map(row => {
					attributes(row, []);
					return row.content.map(cell => {
						attributes(cell, []);
						if (cell.content.length !== 1 || cell.content[0]!.type !== 'paragraph' || Object.keys(cell.content[0]!.attrs).length) return fail(cell, 'table cell structure');
						const value = inline(cell.content[0]!.content);
						if (value.includes('\n')) return fail(cell, 'multiline table cell');
						return value;
					});
				});
				if (rows.some(row => row.length !== rows[0]!.length)) return fail(node, 'unequal table rows');
				rows.splice(1, 0, rows[0]!.map(() => '---'));
				return rows.map(row => `| ${row.join(' | ')} |`).join('\n');
			}
			default: return fail(node, node.type);
		}
	}).join('\n\n');
	attributes(document, []);
	return blocks(document.content) + '\n';
}

function conversionFeatureLabel(feature: string): string {
	switch (feature) {
		case 'link destination': return localize('document.conversion.linkDestination', 'link destination');
		case 'data URL': return localize('document.conversion.dataUrl', 'data URL');
		case 'relative destination in an unsaved source': return localize('document.conversion.relativeUnsaved', 'relative destination in an unsaved source');
		case 'image title or formatting': return localize('document.conversion.imageTitle', 'image title or formatting');
		case 'link title': return localize('document.conversion.linkTitle', 'link title');
		case 'code fence metadata': return localize('document.conversion.codeMetadata', 'code fence metadata');
		case 'task list': return localize('document.conversion.taskList', 'task list');
		case 'table alignment': return localize('document.conversion.tableAlignment', 'table alignment');
		case 'image formatting': return localize('document.conversion.imageFormatting', 'image formatting');
		case 'code formatting': return localize('document.conversion.codeFormatting', 'code formatting');
		case 'link attributes': return localize('document.conversion.linkAttributes', 'link attributes');
		case 'mark attributes': return localize('document.conversion.markAttributes', 'mark attributes');
		case 'block formatting': return localize('document.conversion.blockFormatting', 'block formatting');
		case 'empty paragraph': return localize('document.conversion.emptyParagraph', 'empty paragraph');
		case 'code content': return localize('document.conversion.codeContent', 'code content');
		case 'code language': return localize('document.conversion.codeLanguage', 'code language');
		case 'table without a Markdown header': return localize('document.conversion.tableHeader', 'table without a Markdown header');
		case 'table cell structure': return localize('document.conversion.tableCell', 'table cell structure');
		case 'multiline table cell': return localize('document.conversion.multilineCell', 'multiline table cell');
		case 'unequal table rows': return localize('document.conversion.unequalRows', 'unequal table rows');
		case 'image resource': return localize('document.conversion.imageResource', 'image resource');
		default: return feature;
	}
}

function mergeTextRuns(content: readonly DocumentNode[], schema: DocumentSchema): DocumentNode[] {
	const merged: DocumentNode[] = [];
	for (const node of content) {
		const previous = merged.at(-1);
		if (node.type === 'text' && previous?.type === 'text'
			&& JSON.stringify(previous.marks) === JSON.stringify(node.marks)
			&& JSON.stringify(previous.attrs) === JSON.stringify(node.attrs)) {
			merged[merged.length - 1] = schema.createText(previous.text! + node.text!, { id: previous.id, marks: previous.marks, attrs: previous.attrs });
		} else merged.push(node);
	}
	return merged;
}
