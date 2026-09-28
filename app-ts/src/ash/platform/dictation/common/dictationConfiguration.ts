import { localize } from '../../../nls.js';
import { configurationValues, type IConfigurationDocument } from '../../configuration/common/configurationIpc.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../configuration/common/configurationRegistry.js';
import { Registry } from '../../registry/common/platform.js';

export const DEFAULT_LOCAL_DICTATION_MODEL = 'paraformer-large-online-ec6a3c64';
export const CLOUD_DICTATION_MODEL = 'gpt-live-transcribe';
export const XAI_DICTATION_MODEL = 'grok-voice-transcribe-2.0';

function parseBackend(value: unknown): 'local' | 'cloud' {
	if (value === 'local' || value === 'cloud') { return value; }
	throw new TypeError('dictation.backend must be local or cloud');
}

function parseLocalModel(value: unknown): string {
	if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value)) { return value; }
	throw new TypeError('dictation.localModel must be a model package ID');
}

function parseCloudProvider(value: unknown): 'openAi' | 'xai' {
	if (value === 'openAi' || value === 'xai') { return value; }
	throw new TypeError('dictation.cloudProvider must be openAi or xai');
}

export function dictationBackend(document: IConfigurationDocument): { readonly type: 'local'; readonly modelId: string } | { readonly type: 'cloud'; readonly provider: 'openAi' | 'xai'; readonly modelId: string } {
	const values = configurationValues(document);
	const type = parseBackend(values[DictationConfiguration.backend] ?? 'local');
	if (type === 'local') {
		return { type, modelId: parseLocalModel(values[DictationConfiguration.localModel] ?? DEFAULT_LOCAL_DICTATION_MODEL) };
	}
	const provider = parseCloudProvider(values[DictationConfiguration.cloudProvider] ?? 'openAi');
	return { type, provider, modelId: provider === 'xai' ? XAI_DICTATION_MODEL : CLOUD_DICTATION_MODEL };
}

const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

export const DictationConfiguration = Object.freeze({
	backend: registry.registerConfiguration<'local' | 'cloud'>({
		key: 'dictation.backend',
		defaultValue: 'local',
		parse: parseBackend,
		setting: {
			valueType: 'select',
			title: localize({ bundle: 'ash', key: 'dictation.backend.title' }, 'Dictation service'),
			description: localize({ bundle: 'ash', key: 'dictation.backend.description' }, 'Choose local or cloud transcription for voice input.'),
			options: [
				{ value: 'local', label: localize({ bundle: 'ash', key: 'dictation.backend.local' }, 'Local') },
				{ value: 'cloud', label: localize({ bundle: 'ash', key: 'dictation.backend.cloud' }, 'Cloud') },
			],
		},
	}),
	cloudProvider: registry.registerConfiguration<'openAi' | 'xai'>({
		key: 'dictation.cloudProvider',
		defaultValue: 'openAi',
		parse: parseCloudProvider,
		setting: {
			valueType: 'select',
			title: localize({ bundle: 'ash', key: 'dictation.cloudProvider.title' }, 'Cloud dictation provider'),
			description: localize({ bundle: 'ash', key: 'dictation.cloudProvider.description' }, 'Choose the cloud transcription provider. Its API key is required.'),
			options: [
				{ value: 'openAi', label: 'OpenAI' },
				{ value: 'xai', label: 'xAI' },
			],
		},
	}),
	localModel: registry.registerConfiguration<string>({
		key: 'dictation.localModel',
		defaultValue: DEFAULT_LOCAL_DICTATION_MODEL,
		parse: parseLocalModel,
		setting: {
			valueType: 'text',
			title: localize({ bundle: 'ash', key: 'dictation.localModel.title' }, 'Local dictation model'),
			description: localize({ bundle: 'ash', key: 'dictation.localModel.description' }, 'Model package ID in the Ash dictation-models directory.'),
			placeholder: DEFAULT_LOCAL_DICTATION_MODEL,
		},
	}),
});
