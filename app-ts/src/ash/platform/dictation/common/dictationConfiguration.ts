import { localize } from '../../../nls.js';
import { configurationValues, type IConfigurationDocument } from '../../configuration/common/configurationIpc.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../configuration/common/configurationRegistry.js';
import { Registry } from '../../registry/common/platform.js';

export const DEFAULT_LOCAL_DICTATION_MODEL = 'paraformer-large-online-ec6a3c64';
export const CLOUD_DICTATION_MODEL = 'gpt-live-transcribe';

function parseBackend(value: unknown): 'local' | 'cloud' {
	if (value === 'local' || value === 'cloud') { return value; }
	throw new TypeError('dictation.backend must be local or cloud');
}

function parseLocalModel(value: unknown): string {
	if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value)) { return value; }
	throw new TypeError('dictation.localModel must be a model package ID');
}

export function dictationBackend(document: IConfigurationDocument): { readonly type: 'local' | 'cloud'; readonly modelId: string } {
	const values = configurationValues(document);
	const type = parseBackend(values[DictationConfiguration.backend] ?? 'local');
	return type === 'local'
		? { type, modelId: parseLocalModel(values[DictationConfiguration.localModel] ?? DEFAULT_LOCAL_DICTATION_MODEL) }
		: { type, modelId: CLOUD_DICTATION_MODEL };
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
