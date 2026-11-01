import type { IMatch } from '../../../../base/common/filters.js';
import type { IQuickTreeItem } from '../../common/quickInput.js';

export interface IQuickTreeFilterData {
	readonly labelHighlights?: IMatch[];
	readonly descriptionHighlights?: IMatch[];
}

/** Disabled leaves do not prevent an otherwise selected group from being checked. */
export function getParentNodeState(children: readonly { readonly element: IQuickTreeItem | null; }[]): boolean | 'mixed' {
	const selectable = children.filter(({ element }) => !element || !element.disabled && (element.pickable !== false || element.children?.length));
	if (!selectable.length) return false;
	if (selectable.every(({ element }) => element?.checked === true)) return true;
	return selectable.some(({ element }) => element?.checked === true || element?.checked === 'mixed') ? 'mixed' : false;
}
