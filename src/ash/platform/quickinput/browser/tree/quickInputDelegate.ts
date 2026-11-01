import type { IQuickTreeItem } from '../../common/quickInput.js';
import type { IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { QuickInputTreeRenderer } from './quickInputTreeRenderer.js';

/** A fixed row keeps hierarchical selection compact; long descriptions remain available on hover. */
export class QuickInputTreeDelegate<T extends IQuickTreeItem = IQuickTreeItem> implements IListVirtualDelegate<T> {
	getHeight(_element: T): number { return 34; }
	getTemplateId(_element: T): string { return QuickInputTreeRenderer.ID; }
}
