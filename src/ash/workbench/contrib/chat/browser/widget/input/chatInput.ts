import type { ChatContextUsage } from '../../../../../services/chat/common/chatService.js';
import type { AgentResponse, ApprovalMode, ChatAgent, ChatMode, ModelCatalogEntry, SkillSelectorDefinition, SlashCommandDefinition, TurnInteraction, TurnChangeSetSummary } from "../../../../../services/chat/common/chatService.js";
import type { SkillReference } from "../../../../../../platform/agentHost/common/appServerApi.js";
import type { ModelRef } from "../../../../../services/chat/common/chatService.js";
import type { ModelReasoningEffort } from "../../../../../services/chat/common/modelCatalog.js";
import type { ChatContextAttachment } from "../../../../../services/chat/common/chatContextService.js";

import type { ICommandService } from '../../../../../../platform/commands/common/commands.js';

/** Line totals can be partial when the Git provider cannot read some workspace files. */
export type ChatChangesStatistics = TurnChangeSetSummary['statistics'] & { readonly partial?: boolean; };

export type ChatInputPhase = "loading" | "ready" | "submitting" | "error";

export interface ChatInputCommandInvocation {
	readonly commandId: string;
	readonly argumentsText: string;
}

export interface ChatInputServerCommandInvocation {
	readonly name: string;
	readonly argumentsText: string;
}

/** State required to render the input area for the selected Thread. */
export interface ChatInputState {
	readonly conversation?: { readonly sessionId: string; readonly threadId: string; };
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
	readonly approvalMode: ApprovalMode;
	readonly contextUsage?: ChatContextUsage;
	readonly changes?: ChatChangesStatistics;
	readonly changesRevision?: string;
	readonly changesScope?: 'workspace' | 'conversation';
	readonly changesError?: string;
	readonly models: readonly ModelCatalogEntry[];
	readonly modelsError?: string;
	readonly slashCommands: readonly SlashCommandDefinition[];
	readonly skillSelectors: readonly SkillSelectorDefinition[];
	readonly selectedModel?: ModelRef;
	readonly selectedReasoningEffort?: ModelReasoningEffort;
	readonly isAutomaticModel: boolean;
	readonly selectedAgent?: ChatAgent;
	readonly agentName?: string;
	readonly canSelectAgent: boolean;
	readonly interaction?: TurnInteraction;
}

/** Operations that the input area may request from its owning Chat pane. */
export interface ChatInputDelegate {
	readonly voiceConversation?: { readonly isAvailable: boolean; readonly isActive: boolean; readonly isConnected: boolean; toggle(): Promise<void>; interrupt(): Promise<void>; };
	/** Carries the original composer lifetime through the host’s asynchronous context resolution. */
	send(text: string, mode: ChatMode, skills?: readonly SkillReference[], contexts?: readonly ChatContextAttachment[], submissionSignal?: AbortSignal): Promise<void>;
	executeCommand(invocation: ChatInputCommandInvocation): Promise<void>;
	executeServerCommand(invocation: ChatInputServerCommandInvocation, submissionSignal?: AbortSignal): Promise<void>;
	interrupt(): Promise<void>;
	openChanges?(revision?: string): Promise<void>;
	readWorkspaceChanges?(): Promise<ChatChangesStatistics | undefined>;
	selectModel(model: ModelRef): Promise<void>;
	selectReasoningEffort(effort: ModelReasoningEffort | undefined): Promise<void>;
	selectAutomaticModel(): Promise<void>;
	listAgents(): Promise<readonly ChatAgent[]>;
	selectAgent(agent: ChatAgent | undefined): void;
	selectMode(mode: ChatMode): void;
	selectApprovalMode?(mode: ApprovalMode): Promise<void>;
	openModelSettings(category?: 'models' | 'dictation'): Promise<void>;
	resolveInteraction(response: AgentResponse): Promise<void>;
}

/** Validates the optional Git extension's command result at its process boundary. */
export async function readWorkspaceChanges(commands: ICommandService): Promise<ChatChangesStatistics | undefined> {
	let result: unknown;
	try {
		result = await commands.executeCommand('git.getChangesSummary');
	} catch (error) {
		if (error instanceof Error && error.message === 'Unknown command: git.getChangesSummary') return undefined;
		throw error;
	}
	if (!result || typeof result !== 'object') throw new TypeError('Invalid workspace changes summary');
	const value = result as Record<string, unknown>;
	for (const key of ['files', 'additions', 'deletions']) {
		if (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 0) throw new TypeError('Invalid workspace change statistics');
	}
	if (value.partial !== undefined && typeof value.partial !== 'boolean') throw new TypeError('Invalid workspace change coverage');
	return { files: value.files as number, additions: value.additions as number, deletions: value.deletions as number, partial: value.partial === true };
}
