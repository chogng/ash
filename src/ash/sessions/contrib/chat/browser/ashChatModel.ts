import type { SkillReference } from '../../../../platform/agentHost/common/appServerApi.js';
import { IAgentExecutionSettingsService } from '../../../../platform/agentHost/common/agentExecutionSettingsService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import type { ModelRef, ModelReasoningEffort } from '../../../../platform/models/common/agentModels.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import type { ResolvedChatContext } from '../../../../workbench/services/chat/common/chatContextService.js';
import { ChatRequestQueueKind, IChatService, type ChatMode, type ChatSubmissionOptions } from '../../../../workbench/services/chat/common/chatService.js';
import { ILanguageModelsService } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { IPromptsService } from '../../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { modelRefIdentity } from '../../../../workbench/services/chat/common/modelCatalog.js';
import { ChatWidgetModel, type ChatWidgetSelection } from '../../../browser/chatWidgetModel.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import type { IUntitledChatSession } from '../../../services/sessions/common/session.js';
import { INativeChatModelPreferencesService } from '../common/nativeChatModelPreferencesService.js';

/** Ash Chat's conversation policy for the Session pane, reply editor and projects. */
export class AshChatModel extends ChatWidgetModel {
	// The Session pane can show a Code thread without modifying its remembered Code choices.
	private sessionDraftModel: ModelRef | null | undefined;
	private sessionDraftEffort: ModelReasoningEffort | undefined;
	private preferredDraftModel: ModelRef | undefined;

	get memoryNamespace() { return this.presentation === 'session' ? this.session?.kind : 'chat'; }
	protected override get useCodeModelDefaults(): boolean { return false; }
	protected override get initializeInConstructor(): boolean { return false; }
	protected override get commandInterpretation(): 'literal' { return 'literal'; }
	protected override get isCodeConversation(): boolean { return false; }
	protected override get useSkillSelectors(): boolean { return this.presentation === 'session'; }
	protected override get snapshotHistory() { return this.presentation === 'session' ? undefined : super.snapshotHistory; }
	protected override get submissionApprovalMode() { return this.presentation === 'session' ? this.inputState.approvalMode : super.submissionApprovalMode; }
	override get mode(): ChatMode { return this.presentation === 'session' ? super.mode : 'agent'; }
	override get isAutomaticModel(): boolean { return this.presentation === 'session' && super.isAutomaticModel; }

	constructor(
		selection: ChatWidgetSelection,
		private readonly presentation: 'session' | 'compact',
		@ISessionsManagementService management: ISessionsManagementService,
		@IChatService chat: IChatService,
		@IPromptsService prompts: IPromptsService,
		@ILanguageModelsService models: ILanguageModelsService,
		@IAgentExecutionSettingsService execution: IAgentExecutionSettingsService,
		@IConfigurationService configuration: IConfigurationService,
		@IStorageService storage: IStorageService,
		@IContextKeyService contexts: IContextKeyService | undefined,
		@INativeChatModelPreferencesService private readonly preferences: INativeChatModelPreferencesService | undefined,
	) {
		super(chat, selection, management, prompts, models, execution, configuration, storage, presentation === 'compact' ? contexts : undefined);
		if (preferences) this._register(preferences.onDidChangeModels(() => {
			this.applyDefaultNewChatModel();
			this.notifyModelChoicesChanged();
		}));
		void this.initialize();
	}

	override get inputState() {
		const state = super.inputState;
		if (this.presentation === 'session') return state;
		return {
			...state, canSelectModel: state.phase !== 'submitting', canSelectAgent: false, slashCommands: [], skillSelectors: [],
			inputBlocked: state.inputBlocked || !state.selectedModel || !state.models.some(entry => modelRefIdentity(entry.model) === modelRefIdentity(state.selectedModel!)),
		};
	}

	protected override readDraftModel(draft: IUntitledChatSession) {
		if (this.presentation === 'session') {
			const model = this.sessionDraftModel === undefined ? this.preferredDraftModel ?? null : this.sessionDraftModel;
			return { model, effort: this.sessionDraftEffort };
		}
		const selected = super.readDraftModel(draft);
		return selected.model || draft.modelSelectionKind === 'manual' ? selected : { ...selected, model: this.preferredDraftModel ?? null };
	}

	protected override applyDefaultNewChatModel(): void {
		this.preferredDraftModel = this.preferences?.getDefaultNewChatModel(this.models);
	}

	protected override selectDraftModel(draft: IUntitledChatSession, model: ModelRef | undefined): void {
		if (this.presentation === 'session') this.sessionDraftModel = model ?? null;
		else super.selectDraftModel(draft, model);
	}

	protected override selectDraftEffort(draft: IUntitledChatSession, effort: ModelReasoningEffort | undefined): void {
		if (this.presentation === 'session') {
			this.sessionDraftEffort = effort;
			this.notifyModelChoicesChanged();
		} else super.selectDraftEffort(draft, effort);
	}

	override async selectModel(model: ModelRef): Promise<void> {
		const generation = this.composerGeneration;
		await super.selectModel(model);
		if (this.isDisposed || generation !== this.composerGeneration) return;
		if (this.presentation === 'compact') await super.selectReasoningEffort(undefined);
		if (!this.isDisposed && generation === this.composerGeneration && (this.presentation === 'session' || this.untitledSessionId)) this.preferences?.rememberSelectedModel(model);
	}

	override async selectAutomaticModel(): Promise<void> {
		await super.selectAutomaticModel();
		if (!this.isDisposed && this.presentation === 'session') this.preferences?.rememberSelectedModel(undefined);
	}

	override send(text: string, mode: ChatMode = this.mode, skills?: readonly SkillReference[], contexts?: readonly ResolvedChatContext[], options?: ChatSubmissionOptions): Promise<void> {
		if (this.presentation === 'session') return super.send(text, mode, skills, contexts, options);
		return super.send(text, 'agent', undefined, contexts, {
			...options, queue: options?.queue ?? ChatRequestQueueKind.Queued,
		});
	}
}
