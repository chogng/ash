import type {
	TeamCommandParams, TeamCommandResult, TeamListResult, TeamMessageListParams, TeamMessageListResult,
	TeamMessagePostParams, TeamMessagePostResult, TeamReadParams, TeamReadResult,
	TeamRunListParams, TeamRunListResult, TeamRunReadParams, TeamRunReadResult,
	TeamRunAttachParams, TeamRunStartParams, TeamRunStartResult,
} from '../../app-server/common/generated/index.js';

/** Product-host Team operations exposed to browser and Electron renderers. */
export interface ITeamApi {
	list(): Promise<TeamListResult>;
	read(params: TeamReadParams): Promise<TeamReadResult>;
	command(params: TeamCommandParams): Promise<TeamCommandResult>;
	startRun(params: TeamRunStartParams): Promise<TeamRunStartResult>;
	attachRun(params: TeamRunAttachParams): Promise<TeamRunStartResult>;
	readRun(params: TeamRunReadParams): Promise<TeamRunReadResult>;
	listRuns(params: TeamRunListParams): Promise<TeamRunListResult>;
	postMessage(params: TeamMessagePostParams): Promise<TeamMessagePostResult>;
	listMessages(params: TeamMessageListParams): Promise<TeamMessageListResult>;
}
