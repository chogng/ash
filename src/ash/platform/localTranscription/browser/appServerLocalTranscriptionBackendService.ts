import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import { APP_SERVER_METHODS } from '../../../../../crates/app-server-protocol/schema/typescript/index.js';
import { LocalTranscriptionModelState, type ILocalTranscriptionBackendService, type ILocalTranscriptionModelStatus } from '../common/localTranscription.js';
import type { DictationModelStage, DictationModelStatus } from '../../../../../crates/app-server-protocol/schema/typescript/index.js';

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
		onDidChangeModelStatus: listener => client.onNotification(notification => {
			if (notification.method === 'dictation/model/progress') {
				listener({ resourceId: notification.params.resourceId, model: notification.params.modelId, status: modelStatus(notification.params.stage) });
			}
		}),
		onDidChangeModels: listener => client.onNotification(notification => {
			if (notification.method === 'dictation/model/changed') { listener(); }
		}),
		getModelStatus: async model => {
			const status = await client.request(APP_SERVER_METHODS['dictation/model/read'], { modelId: model });
			return modelSnapshot(status);
		},
		listModels: async () => (await client.request(APP_SERVER_METHODS['dictation/model/list'], null)).models.map(modelSnapshot),
		cancelModel: async model => { await client.request(APP_SERVER_METHODS['dictation/model/cancel'], { modelId: model }); },
		deleteModel: async model => { await client.request(APP_SERVER_METHODS['dictation/model/delete'], { modelId: model }); },
		startModelOperation: async (resourceId, model, operation) => {
			await client.request(APP_SERVER_METHODS['dictation/model/start'], { resourceId, modelId: model, operation });
		},
		stopModelOperation: async resourceId => { await client.request(APP_SERVER_METHODS['dictation/model/stop'], { resourceId }); },
		start: async (resourceId, model, inputDevice) => {
			await client.request(APP_SERVER_METHODS['dictation/start'], { resourceId, backend: { type: 'local', modelId: model }, inputDevice: inputDevice ?? null, language: null });
		},
		stop: async resourceId => (await client.request(APP_SERVER_METHODS['dictation/stop'], { resourceId })).text,
	};
}

function modelSnapshot(status: DictationModelStatus) {
	return { model: status.modelId, available: status.available, sizeBytes: status.sizeBytes, status: status.stage ? modelStatus(status.stage) : undefined };
}

function modelStatus(stage: DictationModelStage): ILocalTranscriptionModelStatus {
	switch (stage.type) {
		case 'checking': return { state: LocalTranscriptionModelState.Checking };
		case 'downloading': return { state: LocalTranscriptionModelState.Downloading, file: stage.file, downloadedBytes: stage.downloadedBytes };
		case 'loading': return { state: LocalTranscriptionModelState.Loading };
		case 'ready': return { state: LocalTranscriptionModelState.Ready };
		case 'cancelled': return { state: LocalTranscriptionModelState.Cancelled };
		case 'failed': return { state: LocalTranscriptionModelState.Error, error: stage.error };
	}
}
