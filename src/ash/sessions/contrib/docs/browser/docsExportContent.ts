import { raceCancellationError } from '../../../../base/common/async.js';
import { localize } from '../../../../nls.js';
import { readDocsCommentEvent } from '../common/docsComments.js';
import { readDocsDropdown } from '../common/docsDropdown.js';
import { checkDocsImageSize, isArkdownImageSource, readArkdownImageLayout } from './arkdown/arkdownImages.js';
import { loadArkdown, type ArkdownNode } from './arkdown/arkdownRuntime.js';

/** A detached, presentation-only snapshot shared by the two binary codecs. */
export async function createDocsExportContent(source: string, owner: Document, signal: AbortSignal): Promise<HTMLElement> {
	const runtime = await loadArkdown();
	signal.throwIfAborted();
	using projection = runtime.createProjection();
	const nodes = projection.parse(source);
	const root = owner.createElement('article');
	root.style.cssText = 'font:16px/1.6 sans-serif;color:#171717;background:white;overflow-wrap:anywhere;';
	const tags: Readonly<Record<string, string>> = {
		paragraph: 'p', block_quote: 'blockquote', strong: 'strong', emphasis: 'em', strikethrough: 's', underline: 'u', highlight: 'mark',
		superscript: 'sup', subscript: 'sub', code: 'code', code_block: 'pre', item: 'li', link: 'a', rule: 'hr',
		definition_list: 'dl', definition_list_title: 'dt', definition_list_definition: 'dd', comment: 'span', text_color: 'span',
	};
	const colors = { red: '#bc3030', yellow: '#916500', green: '#237040', teal: '#14767b', purple: '#8040a0' };
	const text = (node: ArkdownNode): string => node.text ?? node.children.map(text).join('');
	const append = (parent: HTMLElement, node: ArkdownNode): void => {
		const raw = source.slice(node.range.start, node.range.end);
		if (node.kind === 'metadata_block' || node.kind === 'code_block' && readDocsCommentEvent(raw)) return;
		if (node.kind === 'text') { parent.append(owner.createTextNode(node.text ?? '')); return; }
		if (node.kind === 'soft_break') { parent.append(owner.createTextNode('\n')); return; }
		if (node.kind === 'hard_break') { parent.append(owner.createElement('br')); return; }
		if (node.kind === 'task_list_marker') { parent.append(owner.createTextNode(node.checked ? '☑ ' : '☐ ')); return; }
		if (node.kind === 'code_block') {
			const dropdown = readDocsDropdown(raw);
			if (dropdown) { const paragraph = owner.createElement('p'); paragraph.textContent = `${dropdown.label}: ${dropdown.options[dropdown.selected]}`; parent.append(paragraph); return; }
		}
		if (node.kind === 'table') {
			const table = owner.createElement('table');
			table.style.cssText = 'border-collapse:collapse;width:100%;table-layout:fixed;margin:12px 0;';
			const colgroup = owner.createElement('colgroup');
			for (const width of node.tableLayout!.widths) { const col = owner.createElement('col'); if (width) col.style.width = `${width}px`; colgroup.append(col); }
			table.append(colgroup);
			for (const [rowIndex, row] of node.children.entries()) {
				const tr = owner.createElement('tr'); table.append(tr);
				for (const [column, cell] of row.children.entries()) {
					if (cell.tableCellMissing) continue;
					const layout = node.tableLayout!.cells.find(value => value.row === rowIndex && value.column === column);
					const element = owner.createElement(rowIndex === 0 && node.tableLayout!.header ? 'th' : 'td');
					element.style.cssText = 'border:1px solid #b8b8b8;padding:7px;vertical-align:top;';
					if (layout) { element.rowSpan = layout.rowspan; element.colSpan = layout.colspan; }
					const alignment = node.alignments?.[column];
					if (alignment && alignment !== 'none') element.style.textAlign = alignment;
					for (const child of cell.children) append(element, child);
					tr.append(element);
				}
			}
			parent.append(table); return;
		}
		if (node.kind === 'image') {
			if (!node.destination || !isArkdownImageSource(node.destination)) throw new Error(localize({ bundle: 'ash.docs', key: 'exportImageFailed' }, 'An image could not be included in the exported document.'));
			const layout = readArkdownImageLayout(node.title);
			const image = owner.createElement('img');
			image.src = node.destination; image.alt = text(node);
			image.style.cssText = 'max-width:100%;height:auto;';
			if (layout.width) image.style.width = `${layout.width}px`;
			if (layout.alignment !== 'left') { image.style.display = 'block'; image.style.marginLeft = 'auto'; if (layout.alignment === 'center') image.style.marginRight = 'auto'; }
			parent.append(image); return;
		}
		const tag = node.kind === 'heading' ? `h${node.level}` : node.kind === 'list' ? node.start === undefined ? 'ul' : 'ol' : tags[node.kind] ?? 'span';
		const element = owner.createElement(tag);
		if (tag === 'p') element.style.cssText = 'margin:0 0 12px;';
		if (tag === 'pre') element.style.cssText = 'white-space:pre-wrap;font:13px/1.5 monospace;background:#f4f4f4;padding:12px;';
		if (tag === 'blockquote') element.style.cssText = 'margin:12px 0;padding-left:16px;border-left:3px solid #aaa;';
		if (tag === 'a' && node.destination && /^(?:https?:|mailto:|#)/i.test(node.destination)) { element.setAttribute('href', node.destination); element.style.color = '#185abc'; }
		if (tag === 'ol') element.setAttribute('start', String(node.start));
		if (node.color) element.style.color = colors[node.color];
		if (node.text !== undefined) element.textContent = node.text;
		else if (node.children.length) for (const child of node.children) append(element, child);
		else if (!['rule', 'comment'].includes(node.kind)) element.textContent = raw;
		parent.append(element);
	};
	for (const node of nodes) append(root, node);
	// Freeze image resources as bytes, so neither codec needs the live editor or
	// a network-capable document while serializing the captured version.
	for (const image of root.querySelectorAll('img')) {
		signal.throwIfAborted();
		if (!image.src.startsWith('data:')) {
			const timeout = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
			const response = await fetch(image.src, { signal: timeout, credentials: 'omit' });
			const mime = response.headers.get('content-type')?.split(';')[0];
			if (!response.ok || !mime || !/^image\/(png|jpeg|gif|webp)$/.test(mime)) throw new Error(localize({ bundle: 'ash.docs', key: 'exportImageFailed' }, 'An image could not be included in the exported document.'));
			checkDocsImageSize(Number(response.headers.get('content-length') ?? 0));
			const bytes = new Uint8Array(await response.arrayBuffer());
			checkDocsImageSize(bytes.length);
			let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
			image.src = `data:${mime};base64,${btoa(binary)}`;
		}
		await raceCancellationError(image.decode(), signal);
		if (/^data:image\/(?:gif|webp);/i.test(image.src)) {
			const canvas = owner.createElement('canvas');
			canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
			if (canvas.width * canvas.height > 32 * 1024 * 1024) throw new Error(localize({ bundle: 'ash.docs', key: 'exportImageFailed' }, 'An image could not be included in the exported document.'));
			try { canvas.getContext('2d')!.drawImage(image, 0, 0); image.src = canvas.toDataURL('image/png'); }
			finally { canvas.width = canvas.height = 0; }
			await raceCancellationError(image.decode(), signal);
		}
		if (!image.style.width) image.style.width = `${Math.min(666, image.naturalWidth)}px`;
		const width = Math.min(666, Number.parseFloat(image.style.width));
		image.style.width = `${width}px`;
		image.dataset.exportWidth = String(width);
		image.dataset.exportHeight = String(width * image.naturalHeight / image.naturalWidth);
	}
	return root;
}
