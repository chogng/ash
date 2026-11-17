import { getWindow } from '../../../../base/browser/dom.js';
import { AnimationFrameScheduler } from '../../../../base/browser/scheduler.js';
import { ListView } from '../../../../base/browser/ui/list/listView.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { PdfPage } from '../../../../platform/pdf/common/pdfService.js';
import { localize } from '../../../../nls.js';
import { PdfPageView } from './pdfPageView.js';
import '../../../../base/browser/ui/list/list.css';

interface PageEntry {
	readonly view: PdfPageView;
	readonly controller: AbortController;
	readonly ready: Promise<PdfPageView>;
	mounted: boolean;
}

interface ContinuousOptions {
	createPage(): PdfPageView;
	loadPage(number: number, signal: AbortSignal): Promise<{ page: PdfPage; bytes: Uint8Array; }>;
	isActive(view: PdfPageView): boolean;
	onDidChangePage(view: PdfPageView): void;
	onError(error: unknown): void;
}

/** PDF geometry and raster loading over the shared virtual list and its scroll owner. */
export class PdfContinuousView extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly list: ListView<number>;
	private readonly entries = new Map<number, PageEntry>();
	private readonly rows = new WeakMap<HTMLElement, PageEntry>();
	private readonly dimensions = new Map<number, { width: number; height: number; }>();
	private readonly numbers: readonly number[];
	private readonly notify: AnimationFrameScheduler;
	private zoom: 'page' | 'width' | number = 'page';
	private width = 0;
	private height = 0;
	private documentWidth = 0;
	private notifiedPage = 0;
	private notifiedTop = -1;
	private revealing: number | undefined;
	private readonly inset: number;
	/** The shared list permits native viewport integration for zoom anchoring and keyboard focus. */
	public get viewport(): HTMLElement { return this.list.scrollElement; }

	constructor(private readonly container: HTMLElement, private readonly first: PdfPage, private readonly options: ContinuousOptions) {
		super();
		this.inset = parseFloat(getWindow(container).getComputedStyle(container).getPropertyValue('--ash-spacing-size120')) || 12;
		this.numbers = Array.from({ length: first.pageCount }, (_, index) => index + 1);
		this.dimensions.set(first.page, { width: first.widthPoints * 96 / 72, height: first.heightPoints * 96 / 72 });
		this.list = this._register(new ListView(container, {
			scrolling: 'managed', horizontalScrolling: true, smoothScrolling: true,
			ariaLabel: localize('sessions.pdfPreview.document', 'PDF document'),
			getId: number => String(number), getHeight: number => this.size(number).height + this.inset * 2,
			role: 'rowgroup', accessibilityProvider: { getRole: () => 'presentation' },
			renderItem: (number, _index, row) => {
				row.classList.add('ash-sessions-pdf-page-row');
				const entry = this.entries.get(number) ?? this.createEntry(number);
				entry.mounted = true;
				this.rows.set(row, entry);
				return entry.view.domNode;
			},
			onDidRemoveRow: row => {
				const entry = this.rows.get(row);
				if (entry) { entry.mounted = false; }
				this.releaseInvisiblePages();
			},
		}));
		this.domNode = this.list.domNode;
		this.domNode.classList.add('ash-sessions-pdf-page', 'ash-sessions-pdf-continuous');
		this.domNode.tabIndex = 0;
		this.list.element.setAttribute('role', 'document');
		this.notify = this._register(new AnimationFrameScheduler(getWindow(container), () => this.notifyCurrentPage()));
		this._register(this.list.onDidScroll(() => this.notify.schedule()));
		this._register(this.list.onDidRenderRows(() => this.notify.schedule()));
		this._register(toDisposable(() => {
			for (const entry of this.entries.values()) { entry.controller.abort(); entry.view.dispose(); }
			this.entries.clear();
		}));
	}

	private createEntry(number: number): PageEntry {
		const view = this.options.createPage();
		const controller = new AbortController();
		view.domNode.dataset.pageNumber = String(number);
		view.domNode.setAttribute('aria-label', localize('sessions.pdfPreview.page', 'Page {0} of {1}', number, this.first.pageCount));
		view.domNode.setAttribute('aria-busy', 'true');
		const size = this.size(number);
		view.setSize(size.width, size.height);
		const ready = this.options.loadPage(number, controller.signal).then(async ({ page, bytes }) => {
			controller.signal.throwIfAborted();
			await view.render(page, bytes, 1600, controller.signal);
			controller.signal.throwIfAborted();
			const previous = this.geometry(number);
			const geometry = { width: page.widthPoints * 96 / 72, height: page.heightPoints * 96 / 72 };
			this.dimensions.set(number, geometry);
			if (previous.width !== geometry.width || previous.height !== geometry.height) { this.layout(this.zoom); }
			view.domNode.setAttribute('aria-busy', 'false');
			this.notify.schedule();
			return view;
		});
		void ready.catch(error => { if (!controller.signal.aborted && !this.isDisposed) { this.options.onError(error); } });
		const entry = { view, controller, ready, mounted: true };
		this.entries.set(number, entry);
		return entry;
	}

	private geometry(number: number): { width: number; height: number; } {
		return this.dimensions.get(number) ?? { width: this.first.widthPoints * 96 / 72, height: this.first.heightPoints * 96 / 72 };
	}

	private size(number: number): { width: number; height: number; } {
		const page = this.geometry(number);
		let scale = this.zoom;
		if (scale === 'width') { scale = Math.max(1, this.width - this.inset * 2) / page.width; }
		else if (scale === 'page') { scale = Math.min(Math.max(1, this.width - this.inset * 2) / page.width, Math.max(1, this.height - this.inset * 2) / page.height); }
		return { width: page.width * scale, height: page.height * scale };
	}

	public layout(zoom: 'page' | 'width' | number, point?: { readonly x: number; readonly y: number; }): void {
		const initialized = this.width > 0 && this.height > 0;
		const viewport = this.viewport;
		const bounds = viewport.getBoundingClientRect();
		const x = point ? point.x - bounds.left : viewport.clientWidth / 2;
		const y = point ? point.y - bounds.top : 0;
		const index = Math.max(0, this.list.indexAt(this.list.scrollTop + y));
		const oldSize = this.size(index + 1);
		const fractionY = (this.list.scrollTop + y - this.list.getElementTop(index) - this.inset) / oldSize.height;
		const fractionX = (viewport.scrollLeft + x - (this.documentWidth - oldSize.width) / 2) / oldSize.width;
		this.zoom = zoom;
		this.width = this.container.clientWidth;
		this.height = this.container.clientHeight;
		this.documentWidth = Math.max(this.width, ...Array.from(this.dimensions.keys(), number => this.size(number).width + this.inset * 2));
		this.list.element.style.width = `${this.documentWidth}px`;
		this.list.layout(this.height);
		this.list.items = this.numbers;
		for (const [number, entry] of this.entries) {
			const size = this.size(number);
			entry.view.setSize(size.width, size.height);
		}
		const size = this.size(index + 1);
		if (initialized) {
			this.scrollTo((this.documentWidth - size.width) / 2 + fractionX * size.width - x,
				this.list.getElementTop(index) + this.inset + fractionY * size.height - y);
		} else { this.scrollTo(0, 0); }
		this.notify.schedule();
	}

	public async reveal(number: number): Promise<PdfPageView> {
		this.revealing = number;
		try {
			this.list.reveal(number - 1, 0);
			const entry = this.entries.get(number);
			if (!entry) { throw new Error('PDF page is outside the reading viewport'); }
			const view = await entry.ready;
			if (this.revealing === number) { this.list.reveal(number - 1, 0); }
			return view;
		} finally {
			if (this.revealing === number) { this.revealing = undefined; }
		}
	}

	public scrollTo(left: number, top: number): void {
		this.list.scrollTop = top;
		this.viewport.scrollLeft = Math.max(0, left);
	}

	public releaseInvisiblePages(): void {
		for (const [number, entry] of this.entries) {
			// A pending jump survives reflow; an active page retains its text box or drawing.
			if (entry.mounted || number === this.revealing || this.options.isActive(entry.view)) { continue; }
			entry.controller.abort(); entry.view.dispose(); this.entries.delete(number);
		}
	}

	public invalidateOtherPages(active: PdfPageView): void {
		for (const [number, entry] of [...this.entries]) {
			if (entry.view === active) { continue; }
			entry.controller.abort(); entry.view.dispose(); this.entries.delete(number);
			this.list.rerender(number - 1);
		}
	}

	private notifyCurrentPage(): void {
		const index = this.list.indexAt(this.list.scrollTop + this.list.renderHeight * 0.35);
		const view = this.entries.get(index + 1)?.view;
		if (!view?.page || (index + 1 === this.notifiedPage && this.list.scrollTop === this.notifiedTop)) { return; }
		this.notifiedPage = index + 1;
		this.notifiedTop = this.list.scrollTop;
		this.options.onDidChangePage(view);
	}
}
