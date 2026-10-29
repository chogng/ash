import { getDocument, GlobalWorkerOptions, TextLayer, type PDFPageProxy } from 'pdfjs-dist';
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw';
import { throwIfCancelled } from '../../../src/ash/base/common/cancellation.js';
import type { IDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { addDisposableListener, h } from '../../../src/ash/base/browser/dom.js';

/** Text offsets refer to the page's extracted text, including line breaks between runs. */
export interface PdfTextRun {
	readonly start: number;
	readonly end: number;
	readonly element: HTMLElement;
}

/** One rendered PDF page surface with its DOM anchor for annotation overlays. */
export interface PdfRenderedPage {
	readonly pageNumber: number;
	readonly element: HTMLDivElement;
	readonly width: number;
	readonly height: number;
	readonly text: string;
	readonly textRuns: readonly PdfTextRun[];
}

/** Releasable page rendering owned by one PDF editor input. */
export interface IPdfRenderResult extends IDisposable {
	readonly pages: readonly PdfRenderedPage[];
	readonly pageCount: number;
	readonly text?: string;
	readonly scale: number;
	/** Reuse the parsed document and text nodes; annotations remain attached to their pages. */
	setScale(scale: number, signal: AbortSignal): Promise<void>;
	/** Release parser/worker resources while retaining the already painted pages. */
	freeze?(): void;
}

/** Renders immutable PDF bytes into page surfaces that can host annotation layers. */
export interface IPdfRenderer {
	render(request: PdfRenderRequest): Promise<IPdfRenderResult>;
}

export interface PdfRenderRequest {
	readonly bytes: Uint8Array;
	readonly container: HTMLElement;
	readonly scale: number;
	readonly signal: AbortSignal;
}

/** PDF.js-backed renderer with selectable text and bounded HiDPI canvas output. */
export class PdfJsRenderer implements IPdfRenderer {
	async render(request: PdfRenderRequest): Promise<IPdfRenderResult> {
		throwIfCancelled(request.signal, 'PDF rendering was cancelled');
		const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
		GlobalWorkerOptions.workerSrc = workerUrl;
		const loadingTask = getDocument({ data: request.bytes.slice(), useWasm: false });
		let destroying = false;
		const destroy = () => {
			if (destroying) return;
			destroying = true;
			void loadingTask
				.destroy()
				.catch(() => undefined)
				.finally(() => URL.revokeObjectURL(workerUrl));
		};
		const result = new PdfJsRenderResult(destroy, request.scale);
		const cancellation = addDisposableListener(request.signal, 'abort', () => result.freeze(), { once: true });
		try {
			const document = await loadingTask.promise;
			for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
				throwIfCancelled(request.signal, 'PDF rendering was cancelled');
				const page = await document.getPage(pageNumber);
				const text = await page.getTextContent();
				throwIfCancelled(request.signal, 'PDF rendering was cancelled');
				const view = new PdfPageView(page, request.container, request.scale);
				result.pages.push(view);
				await view.loadText(text, request.signal);
				await view.paint(request.signal);
			}
			throwIfCancelled(request.signal, 'PDF rendering was cancelled');
			return result;
		} catch (error) {
			result.dispose();
			throw error;
		} finally {
			cancellation.dispose();
		}
	}
}

class PdfPageView implements PdfRenderedPage {
	readonly pageNumber: number;
	readonly element: HTMLDivElement;
	readonly textRuns: PdfTextRun[] = [];
	text = '';
	private viewport: ReturnType<PDFPageProxy['getViewport']>;
	private readonly textContainer: HTMLDivElement;
	private textLayer: TextLayer | undefined;
	private canvas: HTMLCanvasElement;

	constructor(
		private page: PDFPageProxy | undefined,
		container: HTMLElement,
		scale: number,
	) {
		this.pageNumber = page!.pageNumber;
		this.viewport = page!.getViewport({ scale });
		this.element = h(container.ownerDocument, 'div');
		this.element.className = 'ash-pdf-page';
		this.element.dataset.pageNumber = String(this.pageNumber);
		this.canvas = h(container.ownerDocument, 'canvas');
		this.canvas.className = 'ash-pdf-page-canvas';
		this.canvas.setAttribute('aria-hidden', 'true');
		this.textContainer = h(container.ownerDocument, 'div');
		this.textContainer.className = 'ash-pdf-text-layer';
		this.element.append(this.canvas, this.textContainer);
		container.append(this.element);
		this.setScale(scale);
	}

