import { raceCancellationError } from '../../../../base/common/async.js';
import { createImagePdf } from '../../../../base/common/pdf.js';
import { localize } from '../../../../nls.js';

const pageWidth = 794, pageHeight = 1123, margin = 64, scale = 2;

/** Render a detached snapshot on white A4 pages in both Desktop and Browser hosts. */
export async function exportDocsPdf(content: HTMLElement, signal: AbortSignal): Promise<Uint8Array> {
	signal.throwIfAborted();
	const owner = content.ownerDocument;
	const frame = owner.createElement('section');
	frame.inert = true; frame.setAttribute('aria-hidden', 'true');
	frame.style.cssText = `position:fixed;left:-100000px;top:0;width:${pageWidth - margin * 2}px;pointer-events:none;`;
	frame.append(content); owner.body.append(frame);
	try {
		await raceCancellationError(owner.fonts.ready, signal);
		const height = content.getBoundingClientRect().height;
		if (height > 256 * (pageHeight - margin * 2)) throw new RangeError(localize('document.output.tooLarge', 'Document output exceeds 64 MiB.'));
		// Freeze browser defaults too: the SVG image has no host stylesheets.
		for (const element of [content, ...content.querySelectorAll<HTMLElement>('*')]) {
			const style = owner.defaultView!.getComputedStyle(element);
			for (const property of style) element.style.setProperty(property, style.getPropertyValue(property));
		}
		const origin = content.getBoundingClientRect().top;
		const breaks = [...content.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,tr,pre,blockquote')]
			.map(element => element.getBoundingClientRect().bottom - origin).sort((a, b) => a - b);
		const html = new owner.defaultView!.XMLSerializer().serializeToString(content);
		if (html.length > 16 * 1024 * 1024) throw new RangeError(localize('document.output.tooLarge', 'Document output exceeds 64 MiB.'));
		const pages: { width: number; height: number; bytes: Uint8Array; pixelWidth: number; pixelHeight: number; }[] = [];
		let top = 0, size = 0;
		do {
			signal.throwIfAborted();
			if (pages.length === 256) throw new RangeError(localize('document.output.tooLarge', 'Document output exceeds 64 MiB.'));
			const available = pageHeight - margin * 2;
			const limit = Math.min(height, top + available);
			// Prefer a completed block near the page end; tall blocks still advance
			// by a full page rather than leaving a mostly empty page or looping.
			const candidates = breaks.filter(value => value > top + available * 0.6 && value <= limit);
			const bottom = limit < height && candidates.length ? candidates.at(-1)! : limit;
			const sliceHeight = Math.max(1, bottom - top);
			const canvas = owner.createElement('canvas');
			canvas.width = pageWidth * scale; canvas.height = pageHeight * scale;
			try {
				const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${pageWidth} ${pageHeight}"><rect width="100%" height="100%" fill="white"/><svg x="${margin}" y="${margin}" width="${pageWidth - margin * 2}" height="${sliceHeight}" viewBox="0 ${top} ${pageWidth - margin * 2} ${sliceHeight}"><foreignObject width="${pageWidth - margin * 2}" height="${Math.max(1, height)}">${html}</foreignObject></svg></svg>`;
				const image = new owner.defaultView!.Image();
				image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
				await raceCancellationError(image.decode(), signal);
				const context = canvas.getContext('2d')!;
				context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0);
				const blob = await raceCancellationError(new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error(localize({ bundle: 'ash.docs', key: 'exportPdfFailed' }, 'The PDF document could not be rendered.'))), 'image/jpeg', 0.95)), signal);
				const bytes = new Uint8Array(await blob.arrayBuffer());
				size += bytes.length;
				if (size > 64 * 1024 * 1024) throw new RangeError(localize('document.output.tooLarge', 'Document output exceeds 64 MiB.'));
				pages.push({ width: pageWidth * 0.75, height: pageHeight * 0.75, bytes, pixelWidth: canvas.width, pixelHeight: canvas.height });
			} finally { canvas.width = canvas.height = 0; }
			top = Math.max(top + 1, bottom);
		} while (top < height);
		signal.throwIfAborted();
		return createImagePdf(pages);
	} finally { frame.remove(); }
}
