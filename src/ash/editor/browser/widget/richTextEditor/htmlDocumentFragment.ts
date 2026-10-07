import type { DocumentAttributes } from '../../../common/model/document.js';
import type { DocumentMark } from '../../../common/model/document.js';
import type { DocumentNode } from '../../../common/model/document.js';
import type { DocumentFragment } from '../../../common/model/documentSerialization.js';
import type { DocumentSchema } from '../../../common/model/documentSchema.js';
import { sanitizeHtmlToFragment } from '../../../../base/browser/domSanitize.js';

const MAX_HTML_CLIPBOARD_CHARACTERS = 1_000_000;

/**
 * Converts untrusted external clipboard HTML into a schema-valid Stanza fragment.
 *
 * The converter reads only a small, explicit HTML vocabulary. It never carries
 * DOM nodes, styles, event handlers, or arbitrary attributes into the document
 * model; unsupported elements contribute only their textual descendants.
 */
export function createDocumentFragmentFromHtml(ownerDocument: Document, schema: DocumentSchema, html: string): DocumentFragment | undefined {
	if (typeof html !== "string" || html.length === 0 || html.length > MAX_HTML_CLIPBOARD_CHARACTERS) return undefined;
	const sanitized = sanitizeHtmlToFragment(html, { ownerDocument, config: {} });
	const content = blocksFromNodes(sanitized.childNodes, schema);
	if (content.length === 0) return undefined;
	try {
		schema.createDocument(content, "__stanza_html_clipboard_fragment__");
	} catch {
		return undefined;
	}
	return Object.freeze({ content: Object.freeze(content) });
}

function blocksFromNodes(nodes: NodeListOf<ChildNode> | readonly ChildNode[], schema: DocumentSchema): DocumentNode[] {
	const blocks: DocumentNode[] = [];
	const inline: DocumentNode[] = [];
	const flushInline = (): void => {
		if (inline.length === 0) return;
		const paragraph = createNode(schema, "paragraph", inline);
		if (paragraph) blocks.push(paragraph);
		inline.length = 0;
	};
	for (const node of nodes) {
		if (node.nodeType === 3) {
			appendText(schema, inline, node.textContent ?? "", []);
			continue;
		}
		if (node.nodeType !== 1) continue;
		const element = node as HTMLElement;
		if (isDiscardedElement(element)) continue;
		switch (element.localName.toLowerCase()) {
			case "p":
			case "pre":
				flushInline();
				appendContainerBlocks(blocks, element, schema, "paragraph", {});
				break;
			case "div":
				flushInline();
				if (containsBlockDescendant(element)) blocks.push(...blocksFromNodes(element.childNodes, schema));
				else appendContainerBlocks(blocks, element, schema, "paragraph", {});
				break;
			case "h1":
			case "h2":
			case "h3":
			case "h4":
			case "h5":
			case "h6":
				flushInline();
				appendContainerBlocks(blocks, element, schema, "heading", { level: Number(element.localName.slice(1)) });
				break;
			case "blockquote":
				flushInline();
				appendBlockquote(blocks, element, schema);
				break;
			case "ul":
			case "ol":
				flushInline();
				appendList(blocks, element, schema);
				break;
			case "table":
				flushInline();
				appendTable(blocks, element, schema);
				break;
			case "hr":
				flushInline();
				appendNode(blocks, createNode(schema, "horizontalRule", []));
				break;
			case "br":
			case "img":
			case "a":
			case "b":
			case "strong":
			case "i":
			case "em":
			case "code":
			case "span":
				appendInlineNodes(schema, [element], [], inline);
				break;
			default:
				if (containsBlockDescendant(element)) {
					flushInline();
					blocks.push(...blocksFromNodes(element.childNodes, schema));
				} else {
					appendInlineNodes(schema, element.childNodes, [], inline);
				}
				break;
		}
	}
	flushInline();
	return blocks;
}

