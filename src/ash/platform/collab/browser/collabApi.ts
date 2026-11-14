import type { ICollabApi } from '../common/collabApi.js';
import type { UnavailableOperation } from '../../agentHost/browser/disconnectedAppServer.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';

export function createDisconnectedCollabApi(unavailable: UnavailableOperation): ICollabApi {
	return {
		readStatus: () => unavailable('collab.readStatus'),
		open: () => unavailable('collab.open'),
		submit: () => unavailable('collab.submit'),
		publishPresence: () => unavailable('collab.publishPresence'),
		readPresence: () => unavailable('collab.readPresence'),
	};
}

export function createAppServerCollabApi(connection: AppServerProtocolClient): ICollabApi {
	return {
		readStatus: params => appServerRequest(connection, 'document/collaboration/status', params),
		open: params => appServerRequest(connection, 'document/collaboration/open', params),
		submit: params => appServerRequest(connection, 'document/collaboration/submit', params),
		publishPresence: params => appServerRequest(connection, 'document/collaboration/presence/publish', params),
		readPresence: params => appServerRequest(connection, 'document/collaboration/presence/read', params),
	};
}
