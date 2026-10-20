import { createDefaultDocumentSchema } from '../../../common/model/documentSchema.js';
import { createAcademicDocumentSchema } from '../academic/common/schema.js';
import { localize } from 'ash:editor/nls.js';
import { findDocumentNode, type DocumentNode, type DocumentAttributes, type DocumentMark } from '../../../common/model/document.js';
import type { DocumentSchema } from '../../../common/model/documentSchema.js';
import { serializeDocument, deserializeDocument } from '../../../common/model/documentSerialization.js';
import { resolveDocumentParagraphAttributes, getDocumentParagraphStyles } from '../../../common/model/documentParagraph.js';
import { documentPageDimensions } from '../../../common/model/documentPageLayout.js';
import { zipFiles, unzipFiles } from './zip.js';
import { buildReferenceIndex } from '../citation/common/references.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const P = 'http://schemas.openxmlformats.org/package/2006/relationships';
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
const xml = (body: string): string => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + body;
const children = (element: Element, name?: string): Element[] => {
	const elements = [...element.children];
	if (elements.some(child => child.namespaceURI !== W)) return fail('XML namespace in ' + element.localName);
	return elements.filter(child => !name || child.localName === name);
};
const child = (element: Element, name: string): Element | undefined => children(element, name)[0];
const val = (element: Element | undefined, name = 'val'): string | undefined => element?.getAttributeNS(W, name) ?? undefined;
function fail(feature: string): never { throw new Error(localize('document.docx.unsupported', 'Cannot preserve DOCX feature: {0}. The source file has not been changed.', feature)); }
function parse(value: Uint8Array | undefined, owner: Document): XMLDocument {
	if (!value) return fail('missing package part');
	const text = decode(value);
	if (/<!DOCTYPE|<!ENTITY/i.test(text)) return fail('XML entities');
	const result = new owner.defaultView!.DOMParser().parseFromString(text, 'application/xml');
	if (result.getElementsByTagName('parsererror').length) return fail('invalid XML');
	return result;
}
function safeUrl(value: string): string { if (!/^(https?:|mailto:|#)/i.test(value)) return fail('link destination'); return value; }
async function digest(bytes: Uint8Array): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))].map(byte => byte.toString(16).padStart(2, '0')).join(''); }


