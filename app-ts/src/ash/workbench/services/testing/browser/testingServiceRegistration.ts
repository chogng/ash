import { ILogService } from "../../../../platform/log/common/log.js";
import { registerWorkbenchServiceContribution } from "../../../browser/workbenchServiceContributions.js";
import { ITaskService } from "../../tasks/common/taskService.js";
import { ITestingService } from "../common/testingService.js";
import { TestingService } from "./testingService.js";

registerWorkbenchServiceContribution({
	service: ITestingService,
	dependencies: [ITaskService, ILogService],
	install: context => context.register(new TestingService(context.container.get(ITaskService), context.container.get(ILogService))),
});
