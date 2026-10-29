import type { IObservable } from '../../../../base/common/observable.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { Team, TeamMember, TeamMessage, TeamRole, TeamRun } from './team.js';

export interface ITeamsManagementService {
	readonly teams: IObservable<readonly Team[]>;
	refresh(): Promise<void>;
	create(name: string, description: string, coordinatorName: string, responsibility: string, role?: TeamRole): Promise<Team>;
	addMember(team: Team, name: string, responsibility: string, role?: TeamRole): Promise<Team>;
	updateMember(team: Team, member: TeamMember): Promise<Team>;
	updateDetails(team: Team, name: string, description: string): Promise<Team>;
	removeMember(team: Team, agentId: string): Promise<Team>;
	setCoordinator(team: Team, agentId: string): Promise<Team>;
	archive(team: Team): Promise<Team>;
	restore(team: Team): Promise<Team>;
	startRun(team: Team, objective: string): Promise<TeamRun>;
	listRuns(teamId: string): Promise<readonly TeamRun[]>;
	listMessages(teamId: string, readerId: string): Promise<readonly TeamMessage[]>;
	postMessage(teamId: string, runId: string | null, senderId: string, receiverId: string | null, text: string): Promise<TeamMessage>;
}

export const ITeamsManagementService = createServiceIdentifier<ITeamsManagementService>('teamsManagementService');
