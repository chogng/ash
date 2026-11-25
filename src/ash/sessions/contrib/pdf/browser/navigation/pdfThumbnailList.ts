import { addDisposableListener, getWindow, h } from '../../../../../base/browser/dom.js';
import { observeElementSize } from '../../../../../base/browser/observer.js';
import { AnimationFrameScheduler } from '../../../../../base/browser/scheduler.js';
import { List } from '../../../../../base/browser/ui/list/listWidget.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { defaultListStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import type { PdfDocumentModel } from '../pdfDocumentModel.js';
import type { PdfThumbnail } from '../pdfPageView.js';
import './media/pdfThumbnailList.css';

interface ThumbnailRow {
	readonly page: number;
	readonly image: HTMLImageElement;
	readonly label: HTMLElement;
	readonly request: AbortController;
	requested: boolean;
	thumbnail?: PdfThumbnail;
	url?: string;
}

const maximumRowHeight = 184;

/** Projects a single PDF's page navigation into a virtual list with bounded raster loading. */
export class PdfThumbnailList extends Disposable {
	private readonly domNode: HTMLElement;
	private readonly list: List<number>;
	private readonly rows = new Map<HTMLElement, ThumbnailRow>();
	private readonly imageSizes = new Map<number, { width: number; height: number; }>();
	private rowMetrics: { width: number; chromeHeight: number; borderWidth: number; borderHeight: number; } | undefined;
	private readonly load: AnimationFrameScheduler;
	private readonly reflow: AnimationFrameScheduler;
	private loading = false;
	private paused = false;
	private reportedFailure = false;

	constructor(
		container: HTMLElement,
		panel: { readonly id: string; readonly tabId: string; },
		private readonly render: PdfDocumentModel['renderThumbnail'],
		openPage: (page: number) => void,
		private readonly reportError: (message: string) => void,
	) {
		super();
		this.list = this._register(new List<number>(container, {
			ariaLabel: localize('sessions.pdfPreview.thumbnails', 'Page thumbnails'),
			scrolling: 'managed',
			styles: defaultListStyles,
			domFocusable: true,
			keyboardNavigation: true,
			loopNavigation: false,
			focusOnMouseMove: false,
			getId: page => String(page),
			getHeight: page => this.rowHeight(page),
			accessibilityProvider: { getAriaLabel: page => localize('sessions.pdfPreview.thumbnailPage', 'Page {0}', page) },
			renderItem: (page, _, row) => this.renderRow(page, row),
			onDidRemoveRow: row => this.releaseRow(row),
		}));
		this.domNode = this.list.domNode;
		this.domNode.classList.add('ash-sessions-pdf-thumbnails');
		this.domNode.id = panel.id;
		this.domNode.hidden = true;
		this.domNode.setAttribute('role', 'tabpanel');
		this.domNode.setAttribute('aria-labelledby', panel.tabId);
		this.load = this._register(new AnimationFrameScheduler(getWindow(this.domNode), () => this.loadNext()));
		this.reflow = this._register(new AnimationFrameScheduler(getWindow(this.domNode), () => this.reflowRows()));
		this._register(observeElementSize(this.domNode, () => this.reflow.schedule()));
		this._register(this.list.onDidRenderRows(() => this.load.schedule()));
		this._register(this.list.onDidAccept(({ item }) => openPage(item)));
		// In a single-selection navigation list, moving with the keyboard selects the page.
		this._register(this.list.onDidChangeSelection(({ items, browserEvent }) => {
			if (browserEvent?.type === 'keydown' && items.length) { openPage(items[0]); }
		}));
		this._register(addDisposableListener(this.list.element, 'keydown', event => {
			if (event.isComposing || (event.key !== 'Enter' && event.key !== ' ')) { return; }
			this.list.acceptActive(event);
			event.preventDefault();
			event.stopPropagation();
		}));
		this._register(toDisposable(() => {
			for (const row of this.rows.keys()) { this.releaseRow(row); }
		}));
	}

	setVisible(visible: boolean): void {
		this.domNode.hidden = !visible;
		if (!visible) {
			this.reportedFailure = false;
			this.imageSizes.clear();
			this.rowMetrics = undefined;
			if (this.list.items.length) { this.list.items = []; }
		}
	}

