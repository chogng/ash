import { convertHtmlToMarkdown } from '../../../../base/browser/htmlToMarkdown.js';
import { unzipFiles } from '../../../../base/browser/zip.js';
import { localize } from '../../../../nls.js';
import { getMediaMime } from '../../../../base/common/mime.js';

const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
function unsupported(): never { throw new Error(localize({ bundle: 'ash.docs', key: 'unsupportedImport' }, 'This document contains content that Docs cannot import.')); }

/** Read interoperable OOXML only. Extension snapshots never select a model or editor. */
export async function importDocsDocx(bytes: Uint8Array, owner: Document, signal: AbortSignal): Promise<string> {
	const files = await unzipFiles(bytes, signal);
	const parse = (path: string): XMLDocument => {
		const data = files.get(path);
		if (!data) return unsupported();
		const text = decode(data);
		if (/<!DOCTYPE|<!ENTITY/i.test(text)) return unsupported();
		const xml = new owner.defaultView!.DOMParser().parseFromString(text, 'application/xml');
		if (xml.getElementsByTagName('parsererror').length) return unsupported();
		return xml;
	};
	const relationships = (path: string) => {
		const slash = path.lastIndexOf('/');
		const relPath = path.slice(0, slash + 1) + '_rels/' + path.slice(slash + 1) + '.rels';
		const result = new Map<string, { type: string; target: string; external: boolean; }>();
		if (!files.has(relPath)) return result;
		const root = parse(relPath).documentElement;
		if (root.namespaceURI !== packageNamespace || root.localName !== 'Relationships') return unsupported();
		for (const element of root.children) {
			const id = element.getAttribute('Id'), type = element.getAttribute('Type'), target = element.getAttribute('Target');
			if (element.namespaceURI !== packageNamespace || element.localName !== 'Relationship' || !id || !type || !target || result.has(id)) return unsupported();
			const external = element.getAttribute('TargetMode') === 'External';
			const resolved = new URL(target, 'https://package.invalid/' + path);
			if (!external && (resolved.origin !== 'https://package.invalid' || resolved.search || resolved.hash)) return unsupported();
			result.set(id, { type, external, target: external ? target : decodeURIComponent(resolved.pathname.slice(1)) });
		}
		return result;
	};
	if ([...files.keys()].some(path => /vbaProject|\/embeddings\/|\/activeX\//i.test(path))) return unsupported();
	const main = [...relationships('').values()].find(rel => rel.type === office + '/officeDocument');
	if (!main || main.external) return unsupported();
	const rels = relationships(main.target);
	const document = parse(main.target);
	if (document.documentElement.namespaceURI !== word || document.documentElement.localName !== 'document') return unsupported();
	const body = document.getElementsByTagNameNS(word, 'body');
	if (body.length !== 1) return unsupported();
	const value = (element: Element | undefined, attr = 'val') => element?.getAttributeNS(word, attr);
	const child = (element: Element, name: string) => [...element.children].find(node => node.namespaceURI === word && node.localName === name);
	const numbering = new Map<string, { ordered: boolean; start: number; }>();
	const numberPart = [...rels.values()].find(rel => rel.type === office + '/numbering');
	if (numberPart) {
		if (numberPart.external) return unsupported();
		const root = parse(numberPart.target).documentElement;
		for (const number of [...root.children].filter(node => node.localName === 'num')) {
			const abstractId = value(child(number, 'abstractNumId'));
			const abstract = [...root.children].find(node => node.localName === 'abstractNum' && value(node, 'abstractNumId') === abstractId);
			if (!abstract) return unsupported();
			for (const level of [...abstract.children].filter(node => node.localName === 'lvl')) {
				const format = value(child(level, 'numFmt'));
				if (format !== 'decimal' && format !== 'bullet') return unsupported();
				const index = value(level, 'ilvl') ?? '0';
				const override = [...number.children].find(node => node.localName === 'lvlOverride' && value(node, 'ilvl') === index);
				const start = Number(value(override ? child(override, 'startOverride') : undefined) ?? value(child(level, 'start')) ?? '1');
				if (!Number.isSafeInteger(start) || start < 0) return unsupported();
				numbering.set(`${value(number, 'numId')}:${index}`, { ordered: format === 'decimal', start });
			}
		}
	}
	const output = owner.createElement('article');
	const enabled = (element: Element, name: string) => { const property = child(element, name); return !!property && !['0', 'false', 'off'].includes(value(property) ?? ''); };
	const append = (source: Element, parent: HTMLElement, depth: number): void => {
		signal.throwIfAborted();
		if (depth > 100) return unsupported();
		const lists: { id: string; list: HTMLElement; }[] = [];
		for (const node of source.children) {
			if (node.namespaceURI !== word) return unsupported();
			const name = node.localName;
			if (['pPr', 'rPr', 'tblPr', 'tblGrid', 'trPr', 'tcPr', 'sectPr', 'bookmarkStart', 'bookmarkEnd', 'proofErr', 'lastRenderedPageBreak'].includes(name)) continue;
			if (name === 't') { parent.append(owner.createTextNode(node.textContent ?? '')); continue; }
			if (name === 'tab') { parent.append(owner.createTextNode('\t')); continue; }
			if (name === 'br' || name === 'cr') { parent.append(owner.createElement('br')); continue; }
			if (name === 'drawing') {
				const blips = node.getElementsByTagNameNS(drawing, 'blip');
				if (blips.length !== 1) return unsupported();
				const rel = rels.get(blips[0].getAttributeNS(office, 'embed') ?? '');
				if (!rel || rel.external || rel.type !== office + '/image') return unsupported();
				const data = files.get(rel.target), mime = getMediaMime(rel.target);
				if (!data || !mime || !/^image\/(?:png|jpeg|gif|webp)$/.test(mime) || data.length > 8 * 1024 * 1024) return unsupported();
				let binary = ''; for (const byte of data) binary += String.fromCharCode(byte);
				const image = owner.createElement('img');
				image.src = `data:${mime};base64,${btoa(binary)}`;
				image.alt = [...node.getElementsByTagName('*')].find(element => element.localName === 'docPr')?.getAttribute('descr') || '';
				parent.append(image); continue;
			}
			if (name === 'hyperlink') {
				const anchor = value(node, 'anchor');
				const rel = rels.get(node.getAttributeNS(office, 'id') ?? '');
				const href = anchor ? '#' + anchor : rel?.external && rel.type === office + '/hyperlink' ? rel.target : undefined;
				if (!href || !/^(https?:|mailto:|#)/i.test(href)) return unsupported();
				const link = owner.createElement('a'); link.setAttribute('href', href); append(node, link, depth + 1); parent.append(link); continue;
			}
			if (name !== 'p') lists.length = 0;
			if (name === 'r') {
				const run = owner.createElement('span'), properties = child(node, 'rPr');
				append(node, run, depth + 1);
				let formatted: HTMLElement = run;
				for (const [property, tag] of [['b', 'strong'], ['i', 'em'], ['strike', 'del']] as const) if (properties && enabled(properties, property)) {
					const wrapper = owner.createElement(tag); wrapper.append(formatted); formatted = wrapper;
				}
				parent.append(formatted); continue;
			}
			if (name === 'p') {
				const properties = child(node, 'pPr');
				const num = properties && child(properties, 'numPr');
				const numId = num && value(child(num, 'numId'));
				if (numId && numId !== '0') {
					const level = Number(value(child(num!, 'ilvl')) ?? '0');
					const definition = numbering.get(`${numId}:${level}`);
					if (!definition || !Number.isInteger(level) || level < 0 || level > 8 || level > lists.length) return unsupported();
					lists.length = Math.min(lists.length, level + 1);
					if (lists[level]?.id !== numId) {
						const list = owner.createElement(definition.ordered ? 'ol' : 'ul');
						if (definition.ordered) list.setAttribute('start', String(definition.start));
						const container = level === 0 ? parent : lists[level - 1].list.lastElementChild;
						if (!container) return unsupported();
						container.append(list); lists[level] = { id: numId, list };
					}
					const item = owner.createElement('li'); append(node, item, depth + 1); lists[level].list.append(item); continue;
				}
				lists.length = 0;
				const style = properties && value(child(properties, 'pStyle'));
				const heading = style?.match(/^Heading([1-6])$/i)?.[1];
				const paragraph = owner.createElement(heading ? `h${heading}` : 'p'); append(node, paragraph, depth + 1); parent.append(paragraph); continue;
			}
			const tag = name === 'tbl' ? 'table' : name === 'tr' ? 'tr' : name === 'tc' ? 'td' : undefined;
			if (!tag) return unsupported();
			if (name === 'tc') {
				const properties = child(node, 'tcPr');
				if (properties && (child(properties, 'vMerge') || Number(value(child(properties, 'gridSpan')) ?? '1') !== 1)) return unsupported();
			}
			const element = owner.createElement(tag); append(node, element, depth + 1); parent.append(element);
		}
	};
	append(body[0], output, 0);
	// The shared HTML converter is bounded for clipboard input. Reject a larger
	// projection explicitly instead of creating an empty document.
	if (output.innerHTML.length > 200_000) return unsupported();
	return convertHtmlToMarkdown(output.innerHTML, owner);
}
