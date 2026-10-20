import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw';
import { throwIfCancelled } from "../../../src/ash/base/common/cancellation.js";
import type { IDisposable } from "../../../src/ash/base/common/lifecycle.js";
import { h } from "../../../src/ash/base/browser/dom.js";

/** One rendered PDF page surface with its DOM anchor for annotation overlays. */
export interface PdfRenderedPage {
	readonly pageNumber: number;
	readonly element: HTMLDivElement;
	readonly width: number;
	readonly height: number;
}

/** Releasable page rendering owned by one PDF editor input. */
export interface IPdfRenderResult extends IDisposable {
	readonly pages: readonly PdfRenderedPage[];
	readonly pageCount: number;
	readonly text?: string;
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

/** PDF.js-backed renderer with a separate worker and HiDPI canvas output. */
export class PdfJsRenderer implements IPdfRenderer {
	async render(request: PdfRenderRequest): Promise<IPdfRenderResult> {
		throwIfCancelled(request.signal, "PDF rendering was cancelled");
		const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
		GlobalWorkerOptions.workerSrc = workerUrl;
		const loadingTask = getDocument({ data: request.bytes.slice(), useWasm: false });
		let destroying = false;
		const destroy = () => {
			if (destroying) return;
			destroying = true;
			void loadingTask.destroy().catch(() => undefined).finally(() => URL.revokeObjectURL(workerUrl));
		};
		const cancel = () => { destroy(); };
		request.signal.addEventListener("abort", cancel, { once: true });
		try {
			const document = await loadingTask.promise;
			throwIfCancelled(request.signal, "PDF rendering was cancelled");
			const pages: PdfRenderedPage[] = [];
			const texts: string[] = [];
			for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
				throwIfCancelled(request.signal, "PDF rendering was cancelled");
				const page = await document.getPage(pageNumber);
				const text = await page.getTextContent();
				throwIfCancelled(request.signal, "PDF rendering was cancelled");
				texts.push(text.items.flatMap(item => 'str' in item ? [item.str + (item.hasEOL ? '\n' : ' ')] : []).join(''));
				const viewport = page.getViewport({ scale: request.scale });
				const element = h(request.container.ownerDocument, "div");
				element.className = "ash-pdf-page";
				element.dataset.pageNumber = String(pageNumber);
				element.style.width = `${viewport.width}px`;
				element.style.height = `${viewport.height}px`;
				const canvas = h(request.container.ownerDocument, "canvas");
				canvas.className = "ash-pdf-page-canvas";
				const pixelRatio = request.container.ownerDocument.defaultView?.devicePixelRatio ?? 1;
				canvas.width = Math.ceil(viewport.width * pixelRatio);
				canvas.height = Math.ceil(viewport.height * pixelRatio);
				canvas.style.width = `${viewport.width}px`;
				canvas.style.height = `${viewport.height}px`;
				const context = canvas.getContext("2d");
				if (!context) throw new Error("PDF rendering requires a 2D canvas context");
				element.append(canvas);
				request.container.append(element);
				await page.render({ canvas, canvasContext: context, viewport, transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0] }).promise;
				pages.push(Object.freeze({ pageNumber, element, width: viewport.width, height: viewport.height }));
			}
			return new PdfJsRenderResult(pages, destroy, texts.join('\n\n'));
		} catch (error) {
			destroy();
			throw error;
		} finally {
			request.signal.removeEventListener("abort", cancel);
		}
	}
}

class PdfJsRenderResult implements IPdfRenderResult {
	private disposed = false;
	private released = false;

	constructor(readonly pages: readonly PdfRenderedPage[], private readonly releaseDocument: () => void, readonly text: string) { }

	get pageCount(): number {
		return this.pages.length;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const page of this.pages) page.element.remove();
		this.freeze();
	}

	freeze(): void {
		if (this.released) return;
		this.released = true;
		this.releaseDocument();
	}

	[Symbol.dispose](): void {
		this.dispose();
	}
}
