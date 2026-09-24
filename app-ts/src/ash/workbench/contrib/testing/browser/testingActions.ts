import { Action2, MenuId, registerAction2 } from "../../../../platform/actions/common/actions.js";
import { type ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { ITestingService } from "../../../services/testing/common/testingService.js";
import { IViewsService } from "../../../services/views/browser/viewsService.js";
import { REFRESH_TESTS_COMMAND_ID, RUN_ALL_TESTS_COMMAND_ID, TESTING_VIEW_ID } from "../common/testing.js";

registerAction2(class RunAllTestsAction extends Action2 {
	constructor() {
		super({ id: RUN_ALL_TESTS_COMMAND_ID, title: "Run All Tests", f1: true, menu: { id: MenuId.MenubarRunMenu, group: "3_testing", order: 1 } });
	}

	override run(accessor: ServicesAccessor): void {
		const service = accessor.get(ITestingService);
		accessor.get(IViewsService).focusView(TESTING_VIEW_ID);
		void service.runAll().catch(error => console.error("Could not run tests", error));
	}
});

registerAction2(class RefreshTestsAction extends Action2 {
	constructor() { super({ id: REFRESH_TESTS_COMMAND_ID, title: "Refresh Tests", f1: true }); }
	override run(accessor: ServicesAccessor): void {
		void accessor.get(ITestingService).refresh().catch(error => console.error("Could not refresh tests", error));
	}
});
