import { throwIfCancelled } from "../../../../base/common/cancellation.js";
import type { IDisposable } from "../../../../base/common/lifecycle.js";
import { h } from "../../../../base/browser/dom.js";

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
		const [{ getDocument, GlobalWorkerOptions }, { default: workerUrl }] = await Promise.all([
			import("pdfjs-dist"),
			import("pdfjs-dist/build/pdf.worker.mjs?url"),
		]);
		throwIfCancelled(request.signal, "PDF rendering was cancelled");
		GlobalWorkerOptions.workerSrc = workerUrl;
		const loadingTask = getDocument({ data: request.bytes.slice() });
		const cancel = () => { void loadingTask.destroy(); };
		request.signal.addEventListener("abort", cancel, { once: true });
		try {
			const document = await loadingTask.promise;
			throwIfCancelled(request.signal, "PDF rendering was cancelled");
			const pages: PdfRenderedPage[] = [];
			for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
				throwIfCancelled(request.signal, "PDF rendering was cancelled");
				const page = await document.getPage(pageNumber);
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
			return new PdfJsRenderResult(pages, () => { void loadingTask.destroy(); });
		} catch (error) {
			void loadingTask.destroy();
			throw error;
		} finally {
			request.signal.removeEventListener("abort", cancel);
		}
	}
}

class PdfJsRenderResult implements IPdfRenderResult {
	private disposed = false;

	constructor(readonly pages: readonly PdfRenderedPage[], private readonly releaseDocument: () => void) {}

	get pageCount(): number {
		return this.pages.length;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const page of this.pages) page.element.remove();
		this.releaseDocument();
	}

	[Symbol.dispose](): void {
		this.dispose();
	}
}
