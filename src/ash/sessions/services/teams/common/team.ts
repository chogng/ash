import type { AgentRoleSource } from '../../../../platform/agentHost/common/agent.js';

export type TeamRole =
	| { readonly type: 'default'; }
	| { readonly type: 'exact'; readonly name: string; readonly source: AgentRoleSource; };

export interface TeamMember {
	readonly agentId: string;
	readonly name: string;
	readonly responsibility: string;
	readonly role: TeamRole;
}

export interface ProjectBot {
	readonly projectId: string;
	readonly projectName: string;
	readonly member: TeamMember;
}

export function projectBotKind(role: TeamRole): 'advisor' | 'reviewer' | 'agent' {
	if (role.type === 'exact' && role.source.type === 'builtIn') {
		if (role.name === 'advisor' || role.name === 'reviewer') return role.name;
	}
	return 'agent';
}

/** Project Bot handles stay stable across locale changes and Team member display names. */
export function projectBotHandle(role: TeamRole): string {
	if (role.type === 'default') return 'Ash';
	if (role.source.type === 'builtIn') {
		if (role.name === 'advisor') return 'Advisor';
		if (role.name === 'reviewer') return 'CodeReview';
		if (role.name === 'issue') return 'Issue';
	}
	return role.name;
}

export interface Team {
	readonly teamId: string;
	readonly revision: number;
	readonly status: 'active' | 'archived';
	readonly name: string;
	readonly description: string;
	readonly coordinatorId: string;
	readonly members: readonly TeamMember[];
}

export interface TeamRun {
	readonly runId: string;
	readonly teamId: string;
	readonly teamRevision: number;
	readonly members: readonly TeamMember[];
	readonly coordinatorId: string;
	readonly sessionId: string;
	readonly coordinatorThreadId: string;
	readonly objective: string;
}

export interface TeamMessage {
	readonly messageId: string;
	readonly teamId: string;
	readonly runId: string | null;
	readonly senderId: string;
	readonly receiverId: string | null;
	readonly text: string;
	readonly createdAtUnixMs: number;
}

export type TeamCommand =
	| { readonly type: 'create'; readonly name: string; readonly description: string; readonly coordinatorId: string; readonly members: readonly TeamMember[]; }
	| { readonly type: 'updateDetails'; readonly name: string; readonly description: string; }
	| { readonly type: 'addMember' | 'updateMember'; readonly member: TeamMember; }
	| { readonly type: 'removeMember' | 'setCoordinator'; readonly agentId: string; }
	| { readonly type: 'archive' | 'restore'; };
