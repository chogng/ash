import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../app-server/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import type { ITeamApi } from '../common/teamApi.js';

export function createAppServerTeamApi(connection: AppServerProtocolClient): ITeamApi {
	return {
		list: () => appServerRequest(connection, 'team/list', {}),
		read: params => appServerRequest(connection, 'team/read', params),
		command: params => appServerRequest(connection, 'team/command', params),
		startRun: params => appServerRequest(connection, 'team/run/start', params),
		attachRun: params => appServerRequest(connection, 'team/run/attach', params),
		readRun: params => appServerRequest(connection, 'team/run/read', params),
		listRuns: params => appServerRequest(connection, 'team/run/list', params),
		postMessage: params => appServerRequest(connection, 'team/message/post', params),
		listMessages: params => appServerRequest(connection, 'team/message/list', params),
	};
}

export function createDisconnectedTeamApi(unavailable: UnavailableOperation): ITeamApi {
	return {
		list: () => unavailable('team.list'),
		read: () => unavailable('team.read'),
		command: () => unavailable('team.command'),
		startRun: () => unavailable('team.startRun'),
		attachRun: () => unavailable('team.attachRun'),
		readRun: () => unavailable('team.readRun'),
		listRuns: () => unavailable('team.listRuns'),
		postMessage: () => unavailable('team.postMessage'),
		listMessages: () => unavailable('team.listMessages'),
	};
}
