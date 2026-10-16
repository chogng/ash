import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ILocalTranscriptionService, ILocalTranscriptionModelSnapshot } from '../../../../../platform/localTranscription/common/localTranscription.js';
import type { IVoiceCodeTranscriptionBackendService, IDictationInputOptions } from '../../../../../platform/renderer/common/dictation.js';
import type { ISpeechService } from '../../../speech/common/speechService.js';
import { dictationBackend } from '../../common/constants.js';
import { localize } from '../../../../../nls.js';

/** Ash's installed-model and input choices are view data, separate from the shared recording contract. */
export async function readDictationPreparation(configuration: IConfigurationService, local: ILocalTranscriptionService, speech: ISpeechService): Promise<ILocalTranscriptionModelSnapshot | undefined> {
	if (speech.hasSpeechProvider) return undefined;
	const backend = dictationBackend(configuration);
	return backend.type === 'local' && local.isSupported ? local.getModelStatus(backend.modelId) : undefined;
}

export async function readDictationOptions(window: Window & typeof globalThis, configuration: IConfigurationService, backend: IVoiceCodeTranscriptionBackendService | undefined, speech: ISpeechService): Promise<IDictationInputOptions | undefined> {
	if (speech.hasSpeechProvider || !backend) return undefined;
	const options = await backend.getOptions(dictationBackend(configuration));
	const devices = await window.navigator.mediaDevices.enumerateDevices();
	return {
		languages: options.languages,
		inputDevices: devices.filter(device => device.kind === 'audioinput' && device.deviceId !== 'default').map(device => ({ id: device.deviceId, label: device.label || localize({ bundle: 'ash', key: 'dictation.microphone' }, 'Microphone'), isDefault: false })),
	};
}
