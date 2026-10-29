import { registerWorkbenchServiceContribution } from '../../../browser/workbenchServiceContributions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { ITerminalProfileResolverService } from '../../terminal/common/terminal.js';
import { IOutputService, type IOutputChannel } from '../../../services/output/common/output.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IMarkerService } from '../../../../platform/markers/common/markers.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IPathService } from '../../../../platform/path/common/pathService.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import { ITaskService } from '../common/taskService.js';
import { AbstractTaskService } from './abstractTaskService.js';
import { TerminalTaskSystem } from './terminalTaskSystem.js';

/** The browser host executes tasks through the existing terminal task system. */
export class TaskService extends AbstractTaskService {
	protected override createTerminalTaskSystem(output: IOutputChannel): TerminalTaskSystem {
		return this.instantiationService.createInstance(TerminalTaskSystem, output);
	}
}

registerWorkbenchServiceContribution({
	service: ITaskService,
	dependencies: [IFileService, IWorkspaceContextService, ITerminalService, ITerminalProfileResolverService, IOutputService, ILogService, IConfigurationService, IConfigurationResolverService, IMarkerService, IModelService, IPathService, IExtensionService],
	install: context => context.register(context.container.createInstance(TaskService)),
});
