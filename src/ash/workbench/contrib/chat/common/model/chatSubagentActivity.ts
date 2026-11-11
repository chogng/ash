import { localize } from '../../../../../nls.js';
import type { AgentExecutionNode } from '../../../../../platform/agentHost/common/agent.js';

type ChatSubagentStatus = Pick<AgentExecutionNode, 'executionStatus' | 'waitingReason'>;

const statusLabels: Record<ChatSubagentStatus['executionStatus'], () => string> = {
	idle: () => localize('chat.subagent.idle', 'Idle'),
	queued: () => localize('chat.subagent.queued', 'Queued'),
	running: () => localize('chat.subagent.running', 'Running'),
	waiting: () => localize('chat.subagent.waiting', 'Waiting'),
	completed: () => localize('chat.subagent.completed', 'Completed'),
	failed: () => localize('chat.subagent.failed', 'Failed'),
	cancelled: () => localize('chat.subagent.cancelled', 'Cancelled'),
};

const waitingLabels: Record<NonNullable<ChatSubagentStatus['waitingReason']>, () => string> = {
	approval: () => localize('chat.subagent.waitingApproval', 'Waiting for approval'),
	userInput: () => localize('chat.subagent.waitingUserInput', 'Waiting for an answer'),
	capability: () => localize('chat.subagent.waitingCapability', 'Waiting for a capability'),
};

export function chatSubagentStatusLabel(activity: ChatSubagentStatus): string {
	return activity.executionStatus === 'waiting' && activity.waitingReason ? waitingLabels[activity.waitingReason]() : statusLabels[activity.executionStatus]();
}
