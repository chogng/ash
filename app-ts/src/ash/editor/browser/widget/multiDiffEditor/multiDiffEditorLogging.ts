import { type ILogService } from '../../../../platform/log/common/log.js';
import { type ICompressedVirtualizedItemRange } from './compressedVirtualizedScrollLayout.js';

/** Records file and geometry changes needed to diagnose a jumping multi-diff viewport. */
export class MultiDiffEditorLogger {
	constructor(private readonly logService: ILogService) {}

	public itemsChanged(items: readonly { readonly id: string }[]): void {
		this.logService.trace('multiDiffEditor', 'comparison list changed', { count: items.length, first: items[0]?.id, last: items.at(-1)?.id });
	}

	public itemStateChanged(itemId: string, state: string): void {
		this.logService.trace('multiDiffEditor', 'comparison state changed', { itemId, state });
	}

	public layoutChanged(before: readonly ICompressedVirtualizedItemRange[], after: readonly ICompressedVirtualizedItemRange[], scrollTopBefore: number, scrollTopAfter: number): void {
		const beforeHeight = before.length > 0 ? before.at(-1)!.top + before.at(-1)!.height : 0;
		const afterHeight = after.length > 0 ? after.at(-1)!.top + after.at(-1)!.height : 0;
		if (beforeHeight === afterHeight && scrollTopBefore === scrollTopAfter) return;
		const firstChangedIndex = after.findIndex((range, index) => range.height !== before[index]?.height);
		this.logService.trace('multiDiffEditor', 'layout changed', { firstChangedIndex, beforeHeight, afterHeight, scrollTopBefore, scrollTopAfter });
	}
}
