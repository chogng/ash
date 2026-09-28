import type { Team, TeamCommand, TeamMessage, TeamRun } from './team.js';

export interface ITeamsProvider {
	list(): Promise<readonly Team[]>;
	apply(commandId: string, teamId: string, expectedRevision: number, command: TeamCommand): Promise<Team>;
	startRun(commandId: string, runId: string, teamId: string, expectedRevision: number, objective: string): Promise<TeamRun>;
	listRuns(teamId: string): Promise<readonly TeamRun[]>;
	listMessages(teamId: string, readerId: string): Promise<readonly TeamMessage[]>;
	postMessage(messageId: string, teamId: string, runId: string | null, senderId: string, receiverId: string | null, text: string): Promise<TeamMessage>;
}
