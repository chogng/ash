import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import type { ModelRef } from '../../../../../platform/models/common/agentModels.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import * as chatInputStatePersistence from '../../../../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { ISessionProviderScopeService } from '../../../../browser/agentHost/sessionProviderScopeService.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../../common/agentHostSessionsProvider.js';
import { SHOW_ASH_CHAT_COMMAND } from '../../common/constants.js';
import { writeNewChatDraftState } from '../../common/newChatDraftState.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';

/** The source revalidates its draft after model discovery and returns undefined if the handoff is stale. */
export async function openAshChatWithModel(accessor: ServicesAccessor, selection: ModelRef, readDraftText: () => string | undefined): Promise<void> {
	const commands = accessor.get(ICommandService);
	const scopes = accessor.get(ISessionProviderScopeService);
	const sessions = accessor.get(ISessionsService);
	const management = accessor.get(ISessionsManagementService);
	const storage = accessor.get(IStorageService);
	const layout = accessor.get(ILayoutService);
	const scope = scopes.getProviderScope(LOCAL_AGENT_HOST_PROVIDER_ID);
	scope.assertCurrent();
	const models = await scope.services.models.listModels();
	scope.assertCurrent();
	const text = readDraftText();
	if (text === undefined) return;
	if (!models.some(entry => entry.model.provider === selection.provider && entry.model.model === selection.model)) {
		throw new Error(localize('sessions.newChatModel.unavailable', 'The selected model is no longer available.'));
	}

	const draft = management.createUntitledSession(undefined, undefined, LOCAL_AGENT_HOST_PROVIDER_ID, false);
	const identity = `untitled:${draft.untitledSessionId}`;
	try {
		management.setUntitledSessionModel(draft.untitledSessionId, selection);
		if (text.trim()) {
			writeNewChatDraftState(storage, { text, mode: 'agent', contexts: [] }, identity, chatInputStatePersistence);
		}
		await commands.executeCommand(SHOW_ASH_CHAT_COMMAND);
	} catch (error) {
		management.discardUntitledSession(draft.untitledSessionId);
		writeNewChatDraftState(storage, undefined, identity, chatInputStatePersistence);
		throw error;
	}
	sessions.openUntitledSession(draft.untitledSessionId);
	layout.focus();
}
