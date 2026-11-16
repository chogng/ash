import { decodeBase64 } from '../../../../base/common/buffer.js';
import { zipFiles } from '../../../../base/browser/zip.js';

const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const escape = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[value]!);
const xml = (text: string) => new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + text);

/** Standard OOXML paragraphs, runs, numbering, tables and drawings; no private snapshot. */
export function exportDocsDocx(content: HTMLElement, signal: AbortSignal): Uint8Array {
	const files = new Map<string, Uint8Array>();
	const relationships: string[] = [], numbering: string[] = [], imageTypes = new Set<string>();
	let nextRelation = 1, nextList = 1, nextImage = 1;
	const relation = (type: string, target: string, external = false) => {
		const id = `rId${nextRelation++}`;
		relationships.push(`<Relationship Id="${id}" Type="${office}/${type}" Target="${escape(target)}"${external ? ' TargetMode="External"' : ''}/>`);
		return id;
	};
	const run = (text: string, properties = '') => `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}${text.split(/\n/).map(line => `<w:t xml:space="preserve">${escape(line)}</w:t>`).join('<w:br/>')}</w:r>`;
	const inline = (node: Node, properties = ''): string => {
		signal.throwIfAborted();
		if (node.nodeType === 3) return run(node.textContent ?? '', properties);
		if (node.nodeType !== 1) return '';
		const element = node as HTMLElement, tag = element.tagName;
		if (tag === 'BR') return '<w:r><w:br/></w:r>';
		if (tag === 'IMG') {
			const image = element as HTMLImageElement;
			const match = /^data:image\/(png|jpeg|gif|webp);base64,(.+)$/.exec(image.src)!;
			const id = nextImage++, extension = match[1], name = `media/image${id}.${extension}`;
			files.set('word/' + name, decodeBase64(match[2]).buffer); imageTypes.add(extension);
			const rel = relation('image', name);
			const width = Math.round(Number(image.dataset.exportWidth) * 9525), height = Math.round(Number(image.dataset.exportHeight) * 9525);
			return `<w:r><w:drawing><wp:inline><wp:extent cx="${width}" cy="${height}"/><wp:docPr id="${id}" name="image${id}" descr="${escape(image.alt)}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
		}
		const property = tag === 'STRONG' || tag === 'B' ? '<w:b/>' : tag === 'EM' || tag === 'I' ? '<w:i/>' : tag === 'S' ? '<w:strike/>' : tag === 'U' ? '<w:u w:val="single"/>' : tag === 'MARK' ? '<w:highlight w:val="yellow"/>' : tag === 'SUP' || tag === 'SUB' ? `<w:vertAlign w:val="${tag === 'SUP' ? 'superscript' : 'subscript'}"/>` : tag === 'CODE' ? '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>' : '';
		const color = element.style.color.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
		const colorProperty = color ? `<w:color w:val="${color.slice(1).map(value => Number(value).toString(16).padStart(2, '0')).join('')}"/>` : '';
		const children = [...element.childNodes].map(child => inline(child, properties + property + colorProperty)).join('');
		if (tag !== 'A' || !element.getAttribute('href')) return children;
		const href = element.getAttribute('href')!;
		return href.startsWith('#') ? children : `<w:hyperlink r:id="${relation('hyperlink', href, true)}">${children}</w:hyperlink>`;
	};
	type List = { id: number; depth: number; };
	const paragraph = (children: string, properties = '', list?: List) => `<w:p><w:pPr>${properties}${list ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${list.id}"/></w:numPr>` : ''}</w:pPr>${children}</w:p>`;
	const blocks = (container: HTMLElement, list?: List, depth = 0): string => {
		const output: string[] = [];
		let pending = '', first = true;
		const flush = () => { if (pending) { output.push(paragraph(pending, '', first ? list : undefined)); pending = ''; first = false; } };
		for (const child of container.childNodes) {
			signal.throwIfAborted();
			if (child.nodeType !== 1) { pending += inline(child); continue; }
			const element = child as HTMLElement, tag = element.tagName;
			if (!/^(P|H[1-6]|PRE|BLOCKQUOTE|UL|OL|TABLE|HR|DL|DT|DD)$/.test(tag)) { pending += inline(element); continue; }
			flush();
			if (tag === 'UL' || tag === 'OL') {
				const id = nextList++, ordered = tag === 'OL', start = element.getAttribute('start') ?? '1';
				numbering.push(`<w:abstractNum w:abstractNumId="${id}"><w:lvl w:ilvl="0"><w:start w:val="${escape(start)}"/><w:numFmt w:val="${ordered ? 'decimal' : 'bullet'}"/><w:lvlText w:val="${ordered ? '%1.' : '•'}"/><w:pPr><w:ind w:left="${(depth + 1) * 360}" w:hanging="240"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="${id}"><w:abstractNumId w:val="${id}"/></w:num>`);
				for (const item of element.children) output.push(blocks(item as HTMLElement, { id, depth }, depth + 1));
			} else if (tag === 'TABLE') {
				const rows = [...(element as HTMLTableElement).rows];
				const spans = new Map<number, { remaining: number; columns: number; }>();
				const columns = Math.max(1, ...rows.map(row => [...row.cells].reduce((sum, cell) => sum + cell.colSpan, 0)));
				const grid = '<w:tblGrid>' + Array.from({ length: columns }, () => '<w:gridCol w:w="2000"/>').join('') + '</w:tblGrid>';
				const tableRows = rows.map(row => {
					const cells: string[] = []; let column = 0;
					const continued = () => {
						while (spans.has(column)) {
							const span = spans.get(column)!;
							cells.push(`<w:tc><w:tcPr><w:gridSpan w:val="${span.columns}"/><w:vMerge/></w:tcPr><w:p/></w:tc>`);
							if (--span.remaining === 0) spans.delete(column);
							column += span.columns;
						}
					};
					for (const cell of row.cells) {
						continued();
						const merge = cell.rowSpan > 1 ? '<w:vMerge w:val="restart"/>' : '';
						cells.push(`<w:tc><w:tcPr><w:gridSpan w:val="${cell.colSpan}"/>${merge}</w:tcPr>${blocks(cell)}<w:p/></w:tc>`);
						if (cell.rowSpan > 1) spans.set(column, { remaining: cell.rowSpan - 1, columns: cell.colSpan });
						column += cell.colSpan;
					}
					continued();
					return `<w:tr>${cells.join('')}</w:tr>`;
				});
				output.push(`<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => `<w:${side} w:val="single" w:sz="4" w:color="B8B8B8"/>`).join('')}</w:tblBorders></w:tblPr>${grid}${tableRows.join('')}</w:tbl>`);
			} else if (tag === 'BLOCKQUOTE' || tag === 'DL' || tag === 'DD') output.push(blocks(element, undefined, depth));
			else {
				const heading = /^H[1-6]$/.test(tag) ? `<w:pStyle w:val="Heading${tag[1]}"/>` : '';
				const rule = tag === 'HR' ? '<w:pBdr><w:bottom w:val="single" w:sz="4"/></w:pBdr>' : '';
				const contents = tag === 'PRE' ? run(element.textContent ?? '', '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>') : [...element.childNodes].map(child => inline(child)).join('');
				output.push(paragraph(contents, heading + rule, first ? list : undefined)); first = false;
			}
		}
		flush(); return output.join('');
	};
	const body = blocks(content) || '<w:p/>';
	relation('styles', 'styles.xml');
	if (numbering.length) { relation('numbering', 'numbering.xml'); files.set('word/numbering.xml', xml(`<w:numbering xmlns:w="${word}">${numbering.join('')}</w:numbering>`)); }
	files.set('word/document.xml', xml(`<w:document xmlns:w="${word}" xmlns:r="${office}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="960" w:bottom="960" w:left="960" w:right="960"/></w:sectPr></w:body></w:document>`));
	files.set('word/styles.xml', xml(`<w:styles xmlns:w="${word}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>${Array.from({ length: 6 }, (_, index) => `<w:style w:type="paragraph" w:styleId="Heading${index + 1}"><w:name w:val="heading ${index + 1}"/><w:pPr><w:keepNext/><w:outlineLvl w:val="${index}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${40 - index * 3}"/></w:rPr></w:style>`).join('')}</w:styles>`));
	files.set('_rels/.rels', xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="${office}/officeDocument" Target="word/document.xml"/></Relationships>`));
	files.set('word/_rels/document.xml.rels', xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join('')}</Relationships>`));
	files.set('[Content_Types].xml', xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...imageTypes].map(type => `<Default Extension="${type}" ContentType="image/${type}"/>`).join('')}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>${numbering.length ? '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' : ''}</Types>`));
	return zipFiles(files);
}
