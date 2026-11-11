import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import type { ModelRef } from '../../../../../platform/models/common/agentModels.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import * as chatInputStatePersistence from '../../../../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { ISessionProviderScopeService } from '../../../../browser/agentHost/sessionProviderScopeService.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../../common/agentHostSessionsProvider.js';
import type { ArtifactKind } from '../../../../common/artifactKind.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { SHOW_ASH_CHAT_COMMAND } from '../../common/constants.js';
import { writeNewChatDraftState } from '../../common/newChatDraftState.js';

/** The source revalidates its draft after model discovery and returns undefined if the handoff is stale. */
export async function openAshChatWithModel(accessor: ServicesAccessor, selection: ModelRef, readDraft: () => { readonly text: string; readonly artifactKind?: ArtifactKind; } | undefined): Promise<void> {
	const commands = accessor.get(ICommandService);
	const scopes = accessor.get(ISessionProviderScopeService);
	const view = accessor.get(ISessionsService);
	const sessions = accessor.get(ISessionsManagementService);
	const storage = accessor.get(IStorageService);
	const scope = scopes.getProviderScope(LOCAL_AGENT_HOST_PROVIDER_ID);
	scope.assertCurrent();
	const languageModels = scope.services.models;
	const models = await languageModels.listModelCatalog();
	scope.assertCurrent();
	const draft = readDraft();
	if (!draft) return;
	if (!languageModels.isModelVisible(selection) || !models.some(entry => entry.model.provider === selection.provider && entry.model.model === selection.model)) {
		throw new Error(localize('sessions.newChatModel.unavailable', 'The selected model is no longer available.'));
	}

	await commands.executeCommand(SHOW_ASH_CHAT_COMMAND);
	view.openChatDraft(selection, id => {
		if (draft.text.trim()) writeNewChatDraftState(storage, { text: draft.text, mode: 'agent', contexts: [] }, `ash-chat:untitled:${id}`, chatInputStatePersistence);
		if (draft.artifactKind) sessions.setUntitledSessionArtifactKind(id, draft.artifactKind);
	});
}
