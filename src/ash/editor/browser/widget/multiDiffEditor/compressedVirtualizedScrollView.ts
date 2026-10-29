import { addDisposableListener } from '../../../../base/browser/dom.js';
import { FastDomNode } from '../../../../base/browser/fastDomNode.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Disposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { mapScrollAnchor, type ICompressedVirtualizedItemRange } from './compressedVirtualizedScrollLayout.js';
import { VirtualizedItemManager } from './virtualizedItemManager.js';

const MAX_SCROLL_HEIGHT = 8_000_000;

export interface IVisibleItemRange {
	readonly start: number;
	readonly end: number;
}

/** Owns the continuous scroll surface and mounts only file templates near its viewport. */
export class CompressedVirtualizedScrollView<TItem extends IDisposable & { readonly domNode: HTMLElement; }> extends Disposable {
	public readonly domNode: HTMLDivElement;
	public readonly contentDomNode: HTMLDivElement;
	public readonly sections: VirtualizedItemManager<TItem>;
	private readonly scrollable: ScrollableElement;
	private readonly contentNode: FastDomNode<HTMLDivElement>;
	private previousRanges: readonly ICompressedVirtualizedItemRange[] = [];
	private logicalContentHeight = 0;
	private physicalContentHeight = 0;
	private viewportHeight = 0;

	constructor(
		container: HTMLElement,
		createItem: (contentDomNode: HTMLDivElement, index: number) => TItem,
		releaseItem: (index: number, item: TItem) => void,
	) {
		super();
		this.scrollable = this._register(new ScrollableElement(container, { tabIndex: -1 }));
		this.scrollable.element.classList.add('stanza-multi-diff-editor-scrollbar');
		this.domNode = this.scrollable.scrollableElement;
		this.domNode.classList.add('stanza-multi-diff-editor');
		this.contentDomNode = this.scrollable.contentElement;
		this.contentNode = new FastDomNode(this.contentDomNode);
		this.contentDomNode.classList.add('stanza-multi-diff-editor-content');
		this.sections = this._register(new VirtualizedItemManager(
			this.contentDomNode,
			index => createItem(this.contentDomNode, index),
			releaseItem,
		));
		this._register(addDisposableListener(this.domNode, 'wheel', event => this.handleWheel(event), { capture: true, passive: false }));
	}

	public resetItems(): void {
		this.sections.setVisibleRange(0, 0);
		this.previousRanges = [];
	}

	public get isCompressed(): boolean {
		return this.logicalContentHeight > this.physicalContentHeight;
	}

	public getLogicalScrollTop(): number {
		if (!this.isCompressed) return this.domNode.scrollTop;
		const physicalMax = Math.max(0, this.physicalContentHeight - this.viewportHeight);
		const logicalMax = Math.max(0, this.logicalContentHeight - this.viewportHeight);
		return physicalMax > 0 ? this.domNode.scrollTop / physicalMax * logicalMax : 0;
	}

	public setLogicalScrollTop(scrollTop: number): void {
		const logicalMax = Math.max(0, this.logicalContentHeight - this.viewportHeight);
		const target = Math.max(0, Math.min(logicalMax, scrollTop));
		if (!this.isCompressed) {
			this.domNode.scrollTop = target;
			return;
		}
		const physicalMax = Math.max(0, this.physicalContentHeight - this.viewportHeight);
		this.domNode.scrollTop = logicalMax > 0 ? target / logicalMax * physicalMax : 0;
	}

	public setLayout(ranges: readonly ICompressedVirtualizedItemRange[], contentHeight: number, viewportHeight: number): void {
		const previousScrollTop = this.getLogicalScrollTop();
		this.logicalContentHeight = contentHeight;
		this.physicalContentHeight = Math.min(contentHeight, MAX_SCROLL_HEIGHT);
		this.viewportHeight = viewportHeight;
		this.contentNode.setHeight(this.physicalContentHeight);
		let mappedScrollTop = previousScrollTop;
		if (this.previousRanges.length === ranges.length && ranges.length > 0) {
			mappedScrollTop = mapScrollAnchor(this.previousRanges, ranges, previousScrollTop);
		}
		this.setLogicalScrollTop(mappedScrollTop);
		this.previousRanges = ranges.slice();
		this.scrollable.layout();
	}

	public project(overscan: number): IVisibleItemRange {
		const viewportTop = this.getLogicalScrollTop();
		const viewportBottom = viewportTop + this.viewportHeight;
		let start = 0;
		let end = this.previousRanges.length;
		while (start < end) {
			const middle = (start + end) >>> 1;
			const range = this.previousRanges[middle]!;
			if (range.top + range.height < viewportTop - overscan) start = middle + 1;
			else end = middle;
		}
		end = start;
		while (end < this.previousRanges.length && this.previousRanges[end]!.top <= viewportBottom + overscan) end++;
		this.sections.setVisibleRange(start, end);
		return { start, end };
	}

	/** Maps a visible logical file segment into the bounded browser scroll surface. */
	public renderedRange(range: ICompressedVirtualizedItemRange, overscan: number): ICompressedVirtualizedItemRange {
		if (!this.isCompressed) return range;
		const logicalTop = this.getLogicalScrollTop();
		const start = Math.max(range.top, logicalTop - overscan);
		const end = Math.min(range.top + range.height, logicalTop + this.viewportHeight + overscan);
		return { top: this.domNode.scrollTop + start - logicalTop, height: Math.max(0, end - start) };
	}

	private handleWheel(event: WheelEvent): void {
		if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
		// The outer viewport owns vertical gestures even over a child editor. Logical pixels also avoid amplifying compressed scrolling.
		const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 20
			: event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.viewportHeight : 1;
		const previous = this.getLogicalScrollTop();
		this.setLogicalScrollTop(previous + event.deltaY * unit);
		event.preventDefault();
		event.stopPropagation();
	}
}
