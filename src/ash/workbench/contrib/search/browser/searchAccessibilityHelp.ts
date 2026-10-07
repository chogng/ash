import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import type { IAccessibleViewImplementation } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../nls.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { SearchContext } from '../common/constants.js';
import type { ViewPane } from '../../../browser/parts/views/viewPane.js';

export class SearchAccessibilityHelp implements IAccessibleViewImplementation {
	public readonly priority = 105;
	public readonly name = 'search';
	public readonly type = AccessibleViewType.Help;
	public readonly when = SearchContext.SearchViewFocusedKey.isEqualTo(true);

	public getProvider(accessor: ServicesAccessor): AccessibleContentProvider | undefined {
		const view = accessor.get(IViewsService).getActiveViewWithId<ViewPane>('ash.searchView');
		if (!view) { return undefined; }
		const focused = view.element.ownerDocument.activeElement as HTMLElement | null;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.SearchHelp,
			{ type: AccessibleViewType.Help },
			() => [localize('search.help', 'Search across files\nType a query and press Enter. Shift+Enter or Alt+Enter inserts a new line. Up and Down navigate input history; in a multiline query, hold Alt. Use Tab to reach search options and the file filters. Space toggles case sensitivity, whole-word matching or regular expressions. Toggle Search Details expands or collapses the file filters without clearing them.\nToggle Replace opens the replacement input. Replacement actions support preserving case and replacing all results with confirmation. More Actions offers replacing a selected result, previewing changes and undoing the last replacement.\nIn the results tree, use Up and Down to move, Right to expand, and Left to collapse. Enter opens and pins a result. Space previews it while keeping focus in the tree. Ctrl or Command+Enter opens it beside the current editor. F4 moves to the next match and Shift+F4 moves to the previous match.\nPress Escape to stop a running search. Search result actions provide refresh, clear, collapse, tree view, sorting, clearing history and opening results in Search Editor.\nPress Escape to close this help and return to the previous control.'), localize('search.dismissHelp', 'Dismiss removes selected matches, files or folders from the results without deleting files. In the results tree, use <keybinding:search.action.remove> or Dismiss in More Actions. Ctrl or Command+click selects multiple results. Refresh searches the files again.')].join('\n'),
			() => { if (focused?.isConnected) { focused.focus(); } else { view.focus(); } },
			AccessibilityVerbositySettingId.Find,
		);
	}
}
