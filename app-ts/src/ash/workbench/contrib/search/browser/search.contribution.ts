import { Lxicon } from "../../../../base/common/lxicons.js";
import { SyncDescriptor } from "../../../../platform/instantiation/common/descriptors.js";
import { ViewContainerLocation, type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from "../../../common/views.js";
import { SearchViewPane } from "./searchViewPane.js";
import "./media/search.css";

export const SEARCH_VIEW_ID = "ash.searchView";

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
		ctorDescriptor: new SyncDescriptor(SearchViewPane),
	}]);
}
