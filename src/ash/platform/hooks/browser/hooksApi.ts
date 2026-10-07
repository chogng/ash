import { Event } from '../../../base/common/event.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import type { IHooksService } from '../common/hooksService.js';

export function createAppServerHooksApi(connection: AppServerProtocolClient): IHooksService {
	return {
		userConfigurationEditor: undefined,
		onDidChange: listener => connection.onNotification(event => {
			if (event.method === 'config/changed') listener();
		}),
		read: async sessionId => {
			const result = await appServerRequest(connection, 'hook/list', sessionId ? { sessionId } : {});
			return result.sources.map(source => ({
				namespace: source.namespace,
				configPath: source.configPath,
				hooks: source.hooks.map(hook => ({
					id: hook.id,
					event: hook.event,
					enabled: hook.enablement === 'enabled',
					toolNames: hook.matcher.toolNames,
					program: hook.action.program,
					args: hook.action.args,
				})),
			}));
		},
	};
}

export function createDisconnectedHooksApi(unavailable: UnavailableOperation): IHooksService {
	return { userConfigurationEditor: undefined, onDidChange: Event.None, read: () => unavailable('hooks.read') };
}