function appendContainerBlocks(target: DocumentNode[], element: HTMLElement, schema: DocumentSchema, type: "paragraph" | "heading", attrs: DocumentAttributes): void {
	const inline: DocumentNode[] = [];
	appendInlineNodes(schema, element.childNodes, [], inline, element.localName.toLowerCase() === "pre");
	const block = createNode(schema, type, inline, attrs);
	if (block) target.push(block);
}

function appendBlockquote(target: DocumentNode[], element: HTMLElement, schema: DocumentSchema): void {
	const content = blocksFromNodes(element.childNodes, schema);
	if (content.length === 0) return;
	const blockquote = createNode(schema, "blockquote", content);
	if (blockquote) target.push(blockquote);
	else target.push(...content);
}

function appendList(target: DocumentNode[], element: HTMLElement, schema: DocumentSchema): void {
	const items: DocumentNode[] = [];
	for (const child of element.children) {
		if (child.localName.toLowerCase() !== "li") continue;
		const content = blocksFromNodes(child.childNodes, schema);
		const fallback = content.length > 0 ? content : emptyParagraph(schema);
		const item = fallback ? createNode(schema, "listItem", fallback) : undefined;
		if (item) items.push(item);
	}
	if (items.length === 0) return;
	const type = element.localName.toLowerCase() === "ol" ? "orderedList" : "bulletList";
	const order = Number(element.getAttribute("start") ?? "1");
	const list = createNode(schema, type, items, type === "orderedList" && Number.isSafeInteger(order) && order > 0 ? { order } : {});
	if (list) target.push(list);
	else target.push(...items.flatMap(item => item.content));
}

function appendTable(target: DocumentNode[], element: HTMLElement, schema: DocumentSchema): void {
	const rows: DocumentNode[] = [];
	for (const rowElement of tableRows(element)) {
		const cells: DocumentNode[] = [];
		for (const child of rowElement.children) {
			const tagName = child.localName.toLowerCase();
			if (tagName !== "td" && tagName !== "th") continue;
			const content = blocksFromNodes(child.childNodes, schema);
			const cell = createNode(schema, "tableCell", content.length > 0 ? content : emptyParagraph(schema) ?? []);
			if (cell) cells.push(cell);
		}
		const row = cells.length > 0 ? createNode(schema, "tableRow", cells) : undefined;
		if (row) rows.push(row);
	}
	const table = rows.length > 0 ? createNode(schema, "table", rows) : undefined;
	if (table) target.push(table);
	else {
		for (const row of rows) for (const cell of row.content) target.push(...cell.content);
	}
}

function tableRows(element: HTMLElement): readonly HTMLElement[] {
	const rows: HTMLElement[] = [];
	const collect = (parent: Element): void => {
		for (const child of parent.children) {
			const tagName = child.localName.toLowerCase();
			if (tagName === "tr") rows.push(child as HTMLElement);
			else if (tagName === "thead" || tagName === "tbody" || tagName === "tfoot") collect(child);
		}
	};
	collect(element);
	return rows;
}

function appendInlineNodes(schema: DocumentSchema, nodes: NodeListOf<ChildNode> | readonly ChildNode[], marks: readonly DocumentMark[], target: DocumentNode[], preserveWhitespace = false): void {
	for (const node of nodes) {
		if (node.nodeType === 3) {
			appendText(schema, target, node.textContent ?? "", marks, preserveWhitespace);
			continue;
		}
		if (node.nodeType !== 1) continue;
		const element = node as HTMLElement;
		if (isDiscardedElement(element)) continue;
		const tagName = element.localName.toLowerCase();
		if (tagName === "br") {
			appendNode(target, createNode(schema, "hardBreak", []));
			continue;
		}
		if (tagName === "img") {
			const src = safeImageSource(element.getAttribute("src"));
			if (src) appendNode(target, createNode(schema, "image", [], { src, ...(safeAlt(element.getAttribute("alt")) ? { alt: safeAlt(element.getAttribute("alt")) } : {}) }));
			continue;
		}
		const nextMarks = markForElement(schema, element, marks);
		appendInlineNodes(schema, element.childNodes, nextMarks, target, preserveWhitespace || tagName === "pre");
	}
}

