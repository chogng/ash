import { Event } from '../../../base/common/event.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../agentHost/browser/disconnectedAppServer.js';
import type { ICodebaseApi } from '../common/codebaseApi.js';

export function createDisconnectedCodebaseApi(unavailable: UnavailableOperation): ICodebaseApi {
	return {
		onDidChangeConfig: Event.None,
		readConfig: () => unavailable('codebase.readConfig'),
		configure: () => unavailable('codebase.configure'),
		status: () => unavailable('codebase.status'),
	};
}

export function createAppServerCodebaseApi(connection: AppServerProtocolClient): ICodebaseApi {
	return {
		onDidChangeConfig: (listener, thisArgs, disposables) => {
			const subscription = connection.onNotification(event => {
				if (event.method === 'config/changed') { listener.call(thisArgs); }
			});
			if (Array.isArray(disposables)) { disposables.push(subscription); }
			else { disposables?.add(subscription); }
			return subscription;
		},
		readConfig: () => appServerRequest(connection, 'config/read', {}),
		configure: params => appServerRequest(connection, 'codebase/configure', params),
		status: () => appServerRequest(connection, 'codebase/status', {}),
	};
}
