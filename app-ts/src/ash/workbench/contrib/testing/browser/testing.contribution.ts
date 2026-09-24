import { lxiconsLibrary } from "../../../../base/common/lxiconsLibrary.js";
import { ServiceConstructionDescriptor } from "../../../../platform/instantiation/common/instantiation.js";
import { ViewContainerLocation, type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from "../../../common/views.js";
import { ITestingService } from "../../../services/testing/common/testingService.js";
import { ITerminalService } from "../../../services/terminal/common/terminal.js";
import { IViewsService } from "../../../services/views/browser/viewsService.js";
import { TESTING_VIEW_ID } from "../common/testing.js";
import { TestingViewPane } from "./testingViewPane.js";
import "./testingActions.js";
import "./media/testing.css";

export function registerTestingView(registry: WorkbenchViewRegistry = ViewsRegistry): void {
	registry.registerStaticViewContainer({ id: WorkbenchViewContainerId.Testing, title: "Testing", localizationKey: { bundle: "ash.views", key: "testing" }, location: ViewContainerLocation.Sidebar, icon: lxiconsLibrary.check, order: 4 });
	registry.registerStaticViews(WorkbenchViewContainerId.Testing, [{
		id: TESTING_VIEW_ID,
		title: "Testing",
		localizationKey: { bundle: "ash.views", key: "testing" },
		order: 1,
		canToggleVisibility: false,
		ctorDescriptor: new ServiceConstructionDescriptor(TestingViewPane, { serviceDependencies: [ITestingService, ITerminalService, IViewsService] }),
	}]);
}

registerTestingView();
