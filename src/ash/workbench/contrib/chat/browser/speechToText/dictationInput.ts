import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { resolveLocalTranscriptionModel, type ILocalTranscriptionModelService, type ILocalTranscriptionModelSnapshot } from '../../../../../platform/localTranscription/common/localTranscription.js';
import type { IVoiceCodeTranscriptionBackendService, IDictationInputOptions } from '../../../../../platform/dictation/common/dictation.js';
import type { ISpeechService } from '../../../speech/common/speechService.js';
import { dictationBackend } from '../../common/constants.js';
import { localize } from '../../../../../nls.js';

/** Ash's installed-model and input choices are view data, separate from the shared recording contract. */
export async function readDictationPreparation(configuration: IConfigurationService, local: ILocalTranscriptionModelService, speech: ISpeechService): Promise<ILocalTranscriptionModelSnapshot | undefined> {
	if (speech.hasSpeechProvider) return undefined;
	const backend = dictationBackend(configuration);
	return backend.type === 'local' && local.isSupported ? resolveLocalTranscriptionModel(local, backend.modelId) : undefined;
}

export interface DictationMenuOptions {
	readonly inputDevices: IDictationInputOptions['inputDevices'];
	readonly hasMicrophone: boolean;
	readonly systemMicrophoneName: string | undefined;
	readonly languages: IDictationInputOptions['languages'];
}

export async function readDictationOptions(window: Window & typeof globalThis, configuration: IConfigurationService, backend: IVoiceCodeTranscriptionBackendService | undefined, speech: ISpeechService): Promise<DictationMenuOptions | undefined> {
	if (speech.hasSpeechProvider || !backend) return undefined;
	const options = await backend.getOptions(dictationBackend(configuration));
	return { languages: options.languages, ...await readDictationInputDevices(window) };
}

export async function readDictationInputDevices(window: Window & typeof globalThis): Promise<Omit<DictationMenuOptions, 'languages'>> {
	const devices = await window.navigator.mediaDevices?.enumerateDevices() ?? [];
	const audioInputs = devices.filter(device => device.kind === 'audioinput');
	const inputDevices = audioInputs.filter(device => device.deviceId && device.deviceId !== 'default')
		.map(device => ({
			id: device.deviceId,
			label: formatMicrophoneName(device.label) || localize({ bundle: 'ash', key: 'dictation.microphone' }, 'Microphone'),
			isDefault: false,
		}));
	// Chromium uses a localized prefix for its default alias. Other browsers list the system input first.
	const defaultAlias = audioInputs.find(device => device.deviceId === 'default');
	const systemLabel = defaultAlias ? /^.+? - (.+)$/.exec(defaultAlias.label)?.[1] : audioInputs[0]?.label;
	// An input can be present even when the browser withholds its device ID.
	return {
		inputDevices,
		hasMicrophone: audioInputs.length > 0,
		systemMicrophoneName: systemLabel ? formatMicrophoneName(systemLabel) : undefined,
	};
}

function formatMicrophoneName(label: string): string {
	// Keep the language of the device name supplied by macOS, even in an English window.
	return label.replace(/\s*\(Built-in\)\s*$/i, '').replace(/^(MacBook(?: Air| Pro)?)\s*麦克风$/i, '$1 的麦克风');
}

interface DictationMicrophoneChoice {
	readonly id: string;
	readonly label: string;
	readonly disconnected?: true;
}

export function getDictationMicrophoneChoices(devices: IDictationInputOptions['inputDevices'], selectedDeviceId?: string, systemMicrophoneName?: string): readonly DictationMicrophoneChoice[] {
	const systemLabel = systemMicrophoneName
		? localize({ bundle: 'ash', key: 'dictation.systemMicrophoneName' }, '{0} (System default)', systemMicrophoneName)
		: localize({ bundle: 'ash', key: 'dictation.systemInputDevice' }, 'System');
	const choices: DictationMicrophoneChoice[] = [
		{ id: '', label: systemLabel },
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
