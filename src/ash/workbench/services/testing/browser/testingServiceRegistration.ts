import { ILogService } from "../../../../platform/log/common/log.js";
import { registerWorkbenchServiceContribution } from "../../../browser/workbenchServiceContributions.js";
import { ITaskService } from "../../tasks/common/taskService.js";
import { ITestingService } from "../common/testingService.js";
import { TestingService } from "./testingService.js";
import { ITestExecutionService } from '../../../../platform/testing/common/testExecutionService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkingCopyService } from '../../workingCopy/common/workingCopyService.js';
import { IDebugService } from '../../debug/common/debugService.js';

registerWorkbenchServiceContribution({
	service: ITestingService,
	dependencies: [ITaskService, ILogService, ITestExecutionService, IWorkspaceContextService, IWorkingCopyService, IDebugService],
	install: context => context.register(context.container.createInstance(TestingService)),
});
