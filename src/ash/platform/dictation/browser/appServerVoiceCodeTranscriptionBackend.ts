import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { APP_SERVER_METHODS } from '../../../../../.build/protocol/typescript/index.js';
import { AppServerRemoteError } from '../../agentHost/common/appServerError.js';
import { canceled } from '../../../base/common/errors.js';
import { SpeechInstructionsConflictError, type IVoiceCodeTranscriptionBackendService } from '../common/dictation.js';

/** Converts transcription operations on the renderer's existing App Server connection. */
export function createAppServerVoiceCodeTranscriptionBackend(client: AppServerProtocolClient): IVoiceCodeTranscriptionBackendService {
	return {
		get isConnected() { return client.state === 'ready'; },
		readInstructions: async kind => {
			const generation = client.generation;
			const result = await client.request(APP_SERVER_METHODS['speech/instructions/read'], { kind });
			if (generation !== client.generation || client.state !== 'ready') throw canceled();
			return { text: result.text, revision: result.revision, exists: result.exists };
		},
		writeInstructions: async (kind, text, expectedRevision) => {
			const generation = client.generation;
			try {
				const result = await client.request(APP_SERVER_METHODS['speech/instructions/write'], { kind, text, expectedRevision });
				if (generation !== client.generation || client.state !== 'ready') throw canceled();
				return result.revision;
			} catch (error) {
				if (error instanceof AppServerRemoteError && error.errorName === 'FileSystemRevisionConflict') throw new SpeechInstructionsConflictError();
				throw error;
			}
		},
		onDidChangeConnection: listener => client.onStateChange(() => listener()),
		onDidTranscribe: listener => client.onNotification(notification => {
			if (notification.method === 'dictation/transcript') { listener(notification.params); }
		}),
		onDidEnd: listener => client.onNotification(notification => {
			if (notification.method === 'dictation/ended') {
				listener({ resourceId: notification.params.resourceId, error: notification.params.error ?? undefined });
			}
		}),
		getOptions: backend => client.request(APP_SERVER_METHODS['dictation/options'], { backend, audioInput: 'pcm16' }),
		start: async (resourceId, options) => {
			await client.request(APP_SERVER_METHODS['dictation/start'], { resourceId, ...options, inputDevice: null, audioInput: 'pcm16' });
		},
		pushAudio: async (resourceId, audio) => { await client.request(APP_SERVER_METHODS['dictation/audio'], { resourceId, audio }); },
		stop: async resourceId => (await client.request(APP_SERVER_METHODS['dictation/stop'], { resourceId })).text ?? undefined,
		cancel: async resourceId => { await client.request(APP_SERVER_METHODS['dictation/cancel'], { resourceId }); },
	};
}
