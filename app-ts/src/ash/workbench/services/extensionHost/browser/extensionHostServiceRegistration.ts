import { IExtensionHostApi } from "../../../../platform/extensionHost/common/extensionHostApi.js";
import { CommandsRegistry } from "../../../../platform/commands/common/commands.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { registerWorkbenchServiceContribution } from "../../../browser/workbenchServiceContributions.js";
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IOutputService } from "../../output/common/outputService.js";
import { ITaskService } from "../../tasks/common/taskService.js";
import { ITestingService } from "../../testing/common/testingService.js";
import { IExtensionHostService } from "../common/extensionHostService.js";
import { AppServerExtensionHostService } from "./appServerExtensionHostService.js";

registerWorkbenchServiceContribution({
	service: IExtensionHostService,
	dependencies: [IExtensionHostApi, ILogService, ILanguageFeaturesService, ITaskService, ITestingService, IOutputService],
	install: context => {
		const service = context.register(context.container.createInstance(AppServerExtensionHostService, CommandsRegistry, 30_000));
		const ready = service.start();
		context.blockRestorationUntil(ready);
		void ready.catch(error => context.container.get(ILogService).error("extensionHost", "Executable Extension Host activation failed", error));
		return service;
	},
});
