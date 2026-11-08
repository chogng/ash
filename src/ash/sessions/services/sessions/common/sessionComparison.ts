import type { ChatAgent, StartTurnOptions } from '../../../../workbench/services/chat/common/chatService.js';

export const OPEN_SESSION_COMPARISON_COMMAND_ID = 'sessions.openComparison';
export const COMPARE_AGENTS_TOOLS_ENABLED_SETTING = 'sessions.chat.compareAgents.tools.enabled';

export interface ComparisonThread {
	readonly sessionId: string;
	readonly threadId: string;
	readonly afterTurn?: string;
}

export type ComparisonParticipantSettings = Pick<StartTurnOptions, 'model' | 'reasoningEffort' | 'approvalMode'>;

export interface ComparisonAttemptConfiguration {
	readonly number: number;
	readonly agent: string;
	readonly settings?: ComparisonParticipantSettings;
}

export interface ComparisonAttempt extends ComparisonThread, ComparisonAttemptConfiguration { }

export interface ComparisonDecision {
	readonly topic: string;
	readonly recommended: number;
	readonly options: readonly { readonly attempt: number; readonly assessment: string; }[];
}

export interface ComparisonVerdict {
	readonly winner: number;
	readonly comparison: string;
	readonly validation: string;
	readonly quality: string;
	readonly solution: string;
	readonly decisions?: readonly ComparisonDecision[];
}

export interface SessionComparison {
	readonly id: string;
	readonly providerId: string;
	readonly source: ComparisonThread;
	readonly sourceSequence: number;
	readonly task: string;
	readonly isolated: boolean;
	readonly folderless?: boolean;
	readonly workspace?: string;
	readonly attempts: readonly ComparisonAttempt[];
	readonly failedAttempts?: readonly ComparisonAttemptConfiguration[];
	readonly judgeAgent?: ChatAgent;
	readonly judgeSettings?: ComparisonParticipantSettings;
	readonly synthesisAgent?: ChatAgent;
	readonly synthesisSettings?: ComparisonParticipantSettings;
	readonly judgeFailed?: boolean;
	readonly judge?: ComparisonThread;
	readonly synthesis?: ComparisonThread;
	readonly verdict?: ComparisonVerdict;
}
