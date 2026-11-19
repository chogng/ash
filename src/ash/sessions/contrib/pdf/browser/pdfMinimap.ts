import { addDisposableListener, getWindow, h } from '../../../../base/browser/dom.js';
import { AnimationFrameScheduler } from '../../../../base/browser/scheduler.js';
import { List } from '../../../../base/browser/ui/list/listWidget.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { defaultListStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import './media/pdfMinimap.css';

interface ThumbnailRow {
	readonly page: number;
	readonly image: HTMLImageElement;
	readonly request: AbortController;
	requested: boolean;
	url?: string;
}

/** Projects a single PDF's page navigation into a virtual list with bounded raster loading. */
export class PdfMinimap extends Disposable {
	readonly domNode: HTMLElement;
	private readonly list: List<number>;
	private readonly rows = new Map<HTMLElement, ThumbnailRow>();
	private readonly load: AnimationFrameScheduler;
	private loading = false;
	private paused = false;

	constructor(
		document: Document,
		private readonly render: (page: number, signal: AbortSignal) => Promise<Uint8Array>,
		openPage: (page: number) => void,
	) {
		super();
		this.domNode = h(document, 'div', {
			className: 'ash-sessions-pdf-thumbnails',
			properties: { hidden: true },
		});
		this.load = this._register(new AnimationFrameScheduler(getWindow(this.domNode), () => this.loadNext()));
		this.list = this._register(new List<number>(this.domNode, {
			ariaLabel: localize('sessions.pdfPreview.thumbnails', 'Page thumbnails'),
			scrolling: 'managed',
			styles: defaultListStyles,
			domFocusable: true,
			keyboardNavigation: true,
			loopNavigation: false,
			focusOnMouseMove: false,
			getId: page => String(page),
			getHeight: () => 152,
			accessibilityProvider: { getAriaLabel: page => localize('sessions.pdfPreview.thumbnailPage', 'Page {0}', page) },
			renderItem: (page, _, row) => this.renderRow(page, row),
			onDidRemoveRow: row => this.releaseRow(row),
		}));
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
		if (!visible && this.list.items.length) { this.list.items = []; }
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

	refresh(): void {
		for (const { page } of [...this.rows.values()]) { this.list.rerender(page - 1); }
	}

	private renderRow(page: number, row: HTMLElement): HTMLElement {
		const document = row.ownerDocument;
		const image = h(document, 'img', { properties: { alt: '', draggable: false }, attributes: { 'aria-hidden': 'true' } });
		this.rows.set(row, { page, image, request: new AbortController(), requested: false });
		return h(document, 'div', { className: 'ash-sessions-pdf-thumbnail' },
			h(document, 'div', { className: 'ash-sessions-pdf-thumbnail-image' }, image),
			h(document, 'span', { className: 'ash-sessions-pdf-thumbnail-number' }, String(page)),
		);
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
		try {
			const { signal } = entry.request;
			const bytes = await this.render(entry.page, signal);
			if (signal.aborted) { return; }
			entry.url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
			entry.image.src = entry.url;
		} catch {
			// The numbered row still navigates when its preview cannot be rendered.
		} finally {
			this.loading = false;
			if (!this.isDisposed) { this.load.schedule(); }
		}
	}
}
