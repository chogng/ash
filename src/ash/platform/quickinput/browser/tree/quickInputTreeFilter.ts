import { TreeVisibility, type ITreeFilterDataResult, type TreeFilter } from '../../../../base/browser/ui/tree/tree.js';
import { matchesFuzzyIconAware, parseLabelWithIcons } from '../../../../base/common/iconLabels.js';
import type { IQuickTreeItem } from '../../common/quickInput.js';
import type { IQuickTreeFilterData } from './quickInputTree.js';

export class QuickInputTreeFilter implements TreeFilter<IQuickTreeItem, IQuickTreeFilterData> {
	filterValue = '';
	matchOnLabel = true;
	matchOnDescription = false;
	private readonly visibility = new Map<IQuickTreeItem, TreeVisibility>();

	getHighlights(item: IQuickTreeItem): IQuickTreeFilterData {
		const query = this.filterValue.trim();
		return {
			labelHighlights: query && this.matchOnLabel ? matchesFuzzyIconAware(query, parseLabelWithIcons(item.label)) ?? undefined : undefined,
			descriptionHighlights: query && this.matchOnDescription && item.description ? matchesFuzzyIconAware(query, parseLabelWithIcons(item.description)) ?? undefined : undefined,
		};
	}

	prepare(items: readonly IQuickTreeItem[]): void {
		this.visibility.clear();
		const visit = (item: IQuickTreeItem, ancestorMatches: boolean): boolean => {
			const highlights = this.getHighlights(item);
			const matches = ancestorMatches || !this.filterValue.trim() || !(this.matchOnLabel || this.matchOnDescription)
				|| !!highlights.labelHighlights || !!highlights.descriptionHighlights;
			let childMatches = false;
			for (const child of item.children ?? []) childMatches = visit(child, matches) || childMatches;
			this.visibility.set(item, matches ? TreeVisibility.Visible : childMatches ? TreeVisibility.Recurse : TreeVisibility.Hidden);
			return matches || childMatches;
		};
		items.forEach(item => visit(item, false));
	}

	filter(element: IQuickTreeItem, _parentVisibility: TreeVisibility = TreeVisibility.Visible): ITreeFilterDataResult<IQuickTreeFilterData> {
		return { visibility: this.visibility.get(element) ?? TreeVisibility.Hidden, data: this.getHighlights(element) };
	}
}
