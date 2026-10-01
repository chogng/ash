import { Lxicon } from "../../../../base/common/lxicons.js";
import { SyncDescriptor } from "../../../../platform/instantiation/common/descriptors.js";
import { ViewContainerLocation, type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from "../../../common/views.js";
import { TESTING_VIEW_ID } from "../common/testing.js";
import { TestingViewPane } from "./testingViewPane.js";
import "./testingActions.js";
import "./media/testing.css";

export function registerTestingView(registry: WorkbenchViewRegistry = ViewsRegistry): void {
	registry.registerStaticViewContainer({ id: WorkbenchViewContainerId.Testing, title: "Testing", localizationKey: { bundle: "ash.views", key: "testing" }, location: ViewContainerLocation.Sidebar, icon: Lxicon.check, order: 4 });
	registry.registerStaticViews(WorkbenchViewContainerId.Testing, [{
		id: TESTING_VIEW_ID,
		title: "Testing",
		localizationKey: { bundle: "ash.views", key: "testing" },
		order: 1,
		canToggleVisibility: false,
		ctorDescriptor: new SyncDescriptor(TestingViewPane),
	}]);
}

registerTestingView();
