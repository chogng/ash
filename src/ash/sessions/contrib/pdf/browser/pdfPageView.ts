import { addDisposableListener, getWindow, h, runWhenWindowIdle, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { PdfPage } from '../../../../platform/pdf/common/pdfService.js';

/** Owns one page's raster and selectable text in both reading modes. */
export class PdfPageView extends Disposable {
	/** Hosts may place, size and listen to this stable root; its content belongs to the page. */
	public readonly domNode: HTMLElement;
	private readonly raster = this._register(new MutableDisposable<IDisposable>());
	private readonly decoding = this._register(new MutableDisposable<IDisposable>());
	private readonly textLifetime = this._register(new MutableDisposable<DisposableStore>());
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeText = this.changed.event;
	private textLayer: HTMLElement | undefined;
	private snapshot: PdfPage | undefined;
	private generation = 0;
	public dimension = 1600;
	public get page(): PdfPage | undefined { return this.snapshot; }
	public get hasText(): boolean { return this.textLayer !== undefined; }

	constructor(document: Document, handlers: {
		pointerDown(event: PointerEvent): void;
		pointerMove(event: PointerEvent): void;
		pointerUp(event: PointerEvent): void;
		pointerCancel(): void;
	}) {
		super();
		this.domNode = h(document, 'div', { className: 'ash-sessions-pdf-stage' });
		this._register(addDisposableListener(this.domNode, 'pointerdown', handlers.pointerDown));
		this._register(addDisposableListener(this.domNode, 'pointermove', handlers.pointerMove));
		this._register(addDisposableListener(this.domNode, 'pointerup', handlers.pointerUp));
		this._register(addDisposableListener(this.domNode, 'pointercancel', handlers.pointerCancel));
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public setSize(width: number, height: number): void {
		this.domNode.style.width = `${width}px`;
		this.domNode.style.height = `${height}px`;
		if (this.textLayer && this.snapshot) { this.textLayer.style.transform = `scale(${width / this.snapshot.width})`; }
	}

	public clear(): void {
		this.generation++;
		this.decoding.clear(); this.textLifetime.clear(); this.raster.clear();
		this.textLayer = undefined; this.snapshot = undefined;
		this.domNode.replaceChildren();
	}

	public async render(page: PdfPage, bytes: Uint8Array, dimension: number, signal?: AbortSignal, deferText = false): Promise<void> {
		const generation = ++this.generation;
		const data = bytes.buffer instanceof ArrayBuffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes.slice();
		const url = URL.createObjectURL(new Blob([data], { type: 'image/png' }));
		const image = h(this.domNode.ownerDocument, 'img', { properties: { src: url, draggable: false }, attributes: { alt: '', 'aria-hidden': 'true' } });
		const raster = toDisposable(() => { image.removeAttribute('src'); URL.revokeObjectURL(url); });
		this.decoding.value = raster;
		try {
			// Removing the source can leave Chromium's decode pending. Eviction must release the render queue.
			const decoded = image.decode();
			await (signal ? raceCancellationError(decoded, signal) : decoded);
		} catch (error) {
			raster.dispose();
			if (signal?.aborted || this.isDisposed || generation !== this.generation) { return; }
			throw error;
		} finally {
			if (this.decoding.value === raster) { this.decoding.clearAndLeak(); }
		}
		if (signal?.aborted || this.isDisposed || generation !== this.generation) { raster.dispose(); return; }
		const previous = this.domNode.querySelector(':scope > img');
		if (previous && this.snapshot?.page === page.page && this.snapshot.revision === page.revision && dimension > this.dimension) {
			// Sharpening a page preserves its text selection and annotation controls.
			previous.replaceWith(image);
			this.raster.value = raster;
			this.dimension = dimension;
			return;
		}
		this.textLifetime.clear();
		this.textLayer = undefined;
		this.snapshot = page;
		this.dimension = dimension;
		this.domNode.dataset.pageNumber = String(page.page);
		this.domNode.replaceChildren(image);
		this.raster.value = raster;
		if (!deferText) { this.ensureTextLayer(); }
	}

	/** Offscreen prefetch can decode the raster before allocating selectable glyphs. */
	public ensureTextLayer(): void {
		const page = this.snapshot;
		if (!page?.characters.length || this.textLifetime.value) { return; }
		const store = new DisposableStore();
		this.textLifetime.value = store;
		const document = this.domNode.ownerDocument;
		const window = getWindow(this.domNode);
		const text = h(document, 'div', { className: 'ash-sessions-pdf-text' });
		const selection = h(document, 'div', { className: 'ash-sessions-pdf-text-content' });
		selection.style.width = `${page.width}px`;
		selection.style.height = `${page.height}px`;
		text.append(selection);
		const pending = store.add(new MutableDisposable<IDisposable>());
		let index = 0;
		const build = (idle: IdleDeadline): void => {
			const stop = window.performance.now() + (idle.didTimeout ? 4 : Math.min(4, idle.timeRemaining()));
			do {
				const character = page.characters[index++];
				const span = document.createElement('span');
				span.textContent = character.text;
				span.style.left = `${character.bounds.x * 100}%`;
				span.style.top = `${character.bounds.y * 100}%`;
				span.style.width = `${character.bounds.width * 100}%`;
				span.style.height = `${character.bounds.height * 100}%`;
				span.style.fontSize = `${character.bounds.height * page.height}px`;
				selection.append(span);
			} while (index < page.characters.length && window.performance.now() < stop);
			if (index < page.characters.length) { pending.value = runWhenWindowIdle(window, build, 100); return; }
			pending.clear();
			selection.style.transform = `scale(${parseFloat(this.domNode.style.width) / page.width})`;
			this.textLayer = selection;
			this.domNode.querySelector(':scope > img')?.after(text);
			this.changed.fire();
		};
		pending.value = scheduleAtNextAnimationFrame(window, () => { pending.value = runWhenWindowIdle(window, build, 100); });
	}
}
