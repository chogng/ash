import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { localize2 } from '../../../../nls.js';
import { SEARCH_VIEW_ID, FOCUS_SEARCH_COMMAND_ID } from '../common/constants.js';
import { Lxicon } from "../../../../base/common/lxicons.js";
import { SyncDescriptor } from "../../../../platform/instantiation/common/descriptors.js";
import { ViewContainerLocation, type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from "../../../common/views.js";
import { SearchView } from "./searchView.js";
import "./media/search.css";
import { AccessibleViewRegistry } from "../../../../platform/accessibility/browser/accessibleViewRegistry.js";
import { SearchAccessibilityHelp } from "./searchAccessibilityHelp.js";
import { InstantiationType, registerSingleton } from "../../../../platform/instantiation/common/extensions.js";
import { ISearchHistoryService, SearchHistoryService } from "../common/searchHistoryService.js";
import { IReplaceService } from "./replace.js";
import { ReplaceService } from "./replaceService.js";
import '../../searchEditor/browser/searchEditor.contribution.js';
import './searchActionsRemoveReplace.js';
import './searchActionsCopy.js';
import './searchActionsTopBar.js';

AccessibleViewRegistry.register(new SearchAccessibilityHelp());
registerSingleton(ISearchHistoryService, SearchHistoryService, InstantiationType.Delayed);
registerSingleton(IReplaceService, ReplaceService, InstantiationType.Delayed);

registerAction2(class FocusSearchAction extends Action2 {
	constructor() {
		super({ id: FOCUS_SEARCH_COMMAND_ID, title: localize2('search.focus', 'Search in Files'), f1: true });
	}
	override run(accessor: ServicesAccessor): Promise<boolean> {
		return accessor.get(IViewsService).focusView(SEARCH_VIEW_ID);
	}
});

/** Registers the Search Sidebar container and its initial pane. */
export function registerSearchViews(
	registry: WorkbenchViewRegistry = ViewsRegistry,
): void {
	registry.registerStaticViewContainer({
		id: WorkbenchViewContainerId.Search,
		title: "Search",
		localizationKey: { bundle: "ash.views", key: "search" },
		location: ViewContainerLocation.Sidebar,
		icon: Lxicon.search,
		order: 2,
	});
	registry.registerStaticViews(WorkbenchViewContainerId.Search, [{
		id: SEARCH_VIEW_ID,
		title: "Search",
		localizationKey: { bundle: "ash.views", key: "search" },
		order: 1,
		canToggleVisibility: false,
		ctorDescriptor: new SyncDescriptor(SearchView),
	}]);
}