	setPage(page: number, pageCount: number): void {
		if (this.domNode.hidden) { return; }
		if (this.list.items.length !== pageCount) {
			this.list.items = Array.from({ length: pageCount }, (_, index) => index + 1);
		}
		if (this.list.selection[0] === page) { return; }
		const index = page - 1;
		this.list.setSelection([index]);
		this.list.setActiveIndex(index, undefined, { reveal: false });
		this.list.reveal(index);
	}

	setPaused(paused: boolean): void {
		if (this.paused === paused) { return; }
		this.paused = paused;
		if (!paused) { this.load.schedule(); }
	}

	getThumbnail(page: number): PdfThumbnail | undefined {
		const row = this.list.row(page - 1);
		const thumbnail = row && this.rows.get(row)?.thumbnail;
		return thumbnail?.image.complete && thumbnail.image.naturalWidth ? thumbnail : undefined;
	}

	refresh(): void {
		for (const { page } of [...this.rows.values()]) { this.list.rerender(page - 1); }
	}

	private renderRow(page: number, row: HTMLElement): DocumentFragment {
		const document = row.ownerDocument;
		const image = h(document, 'img', { properties: { alt: '', draggable: false }, attributes: { 'aria-hidden': 'true' } });
		const label = h(document, 'span', { className: 'ash-sessions-pdf-thumbnail-number' }, String(page));
		this.rows.set(row, { page, image, label, request: new AbortController(), requested: false });
		const contents = document.createDocumentFragment();
		contents.append(image, label);
		return contents;
	}

	private rowHeight(page: number): number {
		const size = this.imageSizes.get(page);
		const metrics = this.rowMetrics;
		if (!size || !metrics) return maximumRowHeight;
		const width = Math.min(size.width, Math.max(0, metrics.width - metrics.borderWidth));
		return Math.min(maximumRowHeight, Math.ceil(width * size.height / size.width + metrics.chromeHeight + metrics.borderHeight));
	}

	private reflowRows(): void {
		const sample = this.rows.entries().next().value;
		if (!sample || !this.domNode.clientWidth) return;
		const [row, { image, label }] = sample;
		const window = getWindow(row);
		const rowStyle = window.getComputedStyle(row);
		const imageStyle = window.getComputedStyle(image);
		this.rowMetrics = {
			width: row.clientWidth - parseFloat(rowStyle.paddingLeft) - parseFloat(rowStyle.paddingRight),
			chromeHeight: parseFloat(rowStyle.paddingTop) + parseFloat(rowStyle.paddingBottom) + parseFloat(rowStyle.rowGap) + parseFloat(window.getComputedStyle(label).lineHeight),
			borderWidth: parseFloat(imageStyle.borderLeftWidth) + parseFloat(imageStyle.borderRightWidth),
			borderHeight: parseFloat(imageStyle.borderTopWidth) + parseFloat(imageStyle.borderBottomWidth),
		};
		this.list.updateElementHeights();
	}

	private releaseRow(row: HTMLElement): void {
		const entry = this.rows.get(row);
		if (!entry) { return; }
		entry.request.abort();
		if (entry.url) { URL.revokeObjectURL(entry.url); }
		this.rows.delete(row);
	}

	private async loadNext(): Promise<void> {
		if (this.paused || this.loading || this.domNode.hidden || this.domNode.clientHeight === 0) { return; }
		const entry = Array.from(this.rows.values()).find(row => !row.requested);
		if (!entry) { return; }
		entry.requested = true;
		this.loading = true;
		const { signal } = entry.request;
		try {
			const { bytes, width, height, widthPoints, heightPoints } = await this.render(entry.page, signal);
			if (signal.aborted) { return; }
			entry.url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
			entry.image.src = entry.url;
			entry.thumbnail = { image: entry.image, widthPoints, heightPoints };
			const previousSize = this.imageSizes.get(entry.page);
			if (previousSize?.width !== width || previousSize.height !== height) {
				this.imageSizes.set(entry.page, { width, height });
				this.reflow.schedule();
			}
		} catch (error) {
			// Rows remain navigable. Report once per sidebar visit so a failed PDF cannot flood the window.
			if (!signal.aborted && !this.reportedFailure && !isCancellationError(error)) {
				this.reportedFailure = true;
				this.reportError(localize('sessions.pdfPreview.thumbnailsFailed', 'Could not load PDF thumbnails: {0}', error instanceof Error ? error.message : String(error)));
			}
		} finally {
			this.loading = false;
			if (!this.isDisposed) { this.load.schedule(); }
		}
	}
}
