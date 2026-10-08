import { Event } from '../../../base/common/event.js';
import { generateUuid } from '../../../base/common/uuid.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import type { IExecutionSettingsService } from '../common/executionSettingsService.js';

export function createAppServerExecutionSettingsApi(connection: AppServerProtocolClient): IExecutionSettingsService {
	return {
		onDidChange: (listener, thisArgs, disposables) => {
			const subscription = connection.onNotification(event => {
				if (event.method === 'config/changed') { listener.call(thisArgs); }
			});
			if (Array.isArray(disposables)) { disposables.push(subscription); }
			else { disposables?.add(subscription); }
			return subscription;
		},
		read: async () => {
			const result = await appServerRequest(connection, 'config/read', {});
			return { revision: result.revision, settings: { ...result.execution } };
		},
		configure: async (settings, expectedRevision) => {
			await appServerRequest(connection, 'config/update', { commandId: generateUuid(), expectedRevision, execution: { ...settings } });
		},
	};
}

export function createDisconnectedExecutionSettingsApi(unavailable: UnavailableOperation): IExecutionSettingsService {
	return { onDidChange: Event.None, read: () => unavailable('executionSettings.read'), configure: () => unavailable('executionSettings.configure') };
}
