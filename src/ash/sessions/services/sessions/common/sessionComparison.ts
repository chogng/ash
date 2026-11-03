import type { ChatAgent, StartTurnOptions } from '../../../../workbench/services/chat/common/chatService.js';

export interface ComparisonThread {
	readonly sessionId: string;
	readonly threadId: string;
	readonly afterTurn?: string;
}

export type ComparisonParticipantSettings = Pick<StartTurnOptions, 'model' | 'reasoningEffort' | 'approvalMode'>;

export interface ComparisonAttempt extends ComparisonThread {
	readonly number: number;
	readonly agent: string;
	readonly settings?: ComparisonParticipantSettings;
}

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
	readonly attempts: readonly ComparisonAttempt[];
	readonly judgeAgent?: ChatAgent;
	readonly judgeSettings?: ComparisonParticipantSettings;
	readonly synthesisAgent?: ChatAgent;
	readonly synthesisSettings?: ComparisonParticipantSettings;
	readonly judgeFailed?: boolean;
	readonly judge?: ComparisonThread;
	readonly synthesis?: ComparisonThread;
	readonly verdict?: ComparisonVerdict;
}
