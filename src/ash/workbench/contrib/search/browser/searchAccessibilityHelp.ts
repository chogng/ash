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
			() => [localize('search.help', 'Search across files\nType a query and press Enter. Shift+Enter or Alt+Enter inserts a new line. Up and Down navigate input history; in a multiline query, hold Alt. Use Tab to reach search options and the file filters. Space toggles case sensitivity, whole-word matching or regular expressions. Toggle Search Details expands or collapses the file filters without clearing them.\nToggle Replace opens the replacement input. Replacement actions support preserving case and replacing all results with confirmation. More Actions offers replacing a selected result, previewing changes and undoing the last replacement.\nIn the results tree, use Up and Down to move, Right to expand, and Left to collapse. Enter opens and pins a result. Space previews it while keeping focus in the tree. Ctrl or Command+Enter opens it beside the current editor. F4 moves to the next match and Shift+F4 moves to the previous match.\nSearch result actions provide collapse, tree view, sorting, clearing history and opening results in Search Editor.\nPress Escape to close this help and return to the previous control.'), localize('search.dismissHelp', 'Dismiss removes selected matches, files or folders from the results without deleting files. In the results tree, use <keybinding:search.action.remove> or Dismiss in More Actions. Ctrl or Command+click selects multiple results. Refresh searches the files again.'), localize('search.copyAllHelp', 'Copy All in More Actions writes the retained file paths, line and column positions and matching lines to the clipboard, including collapsed results. Dismissed results are excluded. Copying does not change files or stop a search.'), localize('search.copyHelp', 'In the results tree, use <keybinding:search.action.copyMatch> or Copy in More Actions to copy the first selected result without combining multiple selections. A result context menu or Shift+F10 menu copies its own row. A match copies its full matching lines and positions; a file or folder copies its retained results, including collapsed rows. Copying does not change files or stop a search.'), localize('search.copyPathHelp', 'File and folder result context menus and Shift+F10 menus offer Copy Path to copy only the path of that row. In the results tree, use <keybinding:search.action.copyPath> to copy a path only when the first selected result is a file, without combining selections. A folder or matching line as the first selection does not copy a path. Copying does not change results or files or stop a search.'), localize('search.lifecycleHelp', 'F1 offers Search: Refresh, Search: Cancel Search and Search: Clear Search Results. Refresh uses the current query, options and file filters, replaces any running search and focuses the query. Use <keybinding:search.action.cancel> in the result tree to cancel and focus the query; Escape in an input cancels while keeping that input focused. Cancellation retains delivered results. After two seconds, the refresh toolbar button becomes Cancel Search. Clear removes results, the query and replacement text. Clear again while both inputs are empty to remove file filters. Search options and input history are preserved.'), localize('search.expandAllHelp', 'When the visible result branches are all collapsed, the toolbar offers Expand All and F1 lists Search: Expand All. The action expands all folders and files, including hidden child branches. It does not open files, change selection, results or disk contents, or stop a search.')].join('\n'),
			() => { if (focused?.isConnected) { focused.focus(); } else { view.focus(); } },
			AccessibilityVerbositySettingId.Find,
		);
	}
}
