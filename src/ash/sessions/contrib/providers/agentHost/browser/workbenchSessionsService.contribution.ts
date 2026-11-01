import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { SessionsManagementService } from '../../../../services/sessions/browser/sessionsManagementService.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { AppServerSessionsProvider, type AppServerSessionsProviderHost } from './appServerSessionsProvider.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { selectionFromWorkspace } from '../../../../common/agentHostSessionWorkspace.js';
import { WorkspacePicker } from '../../../chat/browser/sessionWorkspacePicker.js';
import { IDevContainerAgentHostService } from '../../../../common/devContainerAgentHostService.js';
import { DevContainerAgentHostService } from '../../remoteAgentHost/browser/devContainerAgentHostService.js';

class WorkbenchSessionsManagementService extends SessionsManagementService {
	constructor(@IWorkspaceContextService workspace: IWorkspaceContextService, @IInstantiationService instantiationService: IInstantiationService, @ISessionsProvidersService providers: ISessionsProvidersService) {
		const provider = instantiationService.createInstance(AppServerSessionsProvider, {
			workspace: () => selectionFromWorkspace(workspace.getWorkspace()),
			selectWorkspace: async folders => {
				using selection = instantiationService.createInstance(WorkspacePicker);
				return await selection.pick(folders);
			},
		} satisfies AppServerSessionsProviderHost);
		super(provider, providers);
		this._register(providers.registerProvider(provider));
	}
}

class WorkbenchSessionsStartupContribution extends Disposable {
	constructor(@ISessionsManagementService sessions: ISessionsManagementService) {
		super();
		void sessions.initialize().catch(onUnexpectedError);
	}
}

registerSingleton(ISessionsManagementService, WorkbenchSessionsManagementService, InstantiationType.Delayed);
registerSingleton(IDevContainerAgentHostService, DevContainerAgentHostService, InstantiationType.Delayed);
registerWorkbenchContribution('sessions.contrib.workbenchStartup', WorkbenchPhase.BlockRestore,
	accessor => accessor.get(IInstantiationService).createInstance(WorkbenchSessionsStartupContribution));