/** OOXML parts and relationships stay package-owned. Ash metadata is used only when all interoperable parts are unchanged. */
export async function exportDocx(document: DocumentNode, schema: DocumentSchema, signal: AbortSignal): Promise<Uint8Array> {
	schema.validate(document); signal.throwIfAborted();
	const citationOrdinals = new Map(buildReferenceIndex(document).citations.map(entry => [entry.nodeId, entry.ordinal]));
	const files = new Map<string, Uint8Array>();
	const relationships: string[] = [];
	const overrides: string[] = [];
	let next = 1, drawing = 1;
	const relation = (type: string, target: string, external = false): string => { const id = `rId${next++}`; relationships.push(`<Relationship Id="${id}" Type="${R}/${type}" Target="${escape(target)}"${external ? ' TargetMode="External"' : ''}/>`); return id; };
	const part = (name: string, type: string, text: string): void => { files.set(name, encode(xml(text))); overrides.push(`<Override PartName="/${name}" ContentType="${type}"/>`); };
	const comments = document.content.filter(node => node.type === 'reviewComment');
	const texts: DocumentNode[] = []; const visit = (node: DocumentNode): void => { if (node.text !== undefined) texts.push(node); else if (!node.type.startsWith('review')) node.content.forEach(visit); }; visit(document);
	const edges = new Map<string, { offset: number; id: number; start: boolean; }[]>();
	comments.forEach((comment, id) => {
		if (!comment.attrs.anchor) return;
		const selection = JSON.parse(String(comment.attrs.anchor)); let a = selection.anchor, b = selection.head;
		const ai = texts.findIndex(node => node.id === a.nodeId), bi = texts.findIndex(node => node.id === b.nodeId);
		if (ai < 0 || bi < 0) return;
		if (ai > bi || (ai === bi && a.offset > b.offset)) [a, b] = [b, a];
		for (const [point, start] of [[a, true], [b, false]] as const) edges.set(point.nodeId, [...(edges.get(point.nodeId) ?? []), { offset: point.offset, id, start }]);
	});
	const images = new Map<string, string>();
	const collectImages = async (node: DocumentNode): Promise<void> => {
		if (node.type === 'image') {
			const source = String(node.attrs.src); if (!/^data:image\/(png|jpeg|gif|webp);base64,/i.test(source)) return fail('non-embedded or unsupported image at ' + node.id);
			const match = /^data:image\/(png|jpeg|gif|webp);base64,(.*)$/i.exec(source)!;
			const bytes = Uint8Array.from(atob(match[2]!), character => character.charCodeAt(0));
			const name = `media/image${images.size + 1}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`;
			files.set('word/' + name, bytes); images.set(node.id, relation('image', name));
		}
		for (const nodeChild of node.content) if (!nodeChild.type.startsWith('review')) await collectImages(nodeChild);
	};
	await collectImages(document);
	const fontProperties = (attrs: DocumentAttributes): string => `${attrs.fontFamily ? `<w:rFonts w:ascii="${attrs.fontFamily === 'serif' ? 'Times New Roman' : attrs.fontFamily === 'monospace' ? 'Consolas' : 'Arial'}" w:hAnsi="${attrs.fontFamily === 'serif' ? 'Times New Roman' : attrs.fontFamily === 'monospace' ? 'Consolas' : 'Arial'}"/>` : ''}${attrs.fontSize ? `<w:sz w:val="${Math.round(Number(attrs.fontSize) * 1.5)}"/>` : ''}`;
	const run = (text: string, marks: readonly DocumentMark[], deleted = false): string => {
		const style = { ...(marks.some(mark => mark.type === 'code') ? { fontFamily: 'monospace' } : {}), ...marks.find(mark => mark.type === 'textStyle')?.attrs };
		const fonts = fontProperties(style);
		const properties = fonts.replace(/<w:sz[^>]*\/>/, '') + (marks.some(mark => mark.type === 'strong') ? '<w:b/>' : '') + (marks.some(mark => mark.type === 'em') ? '<w:i/>' : '') + (/<w:sz[^>]*\/>/.exec(fonts)?.[0] ?? '');
		const tag = deleted ? 'delText' : 't';
		const content = text.split('\n').map(piece => `<w:${tag} xml:space="preserve">${escape(piece)}</w:${tag}>`).join('<w:br/>');
		const result = `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}${content}</w:r>`;
		const link = marks.find(mark => mark.type === 'link');
		return link ? `<w:hyperlink r:id="${relation('hyperlink', safeUrl(String(link.attrs.href)), true)}">${result}</w:hyperlink>` : result;
	};
	const inline = (node: DocumentNode, inherited: DocumentAttributes = {}): string => {
		if (node.text !== undefined) {
			const textStyle = { ...(inherited.fontFamily ? { fontFamily: inherited.fontFamily } : {}), ...(inherited.fontSize ? { fontSize: inherited.fontSize } : {}), ...node.marks.find(mark => mark.type === 'textStyle')?.attrs };
			const marks = [...node.marks.filter(mark => mark.type !== 'textStyle'), ...(Object.keys(textStyle).length ? [{ type: 'textStyle', attrs: textStyle }] : [])];
			const points = [...(edges.get(node.id) ?? [])].sort((a, b) => a.offset - b.offset || Number(b.start) - Number(a.start));
			let result = '', at = 0;
			for (const point of points) { result += run(node.text.slice(at, point.offset), marks); result += point.start ? `<w:commentRangeStart w:id="${point.id}"/>` : `<w:commentRangeEnd w:id="${point.id}"/><w:r><w:commentReference w:id="${point.id}"/></w:r>`; at = point.offset; }
			return result + run(node.text.slice(at), marks);
		}
		if (node.type === 'hardBreak') return '<w:r><w:br/></w:r>';
		if (node.type === 'citation') {
			const label = typeof node.attrs.label === 'string' && node.attrs.label.length > 0 ? node.attrs.label : `[${citationOrdinals.get(node.id) ?? node.attrs.key}]`;
			return run(label, []);
		}
		if (node.type === 'image') {
			const width = Number(node.attrs.width ?? 320) * 9525, height = Number(node.attrs.height ?? 180) * 9525;
			return `<w:r><w:drawing><wp:inline><wp:extent cx="${width}" cy="${height}"/><wp:docPr id="${drawing++}" name="Image" descr="${escape(node.attrs.alt)}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="Image"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${images.get(node.id)}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
		}
		return fail(node.type);
	};
	const revisionParagraphs = new Map<string, { before?: DocumentNode; record: DocumentNode; }>();
	const deletedParagraphs: { before: DocumentNode; record: DocumentNode; }[] = [];
	for (const record of document.content.filter(node => node.type === 'reviewChange')) {
		const before: DocumentNode | undefined = record.attrs.before ? JSON.parse(String(record.attrs.before)) : undefined;
		const oldParagraphs = new Map<string, DocumentNode>();
		const collect = (node: DocumentNode, target: Map<string, DocumentNode>): void => { if (['paragraph', 'heading', 'codeBlock'].includes(node.type)) target.set(node.id, node); else node.content.forEach(child => collect(child, target)); };
		if (before) collect(before, oldParagraphs);
		const currentParagraphs = new Map<string, DocumentNode>();
		const current = findDocumentNode(document, String(record.attrs.target))?.node;
		if (current) collect(current, currentParagraphs);
		for (const [id, paragraph] of currentParagraphs) if (JSON.stringify(paragraph) !== JSON.stringify(oldParagraphs.get(id))) revisionParagraphs.set(id, { before: oldParagraphs.get(id), record });
		for (const [id, paragraph] of oldParagraphs) if (!currentParagraphs.has(id)) deletedParagraphs.push({ before: paragraph, record });
	}
	let revisionId = 1;
	const revisionRun = (kind: 'ins' | 'del', record: DocumentNode, content: string): string => `<w:${kind} w:id="${revisionId++}" w:author="${escape(record.attrs.author)}" w:date="${escape(record.attrs.createdAt)}">${content}</w:${kind}>`;
	const deletedInline = (node: DocumentNode): string => node.text !== undefined ? run(node.text, node.marks, true) : node.type === 'hardBreak' ? '<w:r><w:br/></w:r>' : node.content.map(deletedInline).join('');
	const numbering: string[] = []; let listId = 1;
	const paragraphProperties = (node: DocumentNode, list?: { id: number; level: number; }): string => {
		const attrs = resolveDocumentParagraphAttributes(document, node);
		const points = (key: string) => Math.round(Number(attrs[key]) * 20);
		return `${node.attrs.styleId || node.type === 'heading' ? `<w:pStyle w:val="${escape(node.attrs.styleId ?? `Heading${node.attrs.level ?? 1}`)}"/>` : ''}${['keepWithNext', 'keepTogether', 'pageBreakBefore', 'widowControl'].map((key, index) => `<w:${['keepNext', 'keepLines', 'pageBreakBefore', 'widowControl'][index]} w:val="${attrs[key] ? 1 : 0}"/>`).join('')}${list ? `<w:numPr><w:ilvl w:val="${list.level}"/><w:numId w:val="${list.id}"/></w:numPr>` : ''}<w:spacing w:before="${points('spaceBefore')}" w:after="${points('spaceAfter')}" w:line="${Math.round(Number(attrs.lineSpacing) * 240)}" w:lineRule="auto"/><w:ind w:left="${points('indentStart')}" w:right="${points('indentEnd')}" ${Number(attrs.firstLineIndent) < 0 ? `w:hanging="${-points('firstLineIndent')}"` : `w:firstLine="${points('firstLineIndent')}"`}/><w:jc w:val="${attrs.textAlign === 'start' ? 'left' : attrs.textAlign === 'end' ? 'right' : attrs.textAlign === 'justify' ? 'both' : attrs.textAlign}"/>`;
	};
	const block = (node: DocumentNode, list?: { id: number; level: number; }): string => {
		if (node.type.startsWith('review')) return '';
		if (['paragraph', 'heading', 'codeBlock'].includes(node.type)) {
			const revision = revisionParagraphs.get(node.id);
			const current = node.content.map(child => inline(child, { ...resolveDocumentParagraphAttributes(document, node), ...(node.type === 'codeBlock' ? { fontFamily: 'monospace' } : {}) })).join('');
			const content = revision ? (revision.before ? revisionRun('del', revision.record, deletedInline(revision.before)) : '') + revisionRun('ins', revision.record, current) : current;
			return `<w:p><w:pPr>${paragraphProperties(node, list)}</w:pPr>${content}</w:p>`;
		}
		if (node.type === 'horizontalRule') return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4"/></w:pBdr></w:pPr></w:p>';
		if (node.type === 'table') return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => `<w:${side} w:val="single" w:sz="4"/>`).join('')}</w:tblBorders></w:tblPr>${node.content.map(row => `<w:tr>${row.content.map(cell => `<w:tc><w:tcPr/>${cell.content.map(child => block(child)).join('')}${cell.content.at(-1)?.type === 'table' || !cell.content.length ? '<w:p/>' : ''}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;
		if (node.type === 'orderedList' || node.type === 'bulletList') {
			const id = listId++, level = list ? list.level + 1 : 0;
			const formats: Record<string, string> = { decimal: 'decimal', 'lower-alpha': 'lowerLetter', 'upper-alpha': 'upperLetter', 'lower-roman': 'lowerRoman', 'upper-roman': 'upperRoman' };
			numbering.push(`<w:abstractNum w:abstractNumId="${id}"><w:lvl w:ilvl="${level}"><w:start w:val="${node.attrs.order ?? 1}"/><w:numFmt w:val="${node.type === 'bulletList' ? 'bullet' : formats[String(node.attrs.numbering ?? 'decimal')]}"/><w:lvlText w:val="${node.type === 'bulletList' ? '•' : `%${level + 1}.`}"/></w:lvl></w:abstractNum><w:num w:numId="${id}"><w:abstractNumId w:val="${id}"/></w:num>`);
			return node.content.map(item => item.content.map((child, index) => block(child, index === 0 || child.type.endsWith('List') ? { id, level } : undefined)).join('')).join('');
		}
		if (['blockquote', 'title', 'abstract', 'section', 'bibliography', 'reference', 'listItem'].includes(node.type)) return node.content.map(child => block(child, list)).join('');
		return fail(node.type);
	};
	const sections: { attrs: DocumentAttributes; content: readonly DocumentNode[]; }[] = [];
	let pending: DocumentNode[] = [];
	for (const node of document.content) {
		if (node.type === 'documentSection') { if (pending.length) sections.push({ attrs: document.attrs, content: pending }); pending = []; sections.push({ attrs: { ...document.attrs, ...node.attrs }, content: node.content }); }
		else if (!node.type.startsWith('review')) pending.push(node);
	}
	if (pending.length || !sections.length) sections.push({ attrs: document.attrs, content: pending });
	const even = sections.some(section => section.attrs.pageDifferentEven);
	let sectionIndex = 0;
	const sectionProperties = (attrs: DocumentAttributes): string => {
		const dimensions = documentPageDimensions({ ...document, attrs: { ...attrs, pageSize: attrs.pageSize === 'letter' ? 'letter' : 'a4' } })!;
		const index = ++sectionIndex;
		let refs = '';
		for (const kind of ['header', 'footer'] as const) for (const variant of ['default', ...(even ? ['even'] : []), ...(attrs.pageDifferentFirst ? ['first'] : [])]) {
			const value = variant === 'first' ? '' : variant === 'even' && attrs.pageDifferentEven ? attrs[kind === 'header' ? 'pageEvenHeader' : 'pageEvenFooter'] : attrs[kind === 'header' ? 'pageHeader' : 'pageFooter'];
			const name = `${kind}${index}-${variant}.xml`, id = relation(kind, name);
			const pageNumber = kind === 'footer' && attrs.pageNumbers && variant !== 'first' ? '<w:r><w:tab/></w:r><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:t> / </w:t></w:r><w:fldSimple w:instr="NUMPAGES"><w:r><w:t>1</w:t></w:r></w:fldSimple>' : '';
			part(`word/${name}`, `application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml`, `<w:${kind === 'header' ? 'hdr' : 'ftr'} xmlns:w="${W}"><w:p>${run(String(value ?? ''), [])}${pageNumber}</w:p></w:${kind === 'header' ? 'hdr' : 'ftr'}>`);
			refs += `<w:${kind}Reference w:type="${variant}" r:id="${id}"/>`;
		}
		const margin = Math.round(Number(attrs.pageMargin ?? 72) * 20);
		return `<w:sectPr>${refs}<w:pgSz w:w="${Math.round(dimensions.width * 15)}" w:h="${Math.round(dimensions.height * 15)}" w:orient="${attrs.pageOrientation ?? 'portrait'}"/><w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}" w:header="${Math.round(margin / 3)}" w:footer="${Math.round(margin / 3)}" w:gutter="0"/>${attrs.pageDifferentFirst ? '<w:titlePg/>' : ''}</w:sectPr>`;
	};
	let body = deletedParagraphs.map(({ before, record }) => `<w:p><w:pPr><w:rPr><w:del w:id="${revisionId++}" w:author="${escape(record.attrs.author)}"/></w:rPr></w:pPr>${revisionRun('del', record, deletedInline(before))}</w:p>`).join('');
	for (const [index, section] of sections.entries()) { body += section.content.map(node => block(node)).join(''); const properties = sectionProperties(section.attrs); body += index === sections.length - 1 ? properties : `<w:p><w:pPr>${properties}</w:pPr></w:p>`; }
	const declarations = `xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"`;
	part('word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', `<w:document ${declarations}><w:body>${body}</w:body></w:document>`);
	part('word/styles.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml', `<w:styles xmlns:w="${W}">${Array.from({ length: 6 }, (_, index) => `<w:style w:type="paragraph" w:styleId="Heading${index + 1}"><w:name w:val="Heading ${index + 1}"/><w:pPr><w:outlineLvl w:val="${index}"/></w:pPr></w:style>`).join('')}${getDocumentParagraphStyles(document).map(style => `<w:style w:type="paragraph" w:styleId="${escape(style.id)}"><w:name w:val="${escape(style.name)}"/><w:pPr>${paragraphProperties({ ...document, type: style.level ? 'heading' : 'paragraph', attrs: { ...style.attrs }, content: [] }).replace(/<w:pStyle[^>]*\/>/, '')}${style.level ? `<w:outlineLvl w:val="${style.level - 1}"/>` : ''}</w:pPr><w:rPr>${fontProperties({ ...style.attrs })}</w:rPr></w:style>`).join('')}</w:styles>`); relation('styles', 'styles.xml');
	if (numbering.length) { part('word/numbering.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml', `<w:numbering xmlns:w="${W}">${numbering.map(part => part.slice(0, part.indexOf('<w:num '))).join('')}${numbering.map(part => part.slice(part.indexOf('<w:num '))).join('')}</w:numbering>`); relation('numbering', 'numbering.xml'); }
	if (comments.length) { part('word/comments.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml', `<w:comments xmlns:w="${W}">${comments.map((node, index) => `<w:comment w:id="${index}" w:author="${escape(node.attrs.author)}" w:date="${escape(node.attrs.createdAt)}"><w:p>${run(String(node.attrs.body), [])}</w:p></w:comment>`).join('')}</w:comments>`); relation('comments', 'comments.xml'); }
	part('word/settings.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml', `<w:settings xmlns:w="${W}">${even ? '<w:evenAndOddHeaders/>' : ''}${document.attrs.trackChanges ? '<w:trackRevisions/>' : ''}</w:settings>`); relation('settings', 'settings.xml');
	files.set('word/_rels/document.xml.rels', encode(xml(`<Relationships xmlns="${P}">${relationships.join('')}</Relationships>`)));
	files.set('_rels/.rels', encode(xml(`<Relationships xmlns="${P}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`)));
	files.set('[Content_Types].xml', encode(xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="json" ContentType="application/json"/>${['png', 'jpeg', 'jpg', 'gif', 'webp'].map(extension => `<Default Extension="${extension}" ContentType="image/${extension === 'jpg' ? 'jpeg' : extension}"/>`).join('')}${overrides.join('')}</Types>`)));
	const hashes: Record<string, string> = {};
	for (const [name, bytes] of files) { signal.throwIfAborted(); hashes[name] = await digest(bytes); }
	files.set('customXml/ash-document.json', encode(serializeDocument(document, schema)));
	files.set('customXml/ash-manifest.json', encode(JSON.stringify({ version: 1, hashes })));
	return zipFiles(files);
}

export async function importDocx(bytes: Uint8Array, schema: DocumentSchema, owner: Document, signal: AbortSignal): Promise<DocumentNode> {
	return importDocxParts(await unzipFiles(bytes, signal), schema, owner, signal);
}

/** A native package retains its owning profile; ordinary Word files become general documents. */
export async function importDocxDocument(bytes: Uint8Array, owner: Document, signal: AbortSignal): Promise<{ document: DocumentNode; documentType: string; }> {
	const files = await unzipFiles(bytes, signal);
	const snapshot = files.get('customXml/ash-document.json');
	const type = snapshot ? JSON.parse(decode(snapshot)).documentType : 'general';
	if (type !== 'general' && type !== 'academic') return fail('document profile');
	const schema = type === 'academic' ? createAcademicDocumentSchema() : createDefaultDocumentSchema();
	return { document: await importDocxParts(files, schema, owner, signal), documentType: schema.documentType };
}

async function importDocxParts(files: Map<string, Uint8Array>, schema: DocumentSchema, owner: Document, signal: AbortSignal): Promise<DocumentNode> {
	if ([...files.keys()].some(name => /vbaProject|\/embeddings\/|\/activeX\//i.test(name))) return fail('macros or embedded executable objects');
	const snapshot = files.get('customXml/ash-document.json'), manifestBytes = files.get('customXml/ash-manifest.json');
	if (snapshot && manifestBytes) {
		const manifest = JSON.parse(decode(manifestBytes));
		let matches = manifest.version === 1 && manifest.hashes && Object.keys(manifest.hashes).length === files.size - 2;
		if (matches) for (const [name, hash] of Object.entries(manifest.hashes)) { signal.throwIfAborted(); if (!files.has(name) || await digest(files.get(name)!) !== hash) { matches = false; break; } }
		if (matches) {
			const document = deserializeDocument(decode(snapshot), schema);
			const visit = (node: DocumentNode): void => { for (const mark of node.marks) if (mark.type === 'link') safeUrl(String(mark.attrs.href)); if (node.type === 'image' && !/^data:image\/(png|jpeg|gif|webp);base64,/i.test(String(node.attrs.src))) return fail('non-embedded image'); node.content.forEach(visit); };
			visit(document); return document;
		}
	}
	const resolve = (base: string, target: string): string => { const url = new URL(target, 'https://package.invalid/' + base); if (url.origin !== 'https://package.invalid') return fail('external package part'); return decodeURIComponent(url.pathname.slice(1)); };
	const relationships = (name: string): Map<string, { type: string; target: string; external: boolean; }> => {
		const slash = name.lastIndexOf('/'), relName = name.slice(0, slash + 1) + '_rels/' + name.slice(slash + 1) + '.rels';
		const value = files.get(relName); const result = new Map<string, { type: string; target: string; external: boolean; }>();
		if (!value) return result;
		for (const element of [...parse(value, owner).documentElement.children]) {
			if (element.namespaceURI !== P || element.localName !== 'Relationship') return fail('package relationship');
			const id = element.getAttribute('Id')!, type = element.getAttribute('Type')!, target = element.getAttribute('Target')!, external = element.getAttribute('TargetMode') === 'External';
			if (!id || !type || !target || result.has(id)) return fail('duplicate relationship');
			result.set(id, { type, target: external ? target : resolve(name, target), external });
		}
		return result;
	};
	const rootRels = relationships(''), main = [...rootRels.values()].find(rel => rel.type === R + '/officeDocument');
	if (!main || main.external) return fail('main document relationship');
	const rels = relationships(main.target);
	const related = (kind: string): Uint8Array | undefined => { const relation = [...rels.values()].find(rel => rel.type === R + '/' + kind); if (relation?.external) return fail('external ' + kind); return relation ? files.get(relation.target) : undefined; };
	const numberDefinitions = new Map<string, { format: string; order: number; }>();
	const numbering = related('numbering');
	if (numbering) {
		const root = parse(numbering, owner).documentElement;
		for (const number of children(root, 'num')) {
			const abstract = children(root, 'abstractNum').find(node => val(node, 'abstractNumId') === val(child(number, 'abstractNumId')));
			if (!abstract) return fail('numbering definition');
			for (const level of children(abstract, 'lvl')) {
				const override = children(number, 'lvlOverride').find(node => val(node, 'ilvl') === val(level, 'ilvl'));
				const definition = override && child(override, 'lvl') || level;
				numberDefinitions.set(`${val(number, 'numId')}:${val(level, 'ilvl')}`, { format: val(child(definition, 'numFmt')) ?? 'decimal', order: Number(val(override && child(override, 'startOverride')) ?? val(child(definition, 'start')) ?? 1) });
			}
		}
	}
	const font = (name: string): string => /times|cambria|georgia|serif/i.test(name) ? 'serif' : /courier|consolas|mono/i.test(name) ? 'monospace' : /arial|calibri|aptos|sans/i.test(name) ? 'sans' : fail('font ' + name);
	const marks = (properties: Element | undefined): DocumentMark[] => {
		if (!properties) return [];
		const result: DocumentMark[] = [], style: Record<string, string | number> = {};
		for (const property of children(properties)) {
			if (['b', 'i'].includes(property.localName)) { if (!['0', 'false', 'off'].includes(val(property) ?? '1')) result.push({ type: property.localName === 'b' ? 'strong' : 'em', attrs: {} }); }
			else if (property.localName === 'rFonts') { const name = val(property, 'ascii') ?? val(property, 'hAnsi'); if (name) style.fontFamily = font(name); }
			else if (property.localName === 'sz' || property.localName === 'szCs') style.fontSize = Math.round(Number(val(property)) / 1.5);
			else if (property.localName === 'rStyle' && !['DefaultParagraphFont', 'Hyperlink'].includes(val(property) ?? '')) return fail('character style ' + val(property));
			else if (!['lang', 'rStyle', 'noProof', 'bCs', 'iCs'].includes(property.localName)) return fail('character formatting ' + property.localName);
		}
		if (Object.keys(style).length) result.push({ type: 'textStyle', attrs: style });
		return result;
	};
	const properties = (element: Element | undefined): DocumentAttributes => {
		const attrs: Record<string, string | number | boolean> = {};
		if (!element) return attrs;
		for (const property of children(element)) {
			const name = property.localName;
			if (['pageBreakBefore', 'keepNext', 'keepLines', 'widowControl'].includes(name)) attrs[({ pageBreakBefore: 'pageBreakBefore', keepNext: 'keepWithNext', keepLines: 'keepTogether', widowControl: 'widowControl' } as Record<string, string>)[name]!] = !['0', 'false', 'off'].includes(val(property) ?? '1');
			else if (name === 'jc') { const value = val(property) ?? 'left'; attrs.textAlign = ({ left: 'start', right: 'end', both: 'justify', center: 'center', start: 'start', end: 'end' } as Record<string, string>)[value] ?? fail('alignment ' + value); }
			else if (name === 'spacing') { for (const [source, target] of [['before', 'spaceBefore'], ['after', 'spaceAfter']] as const) if (val(property, source)) attrs[target] = Number(val(property, source)) / 20; if (val(property, 'line')) { if (val(property, 'lineRule') && val(property, 'lineRule') !== 'auto') return fail('absolute line spacing'); attrs.lineSpacing = Number(val(property, 'line')) / 240; } }
			else if (name === 'ind') { for (const [source, target] of [['left', 'indentStart'], ['right', 'indentEnd'], ['firstLine', 'firstLineIndent']] as const) if (val(property, source)) attrs[target] = Number(val(property, source)) / 20; if (val(property, 'hanging')) attrs.firstLineIndent = -Number(val(property, 'hanging')) / 20; }
			else if (name === 'rPr') Object.assign(attrs, marks(property).find(mark => mark.type === 'textStyle')?.attrs);
			else if (!['pStyle', 'numPr', 'sectPr', 'outlineLvl', 'contextualSpacing'].includes(name)) return fail('paragraph formatting ' + name);
		}
		return attrs;
	};
	const mainRoot = parse(files.get(main.target), owner).documentElement;
	const usedStyles = new Set([...mainRoot.getElementsByTagNameNS(W, 'pStyle')].map(node => val(node)));
	const mergeMarks = (inherited: readonly DocumentMark[], properties: Element | undefined): DocumentMark[] => {
		const own = marks(properties), replaced = new Set(own.map(mark => mark.type));
		for (const [tag, type] of [['b', 'strong'], ['i', 'em']]) if (properties && child(properties, tag!)) replaced.add(type!);
		const style = { ...inherited.find(mark => mark.type === 'textStyle')?.attrs, ...own.find(mark => mark.type === 'textStyle')?.attrs };
		return [...inherited.filter(mark => mark.type !== 'textStyle' && !replaced.has(mark.type)), ...own.filter(mark => mark.type !== 'textStyle'), ...(Object.keys(style).length ? [{ type: 'textStyle', attrs: style }] : [])];
	};
	const styles: { id: string; name: string; level: number; attrs: DocumentAttributes; source: string; marks: readonly DocumentMark[]; }[] = [];
	let defaultStyle: string | undefined;
	const styleBytes = related('styles');
	if (styleBytes) {
		const definitions = children(parse(styleBytes, owner).documentElement, 'style').filter(style => val(style, 'type') === 'paragraph');
		const resolved = new Map<string, DocumentAttributes>();
		const resolvedMarks = new Map<string, readonly DocumentMark[]>();
		defaultStyle = val(definitions.find(style => ['1', 'true', 'on'].includes(val(style, 'default') ?? '')), 'styleId');
		if (defaultStyle) usedStyles.add(defaultStyle);
		const inherit = (style: Element, seen = new Set<string>()): DocumentAttributes => {
			const id = val(style, 'styleId') ?? ''; if (seen.has(id)) return fail('cyclic paragraph style');
			if (resolved.has(id)) return resolved.get(id)!;
			seen.add(id); const parentId = val(child(style, 'basedOn')), parent = parentId && definitions.find(node => val(node, 'styleId') === parentId);
			if (parentId && !parent) return fail('missing inherited style ' + parentId);
			const attrs = { ...(parent ? inherit(parent, seen) : {}), ...properties(child(style, 'pPr')), ...marks(child(style, 'rPr')).find(mark => mark.type === 'textStyle')?.attrs };
			resolvedMarks.set(id, mergeMarks(parent ? resolvedMarks.get(parentId!) ?? [] : [], child(style, 'rPr')));
			resolved.set(id, attrs); return attrs;
		};
		for (const style of definitions.filter(style => usedStyles.has(val(style, 'styleId')))) {
			const source = val(style, 'styleId') ?? '', level = Number(val(child(child(style, 'pPr') ?? style, 'outlineLvl')) ?? (/^Heading([1-6])$/i.exec(source)?.[1] ? Number(/^Heading([1-6])$/i.exec(source)![1]) - 1 : -1)) + 1;
			styles.push({ id: `docx-style-${styles.length}`, source, name: val(child(style, 'name')) ?? source, level, attrs: inherit(style), marks: resolvedMarks.get(source) ?? [] });
		}
	}

	const commentAnchors = new Map<string, { anchor?: { nodeId: string; offset: number; }; head?: { nodeId: string; offset: number; }; }>();
	const commentRecords: DocumentNode[] = [], revisions: DocumentNode[] = [];
	let lastPoint: { nodeId: string; offset: number; } | undefined;
	const pendingStarts: string[] = [], pendingEnds: string[] = [];
	const inline = (element: Element, mode: 'current' | 'before', inherited: readonly DocumentMark[] = []): DocumentNode[] => {
		const result: DocumentNode[] = [];
		for (const node of children(element)) {
			const name = node.localName;
			if (name === 'pPr' || name === 'rPr') continue;
			if (name === 'r' || name === 'hyperlink') {
				let nextMarks = mergeMarks(inherited, child(node, 'rPr'));
				if (name === 'hyperlink') { const id = node.getAttributeNS(R, 'id'), relationship = id && rels.get(id); const destination = relationship ? relationship.external ? safeUrl(relationship.target) : fail('internal hyperlink part') : '#' + val(node, 'anchor'); nextMarks = [...nextMarks, { type: 'link', attrs: { href: destination } }]; }
				result.push(...inline(node, mode, nextMarks));
			} else if (name === 't' || name === 'delText') {
				if (!node.textContent) continue;
				const text = schema.createText(node.textContent, { marks: inherited }); result.push(text);
				if (mode === 'current') { for (const id of pendingStarts.splice(0)) commentAnchors.set(id, { ...commentAnchors.get(id), anchor: { nodeId: text.id, offset: 0 } }); for (const id of pendingEnds.splice(0)) commentAnchors.set(id, { ...commentAnchors.get(id), head: lastPoint ?? { nodeId: text.id, offset: 0 } }); lastPoint = { nodeId: text.id, offset: text.text!.length }; }
			} else if (name === 'br') { if (val(node, 'type') && val(node, 'type') !== 'textWrapping') return fail('inline page/column break'); result.push(schema.createNode('hardBreak')); }
			else if (name === 'tab') result.push(schema.createText('\t', { marks: inherited }));
			else if (name === 'drawing') {
				if (node.children.length !== 1 || node.firstElementChild?.localName !== 'inline' || node.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'srcRect').length) return fail('floating or cropped image');
				const blip = node.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'blip')[0], id = blip?.getAttributeNS(R, 'embed'), image = id && rels.get(id);
				if (!image || image.external || !/\.(png|jpe?g|gif|webp)$/i.test(image.target)) return fail('drawing or external image');
				const data = files.get(image.target); if (!data) return fail('missing image');
				let binary = ''; for (const byte of data) binary += String.fromCharCode(byte);
				const extension = image.target.split('.').at(-1)!.toLowerCase(), extent = node.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'extent')[0];
				result.push(schema.createNode('image', { attrs: { src: `data:image/${extension === 'jpg' ? 'jpeg' : extension};base64,${btoa(binary)}`, alt: node.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'docPr')[0]?.getAttribute('descr') ?? '', ...(extent ? { width: Number(extent.getAttribute('cx')) / 9525, height: Number(extent.getAttribute('cy')) / 9525 } : {}) } }));
			} else if (name === 'ins' || name === 'del') { if ((name === 'ins') === (mode === 'current')) result.push(...inline(node, mode, inherited)); }
			else if (name === 'commentRangeStart' && mode === 'current') pendingStarts.push(val(node, 'id')!);
			else if (name === 'commentRangeEnd' && mode === 'current') { const id = val(node, 'id')!; if (lastPoint) commentAnchors.set(id, { ...commentAnchors.get(id), head: lastPoint }); else pendingEnds.push(id); }
			else if (!['commentReference', 'bookmarkStart', 'bookmarkEnd', 'proofErr', 'commentRangeStart', 'commentRangeEnd', 'lastRenderedPageBreak'].includes(name)) return fail('inline ' + name);
		}
		return result;
	};
	const sectionProperties = (element: Element | undefined): DocumentAttributes => {
		if (!element) return {};
		const size = child(element, 'pgSz'), margin = child(element, 'pgMar');
		const width = Number(val(size, 'w') ?? 11906), height = Number(val(size, 'h') ?? 16838);
		const wide = Math.max(width, height), narrow = Math.min(width, height);
		const pageSize = Math.abs(wide - 16838) < 30 && Math.abs(narrow - 11906) < 30 ? 'a4' : Math.abs(wide - 15840) < 30 && Math.abs(narrow - 12240) < 30 ? 'letter' : fail('custom paper size');
		const margins = ['top', 'right', 'bottom', 'left'].map(side => Number(val(margin, side) ?? 1440));
		if (!margins.every(value => value === margins[0])) return fail('asymmetric page margins');
		const attrs: Record<string, string | number | boolean> = { pageSize, pageOrientation: width > height ? 'landscape' : 'portrait', pageMargin: margins[0]! / 20, pageDifferentFirst: !!child(element, 'titlePg') };
		for (const reference of children(element).filter(node => node.localName === 'headerReference' || node.localName === 'footerReference')) {
			const relation = rels.get(reference.getAttributeNS(R, 'id') ?? ''); if (!relation || relation.external) return fail('header/footer relationship');
			const part = parse(files.get(relation.target), owner);
			if (part.getElementsByTagNameNS(W, 'drawing').length || part.getElementsByTagNameNS(W, 'object').length || part.getElementsByTagNameNS(W, 'fldChar').length || [...part.getElementsByTagNameNS(W, 'p')].filter(node => node.textContent?.trim()).length > 1) return fail('complex running text');
			const variant = val(reference, 'type') ?? 'default';
			if (variant === 'first') { if (part.getElementsByTagNameNS(W, 't').length) return fail('non-empty first-page running text'); continue; }
			const kind = reference.localName === 'headerReference' ? 'Header' : 'Footer';
			attrs[`page${variant === 'even' ? 'Even' : ''}${kind}`] = [...part.getElementsByTagNameNS(W, 't')].map(node => node.textContent).join('');
			if (variant === 'even') attrs.pageDifferentEven = true;
			if ([...part.getElementsByTagNameNS(W, 'fldSimple')].some(node => /PAGE/.test(node.getAttributeNS(W, 'instr') ?? ''))) attrs.pageNumbers = true;
		}
		return attrs;
	};
	interface Entry { node: DocumentNode; number?: string; level: number; section?: DocumentAttributes; }
	const entries = (parent: Element): Entry[] => children(parent).flatMap(node => {
		if (node.localName === 'sectPr') return [];
		if (node.localName === 'tbl') {
			for (const cell of [...node.getElementsByTagNameNS(W, 'tcPr')]) if (child(cell, 'gridSpan') || child(cell, 'vMerge') || child(cell, 'hMerge')) return fail('merged table cells');
			const content = children(node, 'tr').map(row => schema.createNode('tableRow', { content: children(row, 'tc').map(cell => schema.createNode('tableCell', { content: makeBlocks(entries(cell)) })) }));
			return [{ node: schema.createNode('table', { content }), level: 0 }];
		}
		if (node.localName === 'tcPr' || node.localName === 'tblPr' || node.localName === 'tblGrid') return [];
		if (node.localName !== 'p') return fail('block ' + node.localName);
		const pPr = child(node, 'pPr'), style = styles.find(style => style.source === (val(pPr && child(pPr, 'pStyle')) ?? defaultStyle));
		const attrs = { ...properties(pPr), ...(style ? { styleId: style.id, ...(style.level ? { level: style.level } : {}) } : {}) };
		const paragraph = schema.createNode(style?.level ? 'heading' : 'paragraph', { attrs, content: inline(node, 'current', style?.marks ?? []) });
		if (node.getElementsByTagNameNS(W, 'ins').length || node.getElementsByTagNameNS(W, 'del').length) {
			const prior = { ...paragraph, content: inline(node, 'before', style?.marks ?? []) }, revision = node.getElementsByTagNameNS(W, 'ins')[0] ?? node.getElementsByTagNameNS(W, 'del')[0]!;
			revisions.push(schema.createNode('reviewChange', { attrs: { target: paragraph.id, before: JSON.stringify(prior), index: 0, author: val(revision, 'author') ?? 'Author', createdAt: val(revision, 'date') ?? new Date().toISOString() } }));
		}
		const numPr = pPr && child(pPr, 'numPr');
		return [{ node: paragraph, number: numPr && val(child(numPr, 'numId')) !== '0' ? val(child(numPr, 'numId')) : undefined, level: Number(numPr ? val(child(numPr, 'ilvl')) ?? 0 : 0), section: pPr && child(pPr, 'sectPr') ? sectionProperties(child(pPr, 'sectPr')) : undefined }];
	});
	const makeBlocks = (list: Entry[]): DocumentNode[] => {
		const result: DocumentNode[] = []; let index = 0;
		const readList = (number: string, level: number): DocumentNode => {
			const definition = numberDefinitions.get(`${number}:${level}`); if (!definition) return fail('list numbering');
			const items: DocumentNode[] = [];
			while (index < list.length && list[index]!.number === number && list[index]!.level === level) {
				const content = [list[index++]!.node];
				while (index < list.length && list[index]!.number && list[index]!.level > level) content.push(readList(list[index]!.number!, list[index]!.level));
				items.push(schema.createNode('listItem', { content }));
			}
			const formats: Record<string, string> = { decimal: 'decimal', lowerLetter: 'lower-alpha', upperLetter: 'upper-alpha', lowerRoman: 'lower-roman', upperRoman: 'upper-roman' };
			return schema.createNode(definition.format === 'bullet' ? 'bulletList' : 'orderedList', { attrs: definition.format === 'bullet' ? {} : { order: definition.order, numbering: formats[definition.format] ?? fail('number format ' + definition.format) }, content: items });
		};
		while (index < list.length) { const entry = list[index]!; if (entry.number) result.push(readList(entry.number, entry.level)); else { result.push(entry.node); index++; } }
		return result.length ? result : [schema.createNode('paragraph')];
	};
	const body = child(mainRoot, 'body'); if (!body) return fail('missing document body');
	const all = entries(body), sections: DocumentNode[] = []; let pending: Entry[] = [];
	for (const entry of all) { pending.push(entry); if (entry.section) { sections.push(schema.createNode('documentSection', { attrs: entry.section, content: makeBlocks(pending) })); pending = []; } }
	let attrs: DocumentAttributes = sectionProperties(child(body, 'sectPr'));
	const content = sections.length ? [...sections, schema.createNode('documentSection', { attrs, content: makeBlocks(pending) })] : makeBlocks(pending);
	const commentBytes = related('comments');
	if (commentBytes) for (const comment of children(parse(commentBytes, owner).documentElement, 'comment')) {
		const anchor = commentAnchors.get(val(comment, 'id') ?? '');
		commentRecords.push(schema.createNode('reviewComment', { attrs: { body: [...comment.getElementsByTagNameNS(W, 't')].map(node => node.textContent).join('') || ' ', author: val(comment, 'author') ?? 'Author', createdAt: val(comment, 'date') ?? new Date().toISOString(), quote: '', resolved: false, ...(anchor?.anchor && anchor.head ? { anchor: JSON.stringify({ kind: 'text', anchor: anchor.anchor, head: anchor.head }) } : {}) } }));
	}
	if (styles.length) attrs = { ...attrs, paragraphStyles: JSON.stringify(styles.map(({ source: _source, marks: _marks, ...style }) => style)) };
	const document: DocumentNode = { ...schema.createDocument(), attrs, content: [...content, ...commentRecords, ...revisions] };
	schema.validate(document); return document;
}
