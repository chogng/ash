import { createUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import type { ModelRef } from '../../../../../platform/models/common/agentModels.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import * as chatInputStatePersistence from '../../../../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { ISessionProviderScopeService } from '../../../../browser/agentHost/sessionProviderScopeService.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../../common/agentHostSessionsProvider.js';
import { IAshChatSelectionService } from '../../browser/ashChatSelectionService.js';
import { SHOW_ASH_CHAT_COMMAND } from '../../common/constants.js';
import { writeNewChatDraftState } from '../../common/newChatDraftState.js';

/** The source revalidates its draft after model discovery and returns undefined if the handoff is stale. */
export async function openAshChatWithModel(accessor: ServicesAccessor, selection: ModelRef, readDraftText: () => string | undefined): Promise<void> {
	const commands = accessor.get(ICommandService);
	const scopes = accessor.get(ISessionProviderScopeService);
	const chat = accessor.get(IAshChatSelectionService);
	const storage = accessor.get(IStorageService);
	const scope = scopes.getProviderScope(LOCAL_AGENT_HOST_PROVIDER_ID);
	scope.assertCurrent();
	const languageModels = scope.services.models;
	const models = await languageModels.listModelCatalog();
	scope.assertCurrent();
	const text = readDraftText();
	if (text === undefined) return;
	if (!languageModels.isModelVisible(selection) || !models.some(entry => entry.model.provider === selection.provider && entry.model.model === selection.model)) {
		throw new Error(localize('sessions.newChatModel.unavailable', 'The selected model is no longer available.'));
	}

	const draft = { kind: 'draft', id: createUuid(), model: selection } as const;
	const identity = `ash-chat:untitled:${draft.id}`;
	const previous = chat.selection.get();
	try {
		if (text.trim()) writeNewChatDraftState(storage, { text, mode: 'agent', contexts: [] }, identity, chatInputStatePersistence);
		chat.select(draft);
		await commands.executeCommand(SHOW_ASH_CHAT_COMMAND);
	} catch (error) {
		if (chat.selection.get() === draft) chat.select(previous);
		writeNewChatDraftState(storage, undefined, identity, chatInputStatePersistence);
		throw error;
	}
}
