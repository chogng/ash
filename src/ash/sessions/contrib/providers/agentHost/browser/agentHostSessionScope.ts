import { IAgentToolsApi } from '../../../../../platform/agentHost/common/agentToolsApi.js';
import { LanguageModelToolsService } from '../../../../../workbench/contrib/chat/browser/tools/languageModelToolsService.js';
import { ILanguageModelToolsService } from '../../../../../workbench/contrib/chat/common/tools/languageModelToolsService.js';
import type { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IAccountService } from '../../../../../platform/accounts/common/accountService.js';
import { IAgentExecutionSettingsService } from '../../../../../platform/agentHost/common/agentExecutionSettingsService.js';
import { IAgentModelsService } from '../../../../../platform/models/common/agentModels.js';
import { IAgentSessionService, IAgentThreadService, IAgentTurnService, IAgentConnection } from '../../../../../platform/agentHost/common/agentService.js';
import { IAppServerApi, IAppServerHookApi, IAppServerSkillApi, IServerEventApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import type { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ITurnChangesApi } from '../../../../../platform/turnChanges/common/turnChangesApi.js';
import { LanguageModelsService, ILanguageModelsService } from '../../../../../workbench/contrib/chat/common/languageModels.js';
import { IPromptsService } from '../../../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { PromptsService } from '../../../../../workbench/contrib/chat/common/promptSyntax/service/promptsServiceImpl.js';
import { AppServerAccountService } from '../../../../../workbench/services/accounts/browser/appServerAccountService.js';
import { ChatService } from '../../../../../workbench/services/chat/browser/chatService.js';
import { IChatService } from '../../../../../workbench/services/chat/common/chatService.js';
import { IDevContainerAgentHostService } from '../../../../common/devContainerAgentHostService.js';
import { DevContainerAgentHostService } from '../../remoteAgentHost/browser/devContainerAgentHostService.js';

/** The host scope borrows UI services and owns every service that retains backend subscriptions. */
export function createAgentHostSessionScope(parent: IInstantiationService, api: IAgentConnection, lifetime: DisposableStore): IInstantiationService {
	const scope = lifetime.add(parent.createChild());
	scope.registerInstance(IAgentConnection, api);
	scope.registerInstance(IAppServerApi, api.appServer);
	scope.registerInstance(IServerEventApi, api.events);
	scope.registerInstance(IAgentSessionService, api.session);
	scope.registerSingleton(IDevContainerAgentHostService, () => scope.createInstance(DevContainerAgentHostService));
	scope.registerInstance(IAgentModelsService, api.model);
	scope.registerInstance(IAgentThreadService, api.thread);
	scope.registerInstance(IAgentTurnService, api.turn);
	scope.registerInstance(ITurnChangesApi, api.turnChanges);
	scope.registerInstance(IAgentExecutionSettingsService, api.executionSettings);
	scope.registerInstance(IAgentToolsApi, api.agentTools);
	scope.registerInstance(ILanguageModelToolsService, lifetime.add(scope.createInstance(LanguageModelToolsService)));
	scope.registerInstance(IAppServerSkillApi, api.skills);
	scope.registerInstance(IAppServerHookApi, api.hooks);
	scope.registerInstance(IAccountService, lifetime.add(new AppServerAccountService(api.accounts, api.events)));
	scope.registerInstance(IPromptsService, lifetime.add(scope.createInstance(PromptsService)));
	scope.registerInstance(ILanguageModelsService, lifetime.add(scope.createInstance(LanguageModelsService)));
	scope.registerInstance(IChatService, lifetime.add(scope.createInstance(ChatService)));
	return scope;
}
