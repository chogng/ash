import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ILocalTranscriptionModelService, ILocalTranscriptionModelSnapshot } from '../../../../../platform/localTranscription/common/localTranscription.js';
import type { IVoiceCodeTranscriptionBackendService, IDictationInputOptions } from '../../../../../platform/dictation/common/dictation.js';
import type { ISpeechService } from '../../../speech/common/speechService.js';
import { dictationBackend } from '../../common/constants.js';
import { localize } from '../../../../../nls.js';

/** Ash's installed-model and input choices are view data, separate from the shared recording contract. */
export async function readDictationPreparation(configuration: IConfigurationService, local: ILocalTranscriptionModelService, speech: ISpeechService): Promise<ILocalTranscriptionModelSnapshot | undefined> {
	if (speech.hasSpeechProvider) return undefined;
	const backend = dictationBackend(configuration);
	return backend.type === 'local' && local.isSupported ? local.getModel(backend.modelId) : undefined;
}

export async function readDictationOptions(window: Window & typeof globalThis, configuration: IConfigurationService, backend: IVoiceCodeTranscriptionBackendService | undefined, speech: ISpeechService): Promise<IDictationInputOptions | undefined> {
	if (speech.hasSpeechProvider || !backend) return undefined;
	const options = await backend.getOptions(dictationBackend(configuration));
	return {
		languages: options.languages,
		inputDevices: await readDictationInputDevices(window),
	};
}

export async function readDictationInputDevices(window: Window & typeof globalThis): Promise<IDictationInputOptions['inputDevices']> {
	const devices = await window.navigator.mediaDevices?.enumerateDevices() ?? [];
	return devices.filter(device => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default')
		.map(device => ({
			id: device.deviceId,
			label: device.label.replace(/\s*\(Built-in\)\s*$/i, '') || localize({ bundle: 'ash', key: 'dictation.microphone' }, 'Microphone'),
			isDefault: false,
		}));
}

interface DictationMicrophoneChoice {
	readonly id: string;
	readonly label: string;
	readonly disconnected?: true;
}

export function getDictationMicrophoneChoices(devices: IDictationInputOptions['inputDevices'], selectedDeviceId?: string): readonly DictationMicrophoneChoice[] {
	const choices: DictationMicrophoneChoice[] = [
		{ id: '', label: localize({ bundle: 'ash', key: 'dictation.systemInputDevice' }, 'System') },
		...devices,
	];
	if (selectedDeviceId && !devices.some(device => device.id === selectedDeviceId)) {
		choices.push({
			id: selectedDeviceId,
			label: localize({ bundle: 'ash', key: 'dictation.missingMicrophone' }, 'Selected microphone is disconnected'),
			disconnected: true,
		});
	}
	return choices;
}
