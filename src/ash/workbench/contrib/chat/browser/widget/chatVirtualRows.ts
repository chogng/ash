import { RangeMap } from '../../../../../base/browser/ui/list/rangeMap.js';
import type { IChatListItem } from '../../common/model/chatViewModel.js';

/** Geometry for the complete transcript, independent of which rows have DOM. */
export class ChatVirtualRows {
	private readonly geometry = new RangeMap();
	private readonly indices = new Map<string, number>();
	private readonly heights = new Map<string, number>();
	private items: readonly IChatListItem[] = [];
	private estimates: readonly number[] = [];

	get size(): number { return this.geometry.size; }

	get count(): number { return this.items.length; }

	itemAt(index: number): IChatListItem | undefined { return this.items[index]; }

	indexOf(id: string): number | undefined { return this.indices.get(id); }

	indexAt(top: number): number { return this.geometry.indexAt(Math.max(0, top)); }

	positionAt(index: number): number { return index === this.items.length ? this.size : this.geometry.positionAt(index); }

	setItems(items: readonly IChatListItem[]): void {
		if (this.items === items) return;
		this.items = items;
		this.estimates = items.map(estimateHeight);
		this.indices.clear();
		for (const [index, item] of items.entries()) this.indices.set(item.id, index);
		for (const id of this.heights.keys()) if (!this.indices.has(id)) this.heights.delete(id);
		this.rebuild();
	}

	measure(rows: readonly { readonly id: string; readonly height: number; }[]): boolean {
		let changed = false;
		for (const { id, height } of rows) {
			if (this.heights.get(id) === height) continue;
			this.heights.set(id, height);
			changed = true;
		}
		if (changed) this.rebuild();
		return changed;
	}

	private rebuild(): void {
		this.geometry.splice(0, this.geometry.count, this.items.map((item, index) => ({
			size: this.heights.get(item.id) ?? this.estimates[index],
		})));
	}
}

function estimateHeight(item: IChatListItem): number {
	if (item.toolInvocation) return 52;
	// Each row contributes its trailing margin, even when represented by a gap.
	// Count line breaks as well as wraps to approximate Markdown and fenced code.
	let lines = 1;
	let lineStart = 0;
	for (let end = item.text.indexOf('\n'); end >= 0; end = item.text.indexOf('\n', lineStart)) {
		lines += Math.max(1, Math.ceil((end - lineStart) / 82));
		lineStart = end + 1;
	}
	lines += Math.floor((item.text.length - lineStart) / 82);
	return (item.type === 'userMessage' ? 50 : 66) + 21 * lines + 180 * (item.resources?.length ?? 0);
}