function appendText(schema: DocumentSchema, target: DocumentNode[], value: string, marks: readonly DocumentMark[], preserveWhitespace = false): void {
	const normalized = preserveWhitespace ? value.replaceAll("\r\n", "\n").replaceAll("\r", "\n") : value.replace(/\s+/gu, " ");
	if (normalized.length === 0 || (normalized === " " && target.length === 0)) return;
	const lines = normalized.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		if (lines[index]!.length > 0) appendNode(target, schema.createText(lines[index]!, { marks }));
		if (index < lines.length - 1) appendNode(target, createNode(schema, "hardBreak", []));
	}
}

function markForElement(schema: DocumentSchema, element: HTMLElement, marks: readonly DocumentMark[]): readonly DocumentMark[] {
	const markSpecs = schema.getMarkSpecs();
	let mark: DocumentMark | undefined;
	switch (element.localName.toLowerCase()) {
		case "b":
		case "strong":
			mark = markSpecs.has("strong") ? { type: "strong", attrs: {} } : undefined;
			break;
		case "i":
		case "em":
			mark = markSpecs.has("em") ? { type: "em", attrs: {} } : undefined;
			break;
		case "code":
			mark = markSpecs.has("code") ? { type: "code", attrs: {} } : undefined;
			break;
		case "a": {
			const href = safeHref(element.getAttribute("href"));
			mark = href && markSpecs.has("link") ? { type: "link", attrs: { href } } : undefined;
			break;
		}
	}
	if (!mark || marks.some(candidate => candidate.type === mark!.type && JSON.stringify(candidate.attrs) === JSON.stringify(mark!.attrs))) return marks;
	return Object.freeze([...marks, Object.freeze({ type: mark.type, attrs: Object.freeze({ ...mark.attrs }) })]);
}

function createNode(schema: DocumentSchema, type: string, content: readonly DocumentNode[], attrs: DocumentAttributes = {}): DocumentNode | undefined {
	if (!schema.getNodeSpec(type)) return undefined;
	try {
		return schema.createNode(type, { attrs, content });
	} catch {
		return undefined;
	}
}

function emptyParagraph(schema: DocumentSchema): readonly DocumentNode[] | undefined {
	const paragraph = createNode(schema, "paragraph", []);
	return paragraph ? [paragraph] : undefined;
}

function appendNode(target: DocumentNode[], node: DocumentNode | undefined): void {
	if (node) target.push(node);
}

function containsBlockDescendant(element: HTMLElement): boolean {
	return element.querySelector("p, div, h1, h2, h3, h4, h5, h6, blockquote, ul, ol, table, hr") !== null;
}

function isDiscardedElement(element: HTMLElement): boolean {
	return element.matches("script, style, template, iframe, object, embed, frame, frameset, noscript");
}

function safeHref(value: string | null): string | undefined {
	if (!value) return undefined;
	const href = value.trim();
	if (href.length === 0) return undefined;
	try {
		const url = new URL(href, "https://stanza.invalid/");
		if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") return href;
		if (url.origin === "https://stanza.invalid") return href;
	} catch {
		return undefined;
	}
	return undefined;
}

function safeImageSource(value: string | null): string | undefined {
	if (!value) return undefined;
	const source = value.trim();
	if (source.length === 0) return undefined;
	if (/^data:image\/(?:gif|jpeg|png|webp);base64,[a-z0-9+/=\s]+$/iu.test(source)) return source;
	try {
		const url = new URL(source, "https://stanza.invalid/");
		if (url.protocol === "http:" || url.protocol === "https:" || url.origin === "https://stanza.invalid") return source;
	} catch {
		return undefined;
	}
	return undefined;
}

function safeAlt(value: string | null): string | undefined {
	const alt = value?.trim();
	return alt && alt.length <= 1_024 ? alt : undefined;
}
