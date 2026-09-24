import { IFileService } from "../../../../platform/files/common/files.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { registerWorkbenchServiceContribution } from "../../../browser/workbenchServiceContributions.js";
import { IOutputService } from "../../output/common/outputService.js";
import { ITerminalService } from "../../terminal/common/terminal.js";
import { ITaskService } from "../common/taskService.js";
import { TaskService } from "./taskService.js";

registerWorkbenchServiceContribution({
	service: ITaskService,
	dependencies: [IFileService, IWorkspaceContextService, ITerminalService, IOutputService, ILogService],
	install: context => context.register(new TaskService(context.container.get(IFileService), context.container.get(IWorkspaceContextService), context.container.get(ITerminalService), context.container.get(IOutputService), context.container.get(ILogService))),
});
