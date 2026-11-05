import { isNonEmptyString, isRecord } from '../../../base/common/types.js';
import { localize } from '../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { ILayoutService } from '../../../platform/layout/browser/layoutService.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import * as chatInputStatePersistence from '../../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { ISessionProviderScopeService } from '../../browser/agentHost/sessionProviderScopeService.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../common/agentHostSessionsProvider.js';
import { SessionsWorkspaceModeContext } from '../../common/contextkeys.js';
import { OPEN_ASH_CHAT_WITH_MODEL_COMMAND, SHOW_ASH_CHAT_COMMAND } from '../../contrib/chat/common/constants.js';
import { writeNewChatDraftState } from '../../contrib/chat/common/newChatDraftState.js';
import { IChatGPTService } from '../../contrib/chatgptweb/browser/chatGPTService.js';
import { chatGPTSelectedContext } from '../chatGPTWeb.js';
import { canUseCodeModels } from '../chatGPTWidgetModel.js';
import { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';

CommandsRegistry.register(OPEN_ASH_CHAT_WITH_MODEL_COMMAND, async (accessor, model: unknown): Promise<void> => {
	if (!isRecord(model) || !isNonEmptyString(model.provider) || !isNonEmptyString(model.model)) {
		throw new TypeError('Expected an Ash model reference');
	}
	const contextKeys = accessor.get(IContextKeyService);
	const configuration = accessor.get(IConfigurationService);
	const canOpen = () => contextKeys.getValue(SessionsWorkspaceModeContext.key) === 'chat'
		&& contextKeys.getValue(chatGPTSelectedContext) === true
		&& !configuration.getValue<boolean>('chat.disableAIFeatures');
	if (!canOpen()) return;
	const chatGPT = accessor.get(IChatGPTService);
	const source = chatGPT.state.get().localConversationId;
	const revision = chatGPT.newDraftRevision;
	const commands = accessor.get(ICommandService);
	const scopes = accessor.get(ISessionProviderScopeService);
	const sessions = accessor.get(ISessionsService);
	const management = accessor.get(ISessionsManagementService);
	const storage = accessor.get(IStorageService);
	const layout = accessor.get(ILayoutService);
	const selection = { provider: model.provider, model: model.model };
	const scope = scopes.getProviderScope(LOCAL_AGENT_HOST_PROVIDER_ID);
	scope.assertCurrent();
	const models = await scope.services.models.listModels();
	scope.assertCurrent();
	const state = chatGPT.state.get();
	if (!canOpen() || state.localConversationId !== source || chatGPT.newDraftRevision !== revision || !canUseCodeModels(state)
		|| state.sending || state.managing || state.voice !== 'idle') return;
	if (!models.some(entry => entry.model.provider === selection.provider && entry.model.model === selection.model)) {
		throw new Error(localize('sessions.newChatModel.unavailable', 'The selected model is no longer available.'));
	}

	const draft = management.createUntitledSession(undefined, undefined, LOCAL_AGENT_HOST_PROVIDER_ID, false);
	const identity = `untitled:${draft.untitledSessionId}`;
	try {
		management.setUntitledSessionModel(draft.untitledSessionId, selection);
		if (state.draft.trim()) {
			writeNewChatDraftState(storage, { text: state.draft, mode: 'agent', contexts: [] }, identity, chatInputStatePersistence);
		}
		await commands.executeCommand(SHOW_ASH_CHAT_COMMAND);
	} catch (error) {
		management.discardUntitledSession(draft.untitledSessionId);
		writeNewChatDraftState(storage, undefined, identity, chatInputStatePersistence);
		throw error;
	}
	sessions.openUntitledSession(draft.untitledSessionId);
	layout.focus();
});
