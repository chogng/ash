import { ITerminalService } from '../../../contrib/terminal/browser/terminal.js';
import { ITerminalProfileService, ITerminalProfileResolverService } from '../../../contrib/terminal/common/terminal.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IExtensionService } from '../../extensions/common/extensionService.js';
import { IExtensionHostApi } from '../../../../platform/agentHost/common/extensionHostApi.js';
import { CommandsRegistry } from "../../../../platform/commands/common/commands.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { registerWorkbenchServiceContribution } from "../../../browser/workbenchServiceContributions.js";
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IOutputService } from "../../output/common/output.js";
import { ITaskService } from "../../tasks/common/taskService.js";
import { ITestingService } from "../../testing/common/testingService.js";
import { IExtensionHostService } from "../common/extensionHostService.js";
import { AppServerExtensionHostService } from "./appServerExtensionHostService.js";
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IViewsService } from '../../views/common/viewsService.js';

registerWorkbenchServiceContribution({
	service: IExtensionHostService,
	dependencies: [ITerminalService, ITerminalProfileService, ITerminalProfileResolverService, IConfigurationService, IWorkspaceContextService, IExtensionService, IExtensionHostApi, ILogService, ILanguageFeaturesService, ITaskService, ITestingService, IOutputService, IQuickInputService, IViewsService],
	install: context => {
		const service = context.register(context.container.createInstance(AppServerExtensionHostService, CommandsRegistry, 30_000));
		const ready = service.start();
		context.blockRestorationUntil(ready);
		void ready.catch(error => context.container.get(ILogService).error("extensionHost", "Executable Extension Host activation failed", error));
		return service;
	},
});
