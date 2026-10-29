import { DocumentPageView } from '../pageLayout/documentPageView.js';
import type { DocumentNode } from '../../../common/model/document.js';
import { localize } from 'ash:editor/nls.js';

/** Capture synchronously before any await; further editing cannot change this output version. */
export function exportDocumentPdf(source: HTMLElement, document: DocumentNode, signal: AbortSignal): Promise<Uint8Array> {
	signal.throwIfAborted();
	const owner = source.ownerDocument,
		root = owner.createElement('div');
	root.setAttribute('aria-hidden', 'true');
	root.inert = true;
	const scope = source.closest<HTMLElement>('[data-ash-editor-client]')?.dataset.ashEditorClient;
	if (scope) root.dataset.ashEditorClient = scope;
	const sourceStyle = owner.defaultView!.getComputedStyle(source);
	for (const property of sourceStyle) if (property.startsWith('--')) root.style.setProperty(property, sourceStyle.getPropertyValue(property));
	root.style.cssText += 'position:fixed;left:-100000px;top:0;pointer-events:none;';
	root.style.font = sourceStyle.font;
	root.style.color = sourceStyle.color;
	root.style.width = `${source.clientWidth}px`;
	const content = owner.createDocumentFragment();
	const copy = (element: HTMLElement): HTMLElement => {
		const clone = element.cloneNode(true) as HTMLElement;
		const originals = [element, ...element.querySelectorAll<HTMLElement>('*')],
			clones = [clone, ...clone.querySelectorAll<HTMLElement>('*')];
		for (const [index, original] of originals.entries()) {
			const target = clones[index]!,
				style = owner.defaultView!.getComputedStyle(original);
			for (const property of style) target.style.setProperty(property, style.getPropertyValue(property));
			target.style.outline = 'none';
			target.style.caretColor = 'transparent';
			if (target.hasAttribute('contenteditable')) target.contentEditable = 'false';
			if (original.tagName === 'TEXTAREA') target.textContent = (original as HTMLTextAreaElement).value;
		}
		for (const gap of clone.querySelectorAll('.ash-document-page-gap')) gap.remove();
		for (const run of clone.querySelectorAll('[data-text-node-id]')) run.normalize();
		return clone;
	};
	for (const node of document.content) {
		if (node.type.startsWith('review')) continue;
		const element = [...source.querySelectorAll<HTMLElement>('[data-node-id]')].find(element => element.dataset.nodeId === node.id);
		if (!element) throw new Error(localize('document.pdf.layoutRequired', 'The document must be laid out before exporting PDF.'));
		if (node.type === 'documentSection') {
			const wrapper = owner.createElement('div');
			wrapper.dataset.nodeId = node.id;
			for (const child of (element.querySelector('.ash-document-page-flow') ?? element).children) wrapper.append(copy(child as HTMLElement));
			content.append(wrapper);
		} else content.append(copy(element));
	}
	const view = new DocumentPageView(root, () => {}, false);
	owner.body.append(root);
	try {
		view.render(content, {
			...document,
			attrs: { ...document.attrs, pageSize: document.attrs.pageSize === 'letter' ? 'letter' : 'a4' },
			content: document.content.map(node =>
				node.type === 'documentSection'
					? {
							...node,
							attrs: {
								...node.attrs,
								pageSize: node.attrs.pageSize === 'letter' ? 'letter' : node.attrs.pageSize === 'a4' ? 'a4' : document.attrs.pageSize === 'letter' ? 'letter' : 'a4',
							},
						}
					: node,
			),
		});
	} catch (error) {
		view.dispose();
		root.remove();
		throw error;
	}
	return (async () => {
		try {
			await waitForResource(owner.fonts.ready, signal);
			signal.throwIfAborted();
			for (const image of root.querySelectorAll<HTMLImageElement>('img')) {
				if (!image.src.startsWith('data:')) {
					const response = await fetch(image.src, { signal });
					if (!response.ok) throw new Error('Image resource unavailable');
					const bytes = new Uint8Array(await response.arrayBuffer());
					if (bytes.length > 16 * 1024 * 1024) throw new RangeError('Image exceeds PDF resource limit');
					let binary = '';
					for (const byte of bytes) binary += String.fromCharCode(byte);
					image.src = `data:${response.headers.get('content-type') ?? 'image/png'};base64,${btoa(binary)}`;
				}
				await waitForResource(image.decode(), signal);
				signal.throwIfAborted();
			}
			view.layout();
			const pages = [...root.querySelectorAll<HTMLElement>('.ash-document-page')].map(page => page.getBoundingClientRect());
			if (pages.length > 256) throw new RangeError('PDF exceeds 256 pages');
			const origin = root.getBoundingClientRect();
			// The SVG image has no access to the host stylesheets. Freeze the newly
			// created page shells and geometry as well as the original body elements.
			for (const element of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
				const computed = owner.defaultView!.getComputedStyle(element);
				for (const property of computed) element.style.setProperty(property, computed.getPropertyValue(property));
			}
			const serialized = root.cloneNode(true) as HTMLElement;
			// Remove both physical and logical offscreen insets. Keeping a computed
			// inset-inline-start would override left:0 inside the serialized SVG.
			serialized.removeAttribute('style');
			serialized.style.cssText = `position:relative;margin:0;padding:0;width:${root.offsetWidth}px;height:${root.scrollHeight}px;`;
			const html = new owner.defaultView!.XMLSerializer().serializeToString(serialized);
			if (html.length > 16 * 1024 * 1024) throw new RangeError('PDF snapshot exceeds resource limit');
			const images: {
				width: number;
				height: number;
				bytes: Uint8Array;
				pixelWidth: number;
				pixelHeight: number;
			}[] = [];
			let size = 0;
			for (const page of pages) {
				signal.throwIfAborted();
				const canvas = owner.createElement('canvas');
				canvas.width = Math.ceil(page.width * 2);
				canvas.height = Math.ceil(page.height * 2);
				const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="${page.left - origin.left} ${page.top - origin.top} ${page.width} ${page.height}"><foreignObject x="0" y="0" width="${Math.max(root.scrollWidth, page.width)}" height="${root.scrollHeight}">${html}</foreignObject></svg>`;
				const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
				try {
					const image = new owner.defaultView!.Image();
					image.src = url;
					await waitForResource(image.decode(), signal);
					const context = canvas.getContext('2d')!;
					context.fillStyle = 'white';
					context.fillRect(0, 0, canvas.width, canvas.height);
					context.drawImage(image, 0, 0);
					const blob = await new Promise<Blob>((resolve, reject) =>
						canvas.toBlob(value => (value ? resolve(value) : reject(new Error('PDF page could not be rendered'))), 'image/jpeg', 0.95),
					);
					const bytes = new Uint8Array(await blob.arrayBuffer());
					size += bytes.length;
					if (size > 64 * 1024 * 1024) throw new RangeError('PDF exceeds 64 MiB');
					images.push({
						width: page.width * 0.75,
						height: page.height * 0.75,
						bytes,
						pixelWidth: canvas.width,
						pixelHeight: canvas.height,
					});
				} finally {
					canvas.width = canvas.height = 0;
				}
			}
			signal.throwIfAborted();
			return createPdf(images);
		} finally {
			view.dispose();
			root.remove();
		}
	})();
}

function createPdf(pages: readonly { width: number; height: number; bytes: Uint8Array; pixelWidth: number; pixelHeight: number }[]): Uint8Array {
	const encode = (value: string) => new TextEncoder().encode(value);
	const chunks: Uint8Array[] = [encode('%PDF-1.4\n')],
		offsets = [0];
	let length = chunks[0]!.length;
	const object = (id: number, parts: readonly Uint8Array[]) => {
		offsets[id] = length;
		for (const bytes of [encode(`${id} 0 obj\n`), ...parts, encode('\nendobj\n')]) {
			chunks.push(bytes);
			length += bytes.length;
		}
	};
	object(1, [encode('<< /Type /Catalog /Pages 2 0 R >>')]);
	object(2, [encode(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${3 + index * 3} 0 R`).join(' ')}] >>`)]);
	for (const [index, page] of pages.entries()) {
		const id = 3 + index * 3,
			content = encode(`q ${page.width} 0 0 ${page.height} 0 0 cm /Im0 Do Q`);
		object(id, [encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`)]);
		object(id + 1, [encode(`<< /Length ${content.length} >>\nstream\n`), content, encode('\nendstream')]);
		object(id + 2, [
			encode(
				`<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`,
			),
			page.bytes,
			encode('\nendstream'),
		]);
	}
	const start = length,
		count = offsets.length;
	chunks.push(
		encode(
			`xref\n0 ${count}\n0000000000 65535 f \n${offsets
				.slice(1)
				.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`)
				.join('')}trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`,
		),
	);
	const result = new Uint8Array(chunks.reduce((sum, bytes) => sum + bytes.length, 0));
	let position = 0;
	for (const bytes of chunks) {
		result.set(bytes, position);
		position += bytes.length;
	}
	return result;
}

async function waitForResource<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	let abort!: () => void;
	try {
		return await new Promise<T>((resolve, reject) => {
			abort = () => reject(signal.reason);
			signal.addEventListener('abort', abort, { once: true });
			pending.then(resolve, reject);
		});
	} finally {
		signal.removeEventListener('abort', abort);
	}
}
