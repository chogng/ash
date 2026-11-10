import type { SkillReference } from '../../../../platform/agentHost/common/appServerApi.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import type { ModelRef } from '../../../../platform/models/common/agentModels.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import type { ResolvedChatContext } from '../../../../workbench/services/chat/common/chatContextService.js';
import { ChatRequestQueueKind, type ChatMode, type ChatSubmissionOptions } from '../../../../workbench/services/chat/common/chatService.js';
import { modelRefIdentity } from '../../../../workbench/services/chat/common/modelCatalog.js';
import { ISessionPrimaryProviderServices, type SessionProviderServices } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { ChatWidgetModel, type ChatWidgetSelection } from '../../../browser/chatWidgetModel.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

/** Ash Chat's conversation policy, shared by the reply editor and project composer. */
export class AshChatModel extends ChatWidgetModel {
	readonly memoryNamespace = 'chat' as const;
	protected override get useCodeModelDefaults(): boolean { return false; }
	protected override get commandInterpretation(): 'literal' { return 'literal'; }
	protected override get isCodeConversation(): boolean { return false; }
	override get mode(): ChatMode { return 'agent'; }
	override get isAutomaticModel(): boolean { return false; }

	constructor(
		selection: ChatWidgetSelection,
		@ISessionsManagementService management: ISessionsManagementService,
		@ISessionPrimaryProviderServices primary: SessionProviderServices,
		@IConfigurationService configuration: IConfigurationService,
		@IStorageService storage: IStorageService,
		@IContextKeyService contexts: IContextKeyService,
	) {
		super(primary.chat, selection, management, primary.prompts, primary.models, primary.execution, configuration, storage, contexts);
	}

	override get inputState() {
		const state = super.inputState;
		return {
			...state, canSelectModel: state.phase !== 'submitting', canSelectAgent: false, slashCommands: [], skillSelectors: [],
			inputBlocked: state.inputBlocked || !state.selectedModel || !state.models.some(entry => modelRefIdentity(entry.model) === modelRefIdentity(state.selectedModel!)),
		};
	}

	override async selectModel(model: ModelRef): Promise<void> {
		const generation = this.composerGeneration;
		await super.selectModel(model);
		if (generation === this.composerGeneration) await super.selectReasoningEffort(undefined);
	}

	override send(text: string, _mode: ChatMode, _skills?: readonly SkillReference[], contexts?: readonly ResolvedChatContext[], options?: ChatSubmissionOptions): Promise<void> {
		return super.send(text, 'agent', undefined, contexts, {
			...options, queue: options?.queue ?? ChatRequestQueueKind.Queued,
		});
	}
}
