import { IDebugService } from '../../contrib/debug/common/debug.js';
import { ISpeechService } from '../../contrib/speech/common/speechService.js';
// API composition waits for its contribution-owned bridges before starting package activation.
import { ITerminalService } from '../../services/terminal/browser/terminal.js';
import { ITerminalProfileService, ITerminalProfileResolverService } from '../../services/terminal/common/terminal.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { IExtensionService } from '../../services/extensions/common/extensionService.js';
import { IExtensionHostApi } from '../../../platform/agentHost/common/extensionHostApi.js';
import { CommandsRegistry } from "../../../platform/commands/common/commands.js";
import { ILogService } from "../../../platform/log/common/log.js";
import { registerWorkbenchServiceContribution } from "../../browser/workbenchServiceContributions.js";
import { ILanguageFeaturesService } from '../../../editor/common/services/languageFeatures.js';
import { IOutputService } from "../../services/output/common/output.js";
import { ITaskService } from "../../contrib/tasks/common/taskService.js";
import { ITestingService } from "../../services/testing/common/testingService.js";
import { IExtensionHostService } from "../../services/extensionHost/common/extensionHostService.js";
import { AppServerExtensionHostService } from "../../services/extensionHost/browser/appServerExtensionHostService.js";
import { IQuickInputService } from '../../../platform/quickinput/common/quickInput.js';
import { IViewsService } from '../../services/views/common/viewsService.js';

registerWorkbenchServiceContribution({
	service: IExtensionHostService,
	dependencies: [IDebugService, ISpeechService, ITerminalService, ITerminalProfileService, ITerminalProfileResolverService, IConfigurationService, IWorkspaceContextService, IExtensionService, IExtensionHostApi, ILogService, ILanguageFeaturesService, ITaskService, ITestingService, IOutputService, IQuickInputService, IViewsService],
	install: context => {
		const service = context.register(context.container.createInstance(AppServerExtensionHostService, CommandsRegistry, 30_000));
		const ready = service.start();
		context.blockRestorationUntil(ready);
		void ready.catch(error => context.container.get(ILogService).error("extensionHost", "Executable Extension Host activation failed", error));
		return service;
	},
});
