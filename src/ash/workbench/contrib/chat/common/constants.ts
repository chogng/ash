import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { DictationBackend } from '../../../../platform/renderer/common/dictation.js';
import { DEFAULT_LOCAL_TRANSCRIPTION_MODEL } from '../../../../platform/localTranscription/common/localTranscription.js';

export const OPEN_AGENTS_WINDOW_COMMAND_ID = 'workbench.action.openAgentsWindow';

/** Message input preferences are independent of the file and reply-code editors. */
export const ChatInputConfiguration = Object.freeze({
	fontFamily: 'chat.input.fontFamily',
	fontSize: 'chat.input.fontSize',
	lineHeight: 'chat.input.lineHeight',
});

export const ChatEditorConfiguration = Object.freeze({
	fontFamily: 'chat.editor.fontFamily',
	fontSize: 'chat.editor.fontSize',
	lineHeight: 'chat.editor.lineHeight',
	wordWrap: 'chat.editor.wordWrap',
});

export const autoAcceptDelaySetting = 'chat.editing.autoAcceptDelay';

export const CLOUD_DICTATION_MODEL = 'gpt-live-transcribe';
export const XAI_DICTATION_MODEL = 'grok-voice-transcribe-2.0';

export function parseBackend(value: unknown): 'local' | 'cloud' | 'codex' {
	if (value === 'local' || value === 'cloud' || value === 'codex') { return value; }
	throw new TypeError('dictation.backend must be local, cloud or codex');
}

export function parseLocalModel(value: unknown): string {
	if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value)) { return value; }
	throw new TypeError('dictation.model must be a model package ID');
}

export function parseCloudProvider(value: unknown): 'openAi' | 'xai' {
	if (value === 'openAi' || value === 'xai') { return value; }
	throw new TypeError('dictation.cloudProvider must be openAi or xai');
}

export function dictationBackend(configuration: Pick<IConfigurationService, 'getValue'>): DictationBackend {
	const type = parseBackend(configuration.getValue(DictationConfiguration.backend) ?? 'local');
	if (type === 'codex') { return { type }; }
	if (type === 'local') {
		return { type, modelId: parseLocalModel(configuration.getValue(DictationConfiguration.model) ?? DEFAULT_LOCAL_TRANSCRIPTION_MODEL) };
	}
	const provider = parseCloudProvider(configuration.getValue(DictationConfiguration.cloudProvider) ?? 'openAi');
	return { type, provider, modelId: provider === 'xai' ? XAI_DICTATION_MODEL : CLOUD_DICTATION_MODEL };
}

export function parseInputDevice(value: unknown): string {
	if (typeof value === 'string' && value.length <= 2048 && !/[\r\n\0]/u.test(value)) { return value; }
	throw new TypeError('dictation.inputDevice must be a microphone identity');
}

export function parseLanguage(value: unknown): string {
	if (typeof value === 'string' && (value === 'auto' || /^[a-z]{2,3}(?:-[a-z]{2})?$/u.test(value))) { return value; }
	throw new TypeError('dictation.language must be auto or a language code');
}

export function dictationInputOptions(configuration: Pick<IConfigurationService, 'getValue'>, backend: 'local' | 'cloud' | 'codex'): { inputDevice: string | null; language: string | null; } {
	const inputDevice = parseInputDevice(configuration.getValue('dictation.inputDevice') ?? '');
	const language = parseLanguage(configuration.getValue('dictation.language') ?? 'auto');
	return { inputDevice: inputDevice || null, language: backend === 'local' || language === 'auto' ? null : language };
}

export const DictationConfiguration = Object.freeze({
	enabled: 'dictation.enabled',
	showButton: 'dictation.showButton',
	inputDevice: 'dictation.inputDevice',
	language: 'dictation.language',
	backend: 'dictation.backend',
	cloudProvider: 'dictation.cloudProvider',
	model: 'dictation.model',
});
