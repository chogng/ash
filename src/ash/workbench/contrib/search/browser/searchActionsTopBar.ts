import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize2 } from '../../../../nls.js';
import { SEARCH_VIEW_ID, SearchCommandIds, SearchContext } from '../common/constants.js';
import type { SearchView } from './searchView.js';

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
