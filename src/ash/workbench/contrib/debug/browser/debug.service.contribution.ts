import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IDebugVisualizerService, DebugVisualizerService } from '../common/debugVisualizers.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import { registerWorkbenchServiceContribution } from '../../../browser/workbenchServiceContributions.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ITaskService } from '../../tasks/common/taskService.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { ITerminalProfileResolverService } from '../../terminal/common/terminal.js';
import { ITerminalProcessService } from '../../../../platform/terminal/common/terminal.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IDebugAdapterProcessService } from '../../../../platform/debug/common/debugAdapterProcessService.js';
import { IDebugService, IAdapterManager } from '../common/debug.js';
import { DebugService } from './debugService.js';
import { IFileService } from '../../../../platform/files/common/files.js';

registerWorkbenchServiceContribution({
	service: IDebugService,
	dependencies: [
		IExtensionService,
		IFileService,
		IWorkspaceContextService,
		IDebugAdapterProcessService,
		ITerminalService,
		ITerminalProfileResolverService,
		ITerminalProcessService,
		IStorageService,
		ILifecycleService,
		ITaskService,
		IAdapterManager,
		ILogService,
		IConfigurationResolverService,
		IConfigurationService,
		IEditorService,
		ITextModelService,
		INotificationService,
	],
	install: context => {
		const service = context.register(context.container.createInstance(DebugService));
		return service;
	},
});

registerSingleton(IDebugVisualizerService, DebugVisualizerService, InstantiationType.Delayed);
