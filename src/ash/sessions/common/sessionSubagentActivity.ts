import { chatToolResultPresentation } from '../../workbench/contrib/chat/common/chatService/chatService.js';
import type { IChatListItem } from '../../workbench/contrib/chat/common/model/chatViewModel.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from './agentHostSessionsProvider.js';
import { findAgentNode, type AgentTreeNode, type ISession } from '../services/sessions/common/session.js';
import { parseSessionIdentity } from '../services/sessions/common/sessionIdentity.js';

type SpawnedAgent = AgentTreeNode & { readonly origin: Extract<AgentTreeNode['origin'], { type: 'agentSpawn'; }>; };

export function directSessionSubagents(nodes: readonly AgentTreeNode[], threadId: string): readonly SpawnedAgent[] {
	return findAgentNode(nodes, threadId)?.children.filter((child): child is SpawnedAgent => child.origin.type === 'agentSpawn'
		&& child.origin.parentThreadId === threadId && child.membershipStatus === 'active') ?? [];
}

/** Only the exact, typed spawn result can display activity from a delegated child. */
export function withSessionSubagentActivities(items: readonly IChatListItem[], session: ISession | undefined, threadId: string | undefined): readonly IChatListItem[] {
	if (!session?.agentTree || !threadId) return items;
	const children = directSessionSubagents(session.agentTree, threadId);
	if (!children.length) return items;
	const byDelegation = new Map(children.map(child => [child.origin.delegationId, child]));
	return items.map(item => {
		const invocation = item.toolInvocation;
		if (!invocation) return item;
		const child = byDelegation.get(`tool:${invocation.call.toolCallId}`);
		if (!child) return item;
		const target = chatToolResultPresentation(invocation.result);
		const childId = session.backendSessionId ? parseSessionIdentity(child.threadId, LOCAL_AGENT_HOST_PROVIDER_ID).backendSessionId : child.threadId;
		if (target?.type !== 'sessionTarget' || target.threadId !== childId || target.sessionId !== (session.backendSessionId ?? session.sessionId)) return item;
		const { executionStatus, waitingReason, result } = child;
		return { ...item, toolInvocation: { ...invocation, subagentActivity: { executionStatus, waitingReason, result } } };
	});
}
