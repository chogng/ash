import { getWindow } from '../../../../base/browser/dom.js';
import { AnimationFrameScheduler } from '../../../../base/browser/scheduler.js';
import { ListView } from '../../../../base/browser/ui/list/listView.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { PdfPage } from '../../../../platform/pdf/common/pdfService.js';
import { localize } from '../../../../nls.js';
import { PdfPageView } from './pdfPageView.js';
import '../../../../base/browser/ui/list/list.css';

interface PageEntry {
	readonly number: number;
	readonly view: PdfPageView;
	readonly controller: AbortController;
	ready?: Promise<PdfPageView>;
	mounted: boolean;
}

interface ContinuousOptions {
	createPage(): PdfPageView;
	loadPage(number: number, signal: AbortSignal): Promise<{ page: PdfPage; bytes: Uint8Array; }>;
	isActive(view: PdfPageView): boolean;
	onDidChangePage(view: PdfPageView): void;
	onError(error: unknown): void;
}

type PageSize = { readonly width: number; readonly height: number; };
type PdfZoom = 'page' | 'width' | number;
const maxRetainedPages = 6;

/** PDF geometry and raster loading over the shared virtual list and its scroll owner. */
export class PdfContinuousView extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly list: ListView<number>;
	private readonly entries = new Map<number, PageEntry>();
	private readonly rows = new WeakMap<HTMLElement, PageEntry>();
	private readonly dimensions = new Map<number, PageSize>();
	private readonly defaultGeometry: PageSize;
	private defaultSize: PageSize;
	private readonly numbers: readonly number[];
	private readonly notify: AnimationFrameScheduler;
	private loading: PageEntry | undefined;
	private zoom: PdfZoom = 'page';
	private width = 0;
	private height = 0;
	private documentWidth = 0;
	private notifiedPage = 0;
	private notifiedTop = -1;
	private revealing: number | undefined;
	private revealedPage: { readonly number: number; readonly top: number; } | undefined;
	private readonly inset: number;
	public get viewport(): HTMLElement { return this.list.scrollElement; }

	constructor(private readonly container: HTMLElement, first: PdfPage, private readonly options: ContinuousOptions) {
		super();
		this.inset = parseFloat(getWindow(container).getComputedStyle(container).getPropertyValue('--ash-spacing-size120')) || 12;
		this.numbers = Array.from({ length: first.pageCount }, (_, index) => index + 1);
		this.defaultGeometry = { width: first.widthPoints * 96 / 72, height: first.heightPoints * 96 / 72 };
		this.defaultSize = this.defaultGeometry;
		this.list = this._register(new ListView(container, {
			scrolling: 'managed', horizontalScrolling: true, handleMouseWheel: false, overscanRows: 1,
			ariaLabel: localize('sessions.pdfPreview.document', 'PDF document'),
			getId: number => String(number), getHeight: number => this.size(number).height + this.inset * 2,
			role: 'rowgroup', accessibilityProvider: { getRole: () => 'presentation' },
			renderItem: (number, _index, row) => {
				row.classList.add('ash-sessions-pdf-page-row');
				const entry = this.entries.get(number) ?? this.createEntry(number);
				// Keep the map in mount order so a return scroll can reuse the most recent decoded pages.
				this.entries.delete(number);
				this.entries.set(number, entry);
				entry.mounted = true;
				this.rows.set(row, entry);
				const size = this.size(number);
				entry.view.setSize(size.width, size.height);
				return entry.view.domNode;
			},
			onDidRemoveRow: row => {
				const entry = this.rows.get(row);
				if (entry) { entry.mounted = false; }
				this.rows.delete(row);
			},
		}));
		this.domNode = this.list.domNode;
		this.domNode.classList.add('ash-sessions-pdf-page', 'ash-sessions-pdf-continuous');
		this.domNode.tabIndex = 0;
		this.list.element.setAttribute('role', 'document');
		this.notify = this._register(new AnimationFrameScheduler(getWindow(container), () => this.updateViewport()));
		this._register(this.list.onDidRenderRows(() => this.notify.schedule()));
		this._register(toDisposable(() => {
			for (const entry of this.entries.values()) { entry.controller.abort(); entry.view.dispose(); }
			this.entries.clear();
		}));
	}

	private createEntry(number: number): PageEntry {
		const view = this.options.createPage();
		view.domNode.dataset.pageNumber = String(number);
		view.domNode.setAttribute('aria-label', localize('sessions.pdfPreview.page', 'Page {0} of {1}', number, this.numbers.length));
		view.domNode.setAttribute('aria-busy', 'true');
		const entry = { number, view, controller: new AbortController(), mounted: true };
		return entry;
	}

	/** Schedule from the current viewport after each load. Fast scrolling can skip intermediate pages. */
	private updateViewport(): void {
		const top = this.list.scrollTop;
		const bottom = top + this.list.renderHeight;
		const first = this.list.indexAt(top) + 1;
		const last = this.list.indexAt(bottom) + 1;
		if (this.revealedPage?.top !== top) { this.revealedPage = undefined; }
		const atEnd = top > 0 && bottom >= this.list.getElementTop(this.numbers.length) - 1;
		const current = this.revealing ?? this.revealedPage?.number ??
			(atEnd ? last : this.list.indexAt(top + this.list.renderHeight * 0.35) + 1);
		this.notifyCurrentPage(current);
		let next: PageEntry | undefined;
		let bestDistance = Infinity;
		const retained: PageEntry[] = [];
		for (const [number, entry] of this.entries) {
			if (!entry.mounted) {
				if (number === this.revealing || this.options.isActive(entry.view)) { continue; }
				if (entry.view.page) { retained.push(entry); }
				else { this.disposeEntry(entry); }
				continue;
			}
			const visible = number >= first && number <= last;
			if (visible) { entry.view.ensureTextLayer(); }
			const distance = Math.abs(number - current) + (visible ? 0 : last - first + 1);
			if (!entry.ready && distance < bestDistance) {
				next = entry;
				bestDistance = distance;
			}
		}
		// Keep the same six-page offscreen budget across both nearby and distant reversals.
		for (let index = 0; index < retained.length - maxRetainedPages; index++) { this.disposeEntry(retained[index]); }
		if (next && !this.loading) {
			const entry = next;
			void this.load(entry).catch(error => {
				if (!entry.controller.signal.aborted) { this.options.onError(error); }
			});
		}
	}

	private disposeEntry(entry: PageEntry): void {
		entry.controller.abort();
		entry.view.dispose();
		this.entries.delete(entry.number);
	}

	private load(entry: PageEntry): Promise<PdfPageView> {
		if (entry.ready) { return entry.ready; }
		this.loading = entry;
		const { number, view, controller: { signal } } = entry;
		entry.ready = this.options.loadPage(number, signal).then(async ({ page, bytes }) => {
			signal.throwIfAborted();
			await view.render(page, bytes, 1600, signal, true);
			signal.throwIfAborted();
			const previous = this.dimensions.get(number) ?? this.defaultGeometry;
			const geometry = { width: page.widthPoints * 96 / 72, height: page.heightPoints * 96 / 72 };
			if (previous.width !== geometry.width || previous.height !== geometry.height) {
				this.layout(this.zoom, undefined, { number, geometry });
			}
			view.domNode.setAttribute('aria-busy', 'false');
			return view;
		}).finally(() => {
			if (this.loading === entry) { this.loading = undefined; }
			if (!this.isDisposed) { this.notify.schedule(); }
		});
		return entry.ready;
	}

	private size(number: number): PageSize {
		const geometry = this.dimensions.get(number);
		return geometry ? this.scaledSize(geometry) : this.defaultSize;
	}

	public scaleAt(clientY?: number): number {
		if (typeof this.zoom === 'number') { return this.zoom; }
		const y = clientY === undefined ? this.height / 2 : clientY - this.viewport.getBoundingClientRect().top;
		const number = this.list.indexAt(this.viewport.scrollTop + y) + 1;
		const geometry = this.dimensions.get(number) ?? this.defaultGeometry;
		return this.size(number).width / geometry.width;
	}

	private scaledSize(page: PageSize): PageSize {
		let scale = this.zoom;
		if (scale === 'width') { scale = Math.max(1, this.width - this.inset * 2) / page.width; }
		else if (scale === 'page') { scale = Math.min(Math.max(1, this.width - this.inset * 2) / page.width, Math.max(1, this.height - this.inset * 2) / page.height); }
		return { width: page.width * scale, height: page.height * scale };
	}

	public layout(zoom: PdfZoom, point?: { readonly x: number; readonly y: number; }, measured?: { number: number; geometry: PageSize; }): void {
		const width = this.container.clientWidth;
		const height = this.container.clientHeight;
		if (zoom === this.zoom && width === this.width && height === this.height && !measured) { return; }
		const viewport = this.viewport;
		const bounds = viewport.getBoundingClientRect();
		const x = point ? point.x - bounds.left : bounds.width / 2;
		const y = point ? point.y - bounds.top : 0;
		const index = Math.max(0, this.list.indexAt(viewport.scrollTop + y));
		const oldSize = this.size(index + 1);
		const fractionY = (viewport.scrollTop + y - this.list.getElementTop(index) - this.inset) / oldSize.height;
		const fractionX = (viewport.scrollLeft + x - (this.documentWidth - oldSize.width) / 2) / oldSize.width;
		const resize = this.height !== height;
		this.zoom = zoom;
		this.width = width;
		this.height = height;
		if (measured) { this.dimensions.set(measured.number, measured.geometry); }
		this.defaultSize = this.scaledSize(this.defaultGeometry);
		this.documentWidth = Math.max(width, this.defaultSize.width + this.inset * 2);
		for (const geometry of this.dimensions.values()) {
			this.documentWidth = Math.max(this.documentWidth, this.scaledSize(geometry).width + this.inset * 2);
		}
		this.list.element.style.width = `${this.documentWidth}px`;
		if (resize) { this.list.layout(height); }
		if (!this.list.items.length) {
			this.list.items = this.numbers;
			return;
		}
		for (const [number, entry] of this.entries) {
			if (entry.mounted) {
				const size = this.size(number);
				entry.view.setSize(size.width, size.height);
			}
		}
		const size = this.size(index + 1);
		this.list.updateElementHeights({
			index,
			offset: this.inset + fractionY * size.height - y,
			left: (this.documentWidth - size.width) / 2 + fractionX * size.width - x,
		});
	}

	public async reveal(number: number, top?: number, signal?: AbortSignal): Promise<PdfPageView> {
		signal?.throwIfAborted();
		this.revealing = number;
		try {
			this.list.reveal(number - 1, 0);
			const entry = this.entries.get(number);
			if (!entry) { throw new Error('PDF page is outside the reading viewport'); }
			const loading = this.loading;
			if (!entry.ready && loading && loading !== entry) {
				// The document serializes renders, so a stale prefetch would delay this jump.
				this.disposeEntry(loading);
				if (loading.mounted) { this.list.rerender(loading.number - 1); }
			}
			const ready = this.load(entry);
			const view = await (signal ? raceCancellationError(ready, signal) : ready);
			signal?.throwIfAborted();
			if (this.revealing === number) {
				if (top === undefined) {
					this.list.reveal(number - 1, 0);
				} else {
					this.list.scrollTop = this.list.getElementTop(number - 1) + this.inset + top * this.size(number).height;
				}
				// Short pages near the end cannot reach the viewport's usual current-page reference point.
				this.revealedPage = { number, top: this.list.scrollTop };
			}
			return view;
		} finally {
			if (this.revealing === number) { this.revealing = undefined; }
		}
	}

	public invalidateOtherPages(active: PdfPageView): void {
		for (const entry of [...this.entries.values()]) {
			if (entry.view === active) { continue; }
			this.disposeEntry(entry);
			this.list.rerender(entry.number - 1);
		}
		this.notify.schedule();
	}

	private notifyCurrentPage(number: number): void {
		const view = this.entries.get(number)?.view;
		if (!view?.page || (number === this.notifiedPage && this.list.scrollTop === this.notifiedTop)) { return; }
		this.notifiedPage = number;
		this.notifiedTop = this.list.scrollTop;
		this.options.onDidChangePage(view);
	}
}
