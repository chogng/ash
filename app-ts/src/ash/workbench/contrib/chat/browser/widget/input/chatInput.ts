import type { AgentResponse, ApprovalMode, ChatAgent, ChatMode, ModelCatalogEntry, SkillSelectorDefinition, SlashCommandDefinition, TurnInteraction } from "../../../../../services/chat/common/chatService.js";
import type { SkillReference } from "../../../../../../platform/skills/common/skillApi.js";
import type { ModelRef } from "../../../../../services/chat/common/chatService.js";
import type { ModelReasoningEffort } from "../../../../../services/chat/common/modelCatalog.js";
import type { ChatContextAttachment } from "../../../../../services/chat/common/chatContextService.js";

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
	readonly mode: ChatMode;
	readonly activeMode?: ChatMode;
	readonly queuedMessages: number;
	readonly phase: ChatInputPhase;
	readonly error?: string;
	readonly canInterrupt: boolean;
	readonly approvalMode?: ApprovalMode;
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
	send(text: string, mode: ChatMode, skills?: readonly SkillReference[], contexts?: readonly ChatContextAttachment[]): Promise<void>;
	executeCommand(invocation: ChatInputCommandInvocation): Promise<void>;
	executeServerCommand(invocation: ChatInputServerCommandInvocation): Promise<void>;
	interrupt(): Promise<void>;
	selectModel(model: ModelRef): Promise<void>;
	selectReasoningEffort(effort: ModelReasoningEffort | undefined): Promise<void>;
	selectAutomaticModel(): Promise<void>;
	listAgents(): Promise<readonly ChatAgent[]>;
	selectAgent(agent: ChatAgent | undefined): void;
	selectMode(mode: ChatMode): void;
	openModelSettings(category?: 'models' | 'dictation'): Promise<void>;
	resolveInteraction(response: AgentResponse): Promise<void>;
}
