import { stripIcons } from '../../../../base/common/iconLabels.js';
import type { IQuickTreeItem } from '../../common/quickInput.js';

/** Structural ARIA stays with ObjectTree; item semantics are supplied by Quick Input. */
export class QuickTreeAccessibilityProvider {
	getAriaLabel(item: IQuickTreeItem): string {
		return item.ariaLabel ?? [item.label, item.description, item.detail].filter(Boolean).map(value => stripIcons(value!)).join(', ');
	}

	isChecked(item: IQuickTreeItem): boolean | 'mixed' | undefined {
		return item.pickable === false ? undefined : item.checked ?? false;
	}

	isDisabled(item: IQuickTreeItem): boolean { return item.disabled === true; }
}