	get width(): number {
		return this.viewport.width;
	}
	get height(): number {
		return this.viewport.height;
	}

	async loadText(content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>, signal: AbortSignal): Promise<void> {
		const layer = (this.textLayer = new TextLayer({
			textContentSource: content,
			container: this.textContainer,
			viewport: this.viewport,
		}));
		const cancellation = addDisposableListener(signal, 'abort', () => layer.cancel(), { once: true });
		try {
			await layer.render();
			throwIfCancelled(signal, 'PDF text loading was cancelled');
			let index = 0;
			for (const item of content.items) {
				if (!('str' in item)) continue;
				const start = this.text.length;
				this.text += item.str;
				this.textRuns.push({ start, end: this.text.length, element: layer.textDivs[index++] });
				if (item.hasEOL) this.text += '\n';
			}
		} finally {
			cancellation.dispose();
		}
	}

	setScale(scale: number): void {
		if (!this.page) return;
		this.viewport = this.page.getViewport({ scale });
		this.element.style.width = `${this.width}px`;
		this.element.style.height = `${this.height}px`;
		this.element.style.setProperty('--total-scale-factor', String(this.viewport.scale * this.viewport.userUnit));
		this.canvas.style.width = `${this.width}px`;
		this.canvas.style.height = `${this.height}px`;
		this.textLayer?.update({ viewport: this.viewport });
	}

	async paint(signal: AbortSignal): Promise<void> {
		throwIfCancelled(signal, 'PDF rendering was cancelled');
		if (!this.page) return;
		const canvas = h(this.element.ownerDocument, 'canvas');
		canvas.className = 'ash-pdf-page-canvas';
		canvas.setAttribute('aria-hidden', 'true');
		// Large pages and high zoom must not exceed browser canvas limits. CSS retains the requested size.
		const ratio = Math.min(this.element.ownerDocument.defaultView?.devicePixelRatio ?? 1, Math.sqrt(16_777_216 / (this.width * this.height)), 8192 / Math.max(this.width, this.height));
		canvas.width = Math.max(1, Math.floor(this.width * ratio));
		canvas.height = Math.max(1, Math.floor(this.height * ratio));
		canvas.style.width = `${this.width}px`;
		canvas.style.height = `${this.height}px`;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('PDF rendering requires a 2D canvas context');
		const task = this.page.render({
			canvas,
			canvasContext: context,
			viewport: this.viewport,
			transform: [ratio, 0, 0, ratio, 0, 0],
		});
		const cancellation = addDisposableListener(signal, 'abort', () => task.cancel(), { once: true });
		try {
			await task.promise;
			throwIfCancelled(signal, 'PDF rendering was cancelled');
			const previous = this.canvas;
			previous.replaceWith(canvas);
			this.canvas = canvas;
			previous.width = previous.height = 0;
		} finally {
			cancellation.dispose();
			if (this.canvas !== canvas) canvas.width = canvas.height = 0;
		}
	}

	release(): void {
		this.textLayer?.cancel();
		this.textLayer = undefined;
		this.page = undefined;
	}
}

class PdfJsRenderResult implements IPdfRenderResult {
	readonly pages: PdfPageView[] = [];
	private readonly lifetime = new AbortController();
	private disposed = false;

	constructor(
		private readonly releaseDocument: () => void,
		public scale: number,
	) {}

	get pageCount(): number {
		return this.pages.length;
	}
	get text(): string {
		return this.pages.map(page => page.text).join('\n\n');
	}

	async setScale(scale: number, signal: AbortSignal): Promise<void> {
		signal = AbortSignal.any([signal, this.lifetime.signal]);
		throwIfCancelled(signal, 'PDF rendering was cancelled');
		this.scale = scale;
		for (const page of this.pages) page.setScale(scale);
		for (const page of this.pages) await page.paint(signal);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.freeze();
		for (const page of this.pages) page.element.remove();
		this.pages.length = 0;
	}

	freeze(): void {
		if (this.lifetime.signal.aborted) return;
		this.lifetime.abort();
		for (const page of this.pages) page.release();
		this.releaseDocument();
	}

	[Symbol.dispose](): void {
		this.dispose();
	}
}
