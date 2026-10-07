import type { TeamCommandDto, TeamDto, TeamMessageDto, TeamRunDto } from '../../../../../platform/app-server/common/generated/index.js';
import type { ITeamApi } from '../../../../../platform/teams/common/teamApi.js';
import type { Team, TeamCommand, TeamMessage, TeamRun } from '../../../../services/teams/common/team.js';
import type { ITeamsProvider } from '../../../../services/teams/common/teamsProvider.js';

/** Keeps generated App Server records inside the provider boundary. */
export class AppServerTeamsProvider implements ITeamsProvider {
	constructor(private readonly api: ITeamApi) { }

	async list(): Promise<readonly Team[]> {
		return (await this.api.list()).teams.map(team);
	}

	async apply(commandId: string, teamId: string, expectedRevision: number, command: TeamCommand): Promise<Team> {
		const result = await this.api.command({ commandId, teamId, expectedRevision, command: command as TeamCommandDto });
		return team(result.team);
	}

	async startRun(commandId: string, runId: string, teamId: string, expectedRevision: number, objective: string): Promise<TeamRun> {
		return run((await this.api.startRun({ commandId, runId, teamId, expectedTeamRevision: expectedRevision, objective })).run);
	}

	async listRuns(teamId: string): Promise<readonly TeamRun[]> {
		return (await this.api.listRuns({ teamId })).runs.map(run);
	}

	async listMessages(teamId: string, readerId: string): Promise<readonly TeamMessage[]> {
		return (await this.api.listMessages({ teamId, readerId })).messages.map(message);
	}

	async postMessage(messageId: string, teamId: string, runId: string | null, senderId: string, receiverId: string | null, text: string): Promise<TeamMessage> {
		return message((await this.api.postMessage({ messageId, teamId, runId, senderId, receiverId, text })).message);
	}
}

function team(value: TeamDto): Team {
	return {
		teamId: value.teamId, revision: value.revision, status: value.status,
		name: value.name, description: value.description, coordinatorId: value.coordinatorId,
		members: value.members.map(member => ({ ...member })),
	};
}

function run(value: TeamRunDto): TeamRun {
	return {
		runId: value.runId, teamId: value.teamId, teamRevision: value.teamRevision,
		members: value.members.map(member => ({ ...member })), coordinatorId: value.coordinatorId,
		sessionId: value.sessionId, coordinatorThreadId: value.coordinatorThreadId, objective: value.objective,
	};
}

function message(value: TeamMessageDto): TeamMessage {
	return {
		messageId: value.messageId, teamId: value.teamId, runId: value.runId,
		senderId: value.senderId, receiverId: value.receiverId, text: value.text,
		createdAtUnixMs: value.createdAtUnixMs
	};
}
