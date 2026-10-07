import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IRendererHostService, type IRendererHost } from '../../../../../platform/renderer/common/rendererHost.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { SessionsManagementService } from '../../../../services/sessions/browser/sessionsManagementService.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { AppServerSessionsProvider, type AppServerSessionsProviderHost } from './appServerSessionsProvider.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { pickWorkspaceFolder, selectionFromWorkspace } from '../../../../browser/workspaceSelection.js';

class WorkbenchSessionsManagementService extends SessionsManagementService {
	constructor(@IRendererHostService api: IRendererHost, @IWorkspaceContextService workspace: IWorkspaceContextService, @IQuickInputService quickInput: IQuickInputService, @IInstantiationService instantiationService: IInstantiationService) {
		super(instantiationService.createInstance(AppServerSessionsProvider, { session: api.session, model: api.model, turn: api.turn, events: api.events, workspace: () => selectionFromWorkspace(workspace.getWorkspace()), selectWorkspace: folders => pickWorkspaceFolder(quickInput, folders) } satisfies AppServerSessionsProviderHost));
	}
}

class WorkbenchSessionsStartupContribution extends Disposable {
	constructor(@ISessionsManagementService sessions: ISessionsManagementService) {
		super();
		void sessions.initialize().catch(onUnexpectedError);
	}
}

registerSingleton(ISessionsManagementService, WorkbenchSessionsManagementService, InstantiationType.Delayed);
registerWorkbenchContribution('sessions.contrib.workbenchStartup', WorkbenchPhase.BlockRestore,
	accessor => accessor.get(IInstantiationService).createInstance(WorkbenchSessionsStartupContribution));
