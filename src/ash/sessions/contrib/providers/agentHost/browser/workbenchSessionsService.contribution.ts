import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IAgentConnection } from '../../../../../platform/agentHost/common/agentService.js';
import { IAgentExecutionSettingsService } from '../../../../../platform/agentHost/common/agentExecutionSettingsService.js';
import { IChatService } from '../../../../../workbench/services/chat/common/chatService.js';
import { ChatService } from '../../../../../workbench/services/chat/browser/chatService.js';
import { ILanguageModelsService } from '../../../../../workbench/contrib/chat/common/languageModels.js';
import { IPromptsService } from '../../../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { ILanguageModelToolsService } from '../../../../../workbench/contrib/chat/common/tools/languageModelToolsService.js';
import { ISessionPrimaryProviderServices, ISessionProviderScopeService, SessionProviderScopeService, SessionProviderServices } from '../../../../browser/agentHost/sessionProviderScopeService.js';
import { SessionsChatService } from '../../../../browser/agentHost/sessionsChatService.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../../common/agentHostSessionsProvider.js';
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
				using selection = instantiationService.createInstance(WorkspacePicker, {});
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

class WorkbenchPrimaryProviderServices extends SessionProviderServices {
	constructor(
		@IInstantiationService instantiation: IInstantiationService,
		@ILanguageModelsService models: ILanguageModelsService,
		@IPromptsService prompts: IPromptsService,
		@IAgentExecutionSettingsService execution: IAgentExecutionSettingsService,
		@IAgentConnection host: IAgentConnection,
		@ILanguageModelToolsService tools: ILanguageModelToolsService,
	) {
		const chat = instantiation.createInstance(ChatService);
		super(chat, models, prompts, execution, host, tools);
		this._register(chat);
	}
}

registerSingleton(ISessionPrimaryProviderServices, WorkbenchPrimaryProviderServices, InstantiationType.Delayed);
registerSingleton(ISessionProviderScopeService, new SyncDescriptor(SessionProviderScopeService, [LOCAL_AGENT_HOST_PROVIDER_ID], true));
registerSingleton(IChatService, SessionsChatService, InstantiationType.Delayed);
registerSingleton(ISessionsManagementService, WorkbenchSessionsManagementService, InstantiationType.Delayed);
registerSingleton(IDevContainerAgentHostService, DevContainerAgentHostService, InstantiationType.Delayed);
registerWorkbenchContribution('sessions.contrib.workbenchStartup', WorkbenchPhase.BlockRestore,
	accessor => accessor.get(IInstantiationService).createInstance(WorkbenchSessionsStartupContribution));
