import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { localize2 } from '../../../../nls.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { SEARCH_VIEW_ID, SearchCommandIds, SearchContext } from '../common/constants.js';
import type { SearchView } from './searchView.js';

registerAction2(class RemoveAction extends Action2 {
	constructor() {
		super({
			id: SearchCommandIds.RemoveActionId,
			title: localize2('search.dismiss', 'Dismiss'),
			icon: Lxicon.close,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				when: ContextKeyExpr.and(SearchContext.SearchViewFocusedKey.isEqualTo(true), SearchContext.FileMatchOrMatchFocusKey.isEqualTo(true)),
				primary: KeyCode.Delete,
				mac: { primary: KeyMod.CtrlCmd | KeyCode.Backspace },
			},
		});
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const view = accessor.get(IViewsService).getActiveViewWithId<SearchView>(SEARCH_VIEW_ID);
		if (!view) { return; }
		const tree = view.getControl();
		const focused = tree.focus;
		if (!focused) { return; }
		const elements = tree.selection.includes(focused) ? [...tree.selection] : [focused];
		const previous = tree.getVisibleElements();
		const focusIndex = previous.indexOf(focused);
		view.searchResult.batchRemove(elements);
		await view.queueRefreshTree();
		const survives = (element: typeof focused): boolean => tree.model.getElement(element.id) === element;
		if (!survives(focused)) {
			const following = previous.slice(focusIndex + 1);
			const preceding = previous.slice(0, focusIndex).reverse();
			const candidates = [...following, ...preceding].filter(survives);
			const next = candidates.find(element => element.kind === focused.kind) ?? candidates[0] ?? tree.getVisibleElements()[0];
			if (next) {
				tree.setFocus(next.id);
				tree.setSelection([next.id]);
			}
		}
		tree.domFocus();
	}
});
