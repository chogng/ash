import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import { APP_SERVER_METHODS } from '../../app-server/common/generated/index.js';
import type { ILocalTranscriptionBackendService } from '../common/localTranscription.js';

/** Converts only this domain's messages on the renderer's existing connection. */
export function createAppServerLocalTranscriptionBackendService(client: AppServerProtocolClient): ILocalTranscriptionBackendService {
	return {
		get isConnected() { return client.state === 'ready'; },
		onDidDisconnect: listener => client.onStateChange(state => {
			if (state !== 'ready') { listener(); }
		}),
		onDidTranscribe: listener => client.onNotification(notification => {
			if (notification.method === 'dictation/transcript') { listener(notification.params); }
		}),
		onDidEnd: listener => client.onNotification(notification => {
			if (notification.method === 'dictation/ended') {
				listener({ resourceId: notification.params.resourceId, error: notification.params.error ?? undefined });
			}
		}),
		start: async (resourceId, model) => {
			await client.request(APP_SERVER_METHODS['dictation/start'], { resourceId, backend: { type: 'local', modelId: model } });
		},
		stop: async resourceId => (await client.request(APP_SERVER_METHODS['dictation/stop'], { resourceId })).text,
	};
}
