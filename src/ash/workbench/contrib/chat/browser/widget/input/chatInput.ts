import type { IChatToolInvocation } from '../../../common/chatService/chatService.js';
import type { ChatRequestQueueKind, ChatContextUsage } from '../../../../../services/chat/common/chatService.js';
import type { AgentInteractionDecision, ApprovalMode, ChatAgent, ChatMode, ModelCatalogEntry, SkillSelectorDefinition, SlashCommandDefinition, TurnInteraction, TurnChangeSetSummary } from '../../../../../services/chat/common/chatService.js';
import type { SkillReference } from '../../../../../../platform/agentHost/common/appServerApi.js';
import type { ModelRef } from '../../../../../services/chat/common/chatService.js';
import type { ModelReasoningEffort } from '../../../../../services/chat/common/modelCatalog.js';
import type { ChatContextAttachment } from '../../../../../services/chat/common/chatContextService.js';

import type { ChatChangedFileTarget } from '../../../common/chat.js';
import type { ThreadChangesSummary } from '../../../../../services/chat/common/chatService.js';

/** Line totals can be partial when the Git provider cannot read some workspace files. */
export type ChatChangesStatistics = TurnChangeSetSummary['statistics'] & { readonly partial?: boolean; };

export type ChatInputPhase = 'loading' | 'ready' | 'submitting' | 'error';

export interface ChatInputCommandInvocation {
	readonly commandId: string;
	readonly argumentsText: string;
}

export interface ChatInputServerCommandInvocation {
	readonly name: string;
	readonly argumentsText: string;
}

/** A conversation-owned draft includes locally staged files and their readiness to send. */
export interface IChatInputDraft {
	readonly text: string;
	readonly readOnly: boolean;
	readonly canAttachFiles: boolean;
	readonly files: readonly {
		readonly id: string;
		readonly name: string;
		readonly size?: number;
		readonly status: 'uploading' | 'ready' | 'failed';
		readonly error?: string;
	}[];
}

/** State required to render the input area for the selected Thread. */
export interface ChatInputState {
	readonly draft?: IChatInputDraft;
	readonly status?: string;
	readonly conversation?: { readonly sessionId: string; readonly threadId: string; };
	readonly followups?: { readonly responseId: string; readonly prompts: readonly string[]; };
	/** Generation changes on navigation, but stays stable when first send materializes a draft. */
	readonly draftIdentity?: { readonly id: string; readonly generation: number; };
	readonly mode: ChatMode;
	readonly activeMode?: ChatMode;
	readonly queuedMessages: number;
	readonly phase: ChatInputPhase;
	/** Keeps the draft editable when history or the window's AI preference prevents sending. */
	readonly inputBlocked?: boolean;
	readonly aiDisabled?: boolean;
	readonly error?: string;
	readonly canInterrupt: boolean;
	readonly interruptKind?: 'reply';
	readonly approvalMode: ApprovalMode;
	readonly contextUsage?: ChatContextUsage;
	readonly changes?: ChatChangesStatistics;
	readonly changesRevision?: string;
	readonly changesRepositories?: ThreadChangesSummary['repositories'];
	readonly changesScope?: 'workspace' | 'conversation';
	readonly changesError?: string;
	readonly models: readonly ModelCatalogEntry[];
	readonly canSelectModel?: boolean;
	readonly modelsError?: string;
	readonly slashCommands: readonly SlashCommandDefinition[];
	readonly skillSelectors: readonly SkillSelectorDefinition[];
	/** Skill discovery can still be pending after model selection is ready. */
	readonly skillSelectorsLoading?: boolean;
	readonly selectedModel?: ModelRef;
	/** Catalog metadata for the current model, including one hidden from the picker list. */
	readonly selectedModelEntry?: ModelCatalogEntry;
	readonly selectedReasoningEffort?: ModelReasoningEffort;
	readonly selectedPreset?: string;
	readonly isAutomaticModel: boolean;
	readonly selectedAgent?: ChatAgent;
	readonly agentName?: string;
	readonly canSelectAgent: boolean;
	readonly interaction?: TurnInteraction;
	/** Readable pending identity, which may outlive the connection's actionable offer. */
	readonly pendingUserInputRequestId?: string;
	readonly toolInvocation?: IChatToolInvocation;
	readonly toolInvocations?: readonly IChatToolInvocation[];
}

/** Operations that the input area may request from its owning Chat pane. */
export interface ChatInputDelegate {
	/** This host shows request progress in its transcript. */
	readonly responseProgressInTranscript?: boolean;
	readonly draft?: {
		setText(text: string): void;
		/** Completes when the files are added to the draft. Any remote upload continues independently. */
		attachFiles(files: readonly File[]): Promise<void>;
		/** Reads the original staged image from the current draft for local display. */
		readImage?(id: string): Promise<Blob | undefined>;
		retryFile(id: string): Promise<void>;
		removeFile(id: string): void;
	};
	readonly voiceConversation?: { readonly isAvailable: boolean; readonly isActive: boolean; readonly isConnecting?: boolean; readonly isConnected: boolean; readonly connectedPlaceholder?: string; toggle(): Promise<void>; interrupt(): Promise<void>; };
	/** Carries the original composer lifetime through the host’s asynchronous context resolution. */
	send(text: string, mode: ChatMode, skills?: readonly SkillReference[], contexts?: readonly ChatContextAttachment[], submissionSignal?: AbortSignal, queue?: ChatRequestQueueKind): Promise<void>;
	sendInBackground?(text: string, mode: ChatMode, skills: readonly SkillReference[] | undefined, contexts: readonly ChatContextAttachment[], submissionSignal: AbortSignal): Promise<void>;
	executeCommand(invocation: ChatInputCommandInvocation): Promise<void>;
	/** Code supplies this capability; other hosts keep slash text literal and install no command UI. */
	executeServerCommand?(invocation: ChatInputServerCommandInvocation, submissionSignal?: AbortSignal): Promise<void>;
	interrupt(): Promise<void>;
	openChanges?(revision?: string, file?: ChatChangedFileTarget): Promise<void>;
	readWorkspaceChanges?(): Promise<ChatChangesStatistics | undefined>;
	selectModel(model: ModelRef): Promise<void>;
	selectPreset?(presetId: string): Promise<void>;
	selectReasoningEffort(effort: ModelReasoningEffort | undefined): Promise<void>;
	selectAutomaticModel?(): Promise<void>;
	listAgents(): Promise<readonly ChatAgent[]>;
	selectAgent(agent: ChatAgent | undefined): void;
	selectMode(mode: ChatMode): void;
	selectApprovalMode?(mode: ApprovalMode): Promise<void>;
	openModelSettings(category?: 'models' | 'dictation'): Promise<void>;
	resolveInteraction(response: AgentInteractionDecision, expectedRequestId?: string): Promise<void>;
}
