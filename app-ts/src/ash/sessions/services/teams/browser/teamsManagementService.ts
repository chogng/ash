import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import { createUuid } from '../../../../base/common/uuid.js';
import type { Team, TeamMember, TeamMessage, TeamRole, TeamRun } from '../common/team.js';
import type { ITeamsProvider } from '../common/teamsProvider.js';
import type { ITeamsManagementService } from '../common/teamsManagement.js';

/** Owns Team catalog state and user commands in the Agents window. */
export class TeamsManagementService implements ITeamsManagementService {
	private readonly currentTeams = observableValue<readonly Team[]>('teams', []);
	readonly teams: IObservable<readonly Team[]> = this.currentTeams;

	constructor(private readonly provider: ITeamsProvider) { }

	async refresh(): Promise<void> {
		this.currentTeams.set(await this.provider.list());
	}

	async create(name: string, description: string, coordinatorName: string, responsibility: string, role: TeamRole = { type: 'default' }): Promise<Team> {
		const coordinator: TeamMember = { agentId: `agent:${createUuid()}`, name: coordinatorName, responsibility, role };
		const team = await this.provider.apply(`team-command:${createUuid()}`, `team:${createUuid()}`, 0, {
			type: 'create', name, description, coordinatorId: coordinator.agentId, members: [coordinator],
		});
		await this.refresh();
		return team;
	}

	async addMember(team: Team, name: string, responsibility: string, role: TeamRole = { type: 'default' }): Promise<Team> {
		const member: TeamMember = { agentId: `agent:${createUuid()}`, name, responsibility, role };
		return this.apply(team, { type: 'addMember', member });
	}

	async updateMember(team: Team, member: TeamMember): Promise<Team> { return this.apply(team, { type: 'updateMember', member }); }
	async updateDetails(team: Team, name: string, description: string): Promise<Team> { return this.apply(team, { type: 'updateDetails', name, description }); }
	async removeMember(team: Team, agentId: string): Promise<Team> { return this.apply(team, { type: 'removeMember', agentId }); }
	async setCoordinator(team: Team, agentId: string): Promise<Team> { return this.apply(team, { type: 'setCoordinator', agentId }); }
	async archive(team: Team): Promise<Team> { return this.apply(team, { type: 'archive' }); }
	async restore(team: Team): Promise<Team> { return this.apply(team, { type: 'restore' }); }

	async startRun(team: Team, objective: string): Promise<TeamRun> {
		return this.provider.startRun(`team-command:${createUuid()}`, `team-run:${createUuid()}`, team.teamId, team.revision, objective);
	}

	listRuns(teamId: string): Promise<readonly TeamRun[]> { return this.provider.listRuns(teamId); }
	listMessages(teamId: string, readerId: string): Promise<readonly TeamMessage[]> { return this.provider.listMessages(teamId, readerId); }
	postMessage(teamId: string, runId: string | null, senderId: string, receiverId: string | null, text: string): Promise<TeamMessage> {
		return this.provider.postMessage(`team-message:${createUuid()}`, teamId, runId, senderId, receiverId, text);
	}

	private async apply(team: Team, command: Parameters<ITeamsProvider['apply']>[3]): Promise<Team> {
		const changed = await this.provider.apply(`team-command:${createUuid()}`, team.teamId, team.revision, command);
		await this.refresh();
		return changed;
	}
}
