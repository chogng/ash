import { Disposable, type IDisposable } from '../../../../base/common/lifecycle.js';

/** Owns only the file templates intersecting the current viewport. */
export class VirtualizedItemManager<TItem extends IDisposable & { readonly domNode: HTMLElement }> extends Disposable {
	private readonly visible = new Map<number, TItem>();

	constructor(
		private readonly container: HTMLElement,
		private readonly createItem: (index: number) => TItem,
		private readonly releaseItem: (index: number, item: TItem) => void,
	) {
		super();
	}

	public get(index: number): TItem | undefined {
		return this.visible.get(index);
	}

	public values(): IterableIterator<TItem> {
		return this.visible.values();
	}

	public entries(): IterableIterator<[number, TItem]> {
		return this.visible.entries();
	}

	public setVisibleRange(start: number, end: number): void {
		for (const [index, item] of this.visible) {
			if (index >= start && index < end) continue;
			this.releaseItem(index, item);
			item.dispose();
			this.visible.delete(index);
		}
		for (let index = start; index < end; index++) {
			if (!this.visible.has(index)) this.visible.set(index, this.createItem(index));
		}
		// Keep keyboard navigation in file order when scrolling back toward earlier items.
		let next: HTMLElement | null = null;
		for (let index = end - 1; index >= start; index--) {
			const node = this.visible.get(index)!.domNode;
			if (node.nextSibling !== next) this.container.insertBefore(node, next);
			next = node;
		}
	}

	public override dispose(): void {
		this.setVisibleRange(0, 0);
		super.dispose();
	}
}
