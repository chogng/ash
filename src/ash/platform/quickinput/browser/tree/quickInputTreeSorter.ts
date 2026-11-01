import { stripIcons } from '../../../../base/common/iconLabels.js';
import type { TreeSorter } from '../../../../base/browser/ui/tree/tree.js';
import type { IQuickTreeItem } from '../../common/quickInput.js';
import { Disposable } from '../../../../base/common/lifecycle.js';

export class QuickInputTreeSorter extends Disposable implements TreeSorter<IQuickTreeItem> {
	sortByLabel = true;

	compare(a: IQuickTreeItem, b: IQuickTreeItem): number {
		if (!this.sortByLabel) return 0;
		const labelOrder = stripIcons(a.label).localeCompare(stripIcons(b.label));
		if (labelOrder) return labelOrder;
		if (a.description === undefined || b.description === undefined) return a.description === b.description ? 0 : a.description === undefined ? 1 : -1;
		return stripIcons(a.description).localeCompare(stripIcons(b.description));
	}
}
