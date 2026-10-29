import type { AppServerProtocolClient } from './appServerProtocolClient.js';
import { appServerRequest } from './appServerRequest.js';
import type { IAgentToolsApi } from '../common/agentToolsApi.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import { Event } from '../../../base/common/event.js';

export function createAppServerAgentToolsApi(connection: AppServerProtocolClient): IAgentToolsApi {
	return {
		isAvailable: true,
		onDidChangeTools: (listener, thisArgs, disposables) => {
			const subscription = connection.onNotification(event => {
				if (event.method === 'agent/tools/changed') listener.call(thisArgs);
			});
			if (Array.isArray(disposables)) disposables.push(subscription);
			else disposables?.add(subscription);
			return subscription;
		},
		read: async () => {
			const { tools, toolSets, sourceGroups, profiles } = await appServerRequest(connection, 'agent/capabilities/read', {});
			return { tools: tools.map(tool => ({ ...tool, category: tool.category ?? undefined })), toolSets, sourceGroups, profiles };
		},
	};
}

export function createDisconnectedAgentToolsApi(unavailable: UnavailableOperation): IAgentToolsApi {
	return { isAvailable: false, onDidChangeTools: Event.None, read: () => unavailable('agentTools.read') };
}
