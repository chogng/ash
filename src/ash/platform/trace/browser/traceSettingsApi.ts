import { Event } from '../../../base/common/event.js';
import { generateUuid } from '../../../base/common/uuid.js';
import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../app-server/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import type { ITraceSettingsService } from '../common/traceSettingsService.js';

export function createAppServerTraceSettingsApi(connection: AppServerProtocolClient): ITraceSettingsService {
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
			return { revision: result.revision, configured: result.trace && { ...result.trace }, recording: { ...result.traceRecording } };
		},
		configure: async (settings, expectedRevision) => {
			await appServerRequest(connection, 'config/update', { commandId: generateUuid(), expectedRevision, trace: { ...settings } });
		},
	};
}

export function createDisconnectedTraceSettingsApi(unavailable: UnavailableOperation): ITraceSettingsService {
	return { onDidChange: Event.None, read: () => unavailable('traceSettings.read'), configure: () => unavailable('traceSettings.configure') };
}
