import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { encodeBase64 } from '../../../base/common/buffer.js';
import { APP_SERVER_METHODS } from '../../../../../.build/protocol/typescript/index.js';
import {
	DictationModelState,
	type ILocalTranscriptionBackendService,
	type IDictationModelStatus,
} from '../common/localTranscription.js';
import type { DictationModelStage, DictationModelStatus } from '../../../../../.build/protocol/typescript/index.js';

/** Converts only this domain's messages on the renderer's existing connection. */
export function createAppServerLocalTranscriptionBackendService(
	client: AppServerProtocolClient,
): ILocalTranscriptionBackendService {
	return {
		get isConnected() {
			return client.state === 'ready';
		},
		onDidDisconnect: listener =>
			client.onStateChange(state => {
				if (state !== 'ready') {
					listener();
				}
			}),
		onDidTranscribe: listener =>
			client.onNotification(notification => {
				if (notification.method === 'dictation/transcript') {
					listener(notification.params);
				}
			}),
		onDidEnd: listener =>
			client.onNotification(notification => {
				if (notification.method === 'dictation/ended') {
					listener({
						resourceId: notification.params.resourceId,
						error: notification.params.error ?? undefined,
					});
				}
			}),
		onDidChangeModelStatus: listener =>
			client.onNotification(notification => {
				if (notification.method === 'dictation/model/progress') {
					listener({
						resourceId: notification.params.resourceId,
						model: notification.params.modelId,
						status: modelStatus(notification.params.stage),
					});
				}
			}),
		onDidChangeModels: listener =>
			client.onNotification(notification => {
				if (notification.method === 'dictation/model/changed') {
					listener();
				}
			}),
		getModelStatus: async model => {
			const status = await client.request(APP_SERVER_METHODS['dictation/model/read'], { modelId: model });
			return modelSnapshot(status);
		},
		listModels: async () =>
			(await client.request(APP_SERVER_METHODS['dictation/model/list'], null)).models.map(modelSnapshot),
		getModelCacheInfo: async () => {
			const cache = await client.request(APP_SERVER_METHODS['dictation/model/list'], null);
			return { directory: cache.cacheDirectory, version: cache.packageVersion };
		},
		cancelModel: async model => {
			await client.request(APP_SERVER_METHODS['dictation/model/cancel'], { modelId: model });
		},
		deleteModel: async model => {
			await client.request(APP_SERVER_METHODS['dictation/model/delete'], { modelId: model });
		},
		startModelOperation: async (resourceId, model, operation) => {
			await client.request(APP_SERVER_METHODS['dictation/model/start'], {
				resourceId,
				modelId: model,
				operation,
			});
		},
		stopModelOperation: async resourceId => {
			await client.request(APP_SERVER_METHODS['dictation/model/stop'], { resourceId });
		},
		start: async (resourceId, model) => {
			await client.request(APP_SERVER_METHODS['dictation/start'], {
				resourceId,
				backend: { type: 'local', modelId: model },
				inputDevice: null,
				language: null,
				audioInput: 'pcm16',
			});
		},
		pushAudio: async (resourceId, chunk) => {
			await client.request(APP_SERVER_METHODS['dictation/audio'], { resourceId, audio: encodeBase64(chunk) });
		},
		stop: async resourceId => (await client.request(APP_SERVER_METHODS['dictation/stop'], { resourceId })).text,
		cancel: async resourceId => {
			await client.request(APP_SERVER_METHODS['dictation/cancel'], { resourceId });
		},
	};
}

function modelSnapshot(status: DictationModelStatus) {
	return {
		model: status.modelId,
		available: status.available,
		sizeBytes: status.sizeBytes,
		status: status.stage ? modelStatus(status.stage) : undefined,
	};
}

function modelStatus(stage: DictationModelStage): IDictationModelStatus {
	switch (stage.type) {
		case 'checking':
			return { state: DictationModelState.Checking };
		case 'downloading':
			return { state: DictationModelState.Downloading, file: stage.file, downloadedBytes: stage.downloadedBytes };
		case 'loading':
			return { state: DictationModelState.Loading };
		case 'ready':
			return { state: DictationModelState.Ready };
		case 'cancelled':
			return { state: DictationModelState.Cancelled };
		case 'failed':
			return { state: DictationModelState.Error, error: stage.error };
	}
}
