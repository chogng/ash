export type TeamRole =
	| { readonly type: 'default' }
	| { readonly type: 'exact'; readonly name: string; readonly source: { readonly type: 'builtIn' } | { readonly type: 'directory'; readonly id: string } };

export interface TeamMember {
	readonly agentId: string;
	readonly name: string;
	readonly responsibility: string;
	readonly role: TeamRole;
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
	| { readonly type: 'create'; readonly name: string; readonly description: string; readonly coordinatorId: string; readonly members: readonly TeamMember[] }
	| { readonly type: 'updateDetails'; readonly name: string; readonly description: string }
	| { readonly type: 'addMember' | 'updateMember'; readonly member: TeamMember }
	| { readonly type: 'removeMember' | 'setCoordinator'; readonly agentId: string }
	| { readonly type: 'archive' | 'restore' };
