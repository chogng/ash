import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { resolveLocalTranscriptionModel, type ILocalTranscriptionModelService, type ILocalTranscriptionModelSnapshot } from '../../../../../platform/localTranscription/common/localTranscription.js';
import type { IVoiceCodeTranscriptionBackendService, IDictationInputOptions } from '../../../../../platform/dictation/common/dictation.js';
import type { ISpeechService } from '../../../speech/common/speechService.js';
import { DictationConfiguration, dictationBackend } from '../../common/constants.js';
import { localize } from '../../../../../nls.js';

/** Ash's installed-model and input choices are view data, separate from the shared recording contract. */
export async function readDictationPreparation(configuration: IConfigurationService, local: ILocalTranscriptionModelService, speech: ISpeechService): Promise<ILocalTranscriptionModelSnapshot | undefined> {
	if (speech.hasSpeechProvider) return undefined;
	const backend = dictationBackend(configuration);
	return backend.type === 'local' && local.isSupported ? resolveLocalTranscriptionModel(local, backend.modelId) : undefined;
}

interface DictationMicrophoneOptions {
	readonly choices: readonly DictationMicrophoneChoice[];
	readonly hasMicrophone: boolean;
	readonly selectedDeviceId: string;
}

export interface DictationMenuOptions {
	readonly microphones: DictationMicrophoneOptions;
	readonly languages: IDictationInputOptions['languages'];
}

export async function readDictationOptions(window: Window & typeof globalThis, configuration: IConfigurationService, backend: IVoiceCodeTranscriptionBackendService | undefined, speech: ISpeechService): Promise<DictationMenuOptions | undefined> {
	if (speech.hasSpeechProvider) return undefined;
	// Language discovery can fail independently of the window's microphone list.
	const [microphones, languages] = await Promise.all([
		readDictationMicrophones(window, configuration),
		backend?.isConnected ? backend.getOptions(dictationBackend(configuration)).then(options => options.languages, () => []) : [],
	]);
	return { microphones, languages };
}

/** Resolve browser devices and the saved choice together for every microphone picker. */
export async function readDictationMicrophones(window: Window & typeof globalThis, configuration: IConfigurationService): Promise<DictationMicrophoneOptions> {
	const devices = await window.navigator.mediaDevices?.enumerateDevices() ?? [];
	const audioInputs = devices.filter(device => device.kind === 'audioinput');
	const inputDevices = audioInputs.filter(device => device.deviceId && device.deviceId !== 'default')
		.map(device => ({
			id: device.deviceId,
			label: formatMicrophoneName(device.label) || localize({ bundle: 'ash', key: 'dictation.microphone' }, 'Microphone'),
		}));
	// Chromium uses a localized prefix for its default alias. Other browsers list the system input first.
	const defaultAlias = audioInputs.find(device => device.deviceId === 'default');
	const systemLabel = defaultAlias ? /^.+? - (.+)$/.exec(defaultAlias.label)?.[1] : audioInputs[0]?.label;
	const selectedDeviceId = configuration.getValue<string>(DictationConfiguration.inputDevice) ?? '';
	return {
		choices: getDictationMicrophoneChoices(inputDevices, selectedDeviceId, systemLabel ? formatMicrophoneName(systemLabel) : undefined),
		// An input can be present even when the browser withholds its device ID.
		hasMicrophone: audioInputs.length > 0,
		selectedDeviceId,
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

function getDictationMicrophoneChoices(devices: readonly DictationMicrophoneChoice[], selectedDeviceId: string, systemMicrophoneName: string | undefined): readonly DictationMicrophoneChoice[] {
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
