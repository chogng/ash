import { localize } from '../../../nls.js';
import type { IConfigurationService } from '../../configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../configuration/common/configurationRegistry.js';
import { Registry } from '../../registry/common/platform.js';

export const DEFAULT_LOCAL_DICTATION_MODEL = 'paraformer-large-online-ec6a3c64';
export const CLOUD_DICTATION_MODEL = 'gpt-live-transcribe';
export const XAI_DICTATION_MODEL = 'grok-voice-transcribe-2.0';

function parseBackend(value: unknown): 'local' | 'cloud' | 'codex' {
	if (value === 'local' || value === 'cloud' || value === 'codex') { return value; }
	throw new TypeError('dictation.backend must be local, cloud or codex');
}

function parseLocalModel(value: unknown): string {
	if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value)) { return value; }
	throw new TypeError('dictation.localModel must be a model package ID');
}

function parseCloudProvider(value: unknown): 'openAi' | 'xai' {
	if (value === 'openAi' || value === 'xai') { return value; }
	throw new TypeError('dictation.cloudProvider must be openAi or xai');
}

export function dictationBackend(configuration: Pick<IConfigurationService, 'getValue'>): { readonly type: 'codex'; } | { readonly type: 'local'; readonly modelId: string; } | { readonly type: 'cloud'; readonly provider: 'openAi' | 'xai'; readonly modelId: string; } {
	const type = parseBackend(configuration.getValue(DictationConfiguration.backend) ?? 'local');
	if (type === 'codex') { return { type }; }
	if (type === 'local') {
		return { type, modelId: parseLocalModel(configuration.getValue(DictationConfiguration.localModel) ?? DEFAULT_LOCAL_DICTATION_MODEL) };
	}
	const provider = parseCloudProvider(configuration.getValue(DictationConfiguration.cloudProvider) ?? 'openAi');
	return { type, provider, modelId: provider === 'xai' ? XAI_DICTATION_MODEL : CLOUD_DICTATION_MODEL };
}

const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

function parseInputDevice(value: unknown): string {
	if (typeof value === 'string' && value.length <= 2048 && !/[\r\n\0]/u.test(value)) { return value; }
	throw new TypeError('dictation.inputDevice must be a microphone identity');
}

function parseLanguage(value: unknown): string {
	if (typeof value === 'string' && (value === 'auto' || /^[a-z]{2,3}(?:-[a-z]{2})?$/u.test(value))) { return value; }
	throw new TypeError('dictation.language must be auto or a language code');
}

export function dictationInputOptions(configuration: Pick<IConfigurationService, 'getValue'>, backend: 'local' | 'cloud' | 'codex'): { inputDevice: string | null; language: string | null; } {
	const inputDevice = parseInputDevice(configuration.getValue('dictation.inputDevice') ?? '');
	const language = parseLanguage(configuration.getValue('dictation.language') ?? 'auto');
	return { inputDevice: inputDevice || null, language: backend === 'local' || language === 'auto' ? null : language };
}

export const DictationConfiguration = Object.freeze({
	inputDevice: registry.registerConfiguration<string>({
		key: 'dictation.inputDevice', defaultValue: '', parse: parseInputDevice,
	}),
	language: registry.registerConfiguration<string>({
		key: 'dictation.language', defaultValue: 'auto', parse: parseLanguage,
	}),
	backend: registry.registerConfiguration<'local' | 'cloud' | 'codex'>({
		key: 'dictation.backend',
		defaultValue: 'local',
		parse: parseBackend,
		setting: {
			valueType: 'select',
			title: localize({ bundle: 'ash', key: 'dictation.backend.title' }, 'Dictation service'),
			description: localize({ bundle: 'ash', key: 'dictation.backend.description' }, 'Choose local transcription, a cloud API, or your Codex subscription for voice input.'),
			options: [
				{ value: 'local', label: localize({ bundle: 'ash', key: 'dictation.backend.local' }, 'Local') },
				{ value: 'cloud', label: localize({ bundle: 'ash', key: 'dictation.backend.cloud' }, 'Cloud') },
				{ value: 'codex', label: localize({ bundle: 'ash', key: 'dictation.backend.codex' }, 'Codex subscription') },
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
