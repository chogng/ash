import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize2 } from '../../../../nls.js';
import { SEARCH_VIEW_ID, SearchCommandIds, SearchContext } from '../common/constants.js';
import type { SearchView } from './searchView.js';
import { SearchStateKey, SearchUIState } from '../common/search.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';

registerAction2(class CancelSearchAction extends Action2 {
	constructor() {
		super({
			id: SearchCommandIds.CancelSearchActionId,
			title: localize2('search.cancelCommand', 'Search: Cancel Search'),
			icon: Lxicon.close,
			f1: true,
			precondition: ContextKeyExpr.or(SearchStateKey.isEqualTo(SearchUIState.Searching), SearchStateKey.isEqualTo(SearchUIState.SlowSearch)),
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyCode.Escape,
				when: ContextKeyExpr.and(SearchContext.SearchViewFocusedKey.isEqualTo(true), SearchContext.SearchResultListFocusedKey.isEqualTo(true)),
			},
		});
	}

	public override run(accessor: ServicesAccessor): void {
		const view = accessor.get(IViewsService).getActiveViewWithId<SearchView>(SEARCH_VIEW_ID);
		if (view && !view.isDisposed) { view.cancelSearch(); }
	}
});

registerAction2(class RefreshSearchResultsAction extends Action2 {
	constructor() {
		super({
			id: SearchCommandIds.RefreshSearchResultsActionId,
			title: localize2('search.refreshCommand', 'Search: Refresh'),
			icon: Lxicon.refresh,
			f1: true,
			precondition: SearchContext.ViewHasSearchPatternKey.isEqualTo(true),
		});
	}

	public override run(accessor: ServicesAccessor): void {
		const view = accessor.get(IViewsService).getActiveViewWithId<SearchView>(SEARCH_VIEW_ID);
		if (view && !view.isDisposed) { view.triggerQueryChange({ preserveFocus: false }); }
	}
});

registerAction2(class ClearSearchResultsAction extends Action2 {
	constructor() {
		super({
			id: SearchCommandIds.ClearSearchResultsActionId,
			title: localize2('search.clearCommand', 'Search: Clear Search Results'),
			icon: Lxicon.trash,
			f1: true,
			precondition: ContextKeyExpr.or(SearchContext.HasSearchResults.isEqualTo(true), SearchContext.ViewHasSearchPatternKey.isEqualTo(true), SearchContext.ViewHasReplacePatternKey.isEqualTo(true), SearchContext.ViewHasFilePatternKey.isEqualTo(true)),
		});
	}

	public override run(accessor: ServicesAccessor): void {
		const view = accessor.get(IViewsService).getActiveViewWithId<SearchView>(SEARCH_VIEW_ID);
		if (view && !view.isDisposed) { view.clearSearchResults(); }
	}
});

registerAction2(class ExpandAllAction extends Action2 {
	constructor() {
		super({
			id: SearchCommandIds.ExpandSearchResultsActionId,
			// Action2 exposes a title, so include the category in the palette's localized name.
			title: localize2('search.expandAllCommand', 'Search: Expand All'),
			icon: Lxicon.chevronDown,
			f1: true,
			precondition: ContextKeyExpr.and(SearchContext.HasSearchResults.isEqualTo(true), SearchContext.ViewHasSomeCollapsibleKey.isEqualTo(false)),
		});
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const view = accessor.get(IViewsService).getActiveViewWithId<SearchView>(SEARCH_VIEW_ID);
		if (!view || view.isDisposed) { return; }
		const tree = view.getControl();
		// UI enablement does not restrict direct calls on partially expanded results.
		for (const node of tree.model.rootNodes) { tree.expandRecursive(node.id); }
	}
});
