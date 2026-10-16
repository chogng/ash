import { getNLSLanguage } from '../../../../nls.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const ISpeechService = createDecorator<ISpeechService>('speechService');
export const HasSpeechProvider = new RawContextKey<boolean>('hasSpeechProvider', false);
export const SpeechToTextInProgress = new RawContextKey<boolean>('speechToTextInProgress', false);
export const TextToSpeechInProgress = new RawContextKey<boolean>('textToSpeechInProgress', false);

export enum SpeechToTextStatus {
	Started = 1,
	Recognizing = 2,
	Recognized = 3,
	Stopped = 4,
	Error = 5,
}

export interface ISpeechToTextEvent {
	readonly status: SpeechToTextStatus;
	readonly text?: string;
}

export interface ISpeechToTextSession {
	readonly onDidChange: Event<ISpeechToTextEvent>;
}

export interface ISpeechProviderMetadata {
	readonly extension: ExtensionIdentifier;
	readonly displayName: string;
}
export interface ISpeechToTextSessionOptions { readonly language?: string; }
export interface ITextToSpeechSessionOptions { readonly language?: string; }
export enum TextToSpeechStatus { Started = 1, Stopped = 2, Error = 3 }
export interface ITextToSpeechEvent { readonly status: TextToSpeechStatus; readonly text?: string; }
export interface ITextToSpeechSession {
	readonly onDidChange: Event<ITextToSpeechEvent>;
	/** Resolves after the provider reports Stopped, allowing callers to read consecutive chunks. */
	synthesize(text: string): Promise<void>;
}
export enum KeywordRecognitionStatus { Recognized = 1, Stopped = 2, Canceled = 3 }
export interface IKeywordRecognitionEvent { readonly status: KeywordRecognitionStatus; readonly text?: string; }
export interface IKeywordRecognitionSession { readonly onDidChange: Event<IKeywordRecognitionEvent>; }
export interface ISpeechProvider {
	readonly metadata: ISpeechProviderMetadata;
	createSpeechToTextSession(token: CancellationToken, options?: ISpeechToTextSessionOptions): ISpeechToTextSession;
	createTextToSpeechSession(token: CancellationToken, options?: ITextToSpeechSessionOptions): ITextToSpeechSession;
	createKeywordRecognitionSession(token: CancellationToken): IKeywordRecognitionSession;
}

export interface ISpeechService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeHasSpeechProvider: Event<void>;
	registerSpeechProvider(identifier: string, provider: ISpeechProvider): IDisposable;
	readonly onDidStartTextToSpeechSession: Event<void>;
	readonly onDidEndTextToSpeechSession: Event<void>;
	readonly hasActiveTextToSpeechSession: boolean;
	createTextToSpeechSession(token: CancellationToken, context?: string): Promise<ITextToSpeechSession>;
	readonly onDidStartKeywordRecognition: Event<void>;
	readonly onDidEndKeywordRecognition: Event<void>;
	readonly hasActiveKeywordRecognition: boolean;
	recognizeKeyword(token: CancellationToken): Promise<KeywordRecognitionStatus>;
	readonly onDidStartSpeechToTextSession: Event<void>;
	readonly onDidEndSpeechToTextSession: Event<void>;
	readonly hasActiveSpeechToTextSession: boolean;
	readonly hasSpeechProvider: boolean;
	createSpeechToTextSession(token: CancellationToken, context?: string): Promise<ISpeechToTextSession>;
}


export const SPEECH_LANGUAGE_CONFIG = 'accessibility.voice.speechLanguage';
const speechLocales = ['da-DK', 'de-DE', 'en-AU', 'en-CA', 'en-GB', 'en-IE', 'en-IN', 'en-NZ', 'en-US', 'es-ES', 'es-MX', 'fr-CA', 'fr-FR', 'hi-IN', 'it-IT', 'ja-JP', 'ko-KR', 'nl-NL', 'pt-PT', 'pt-BR', 'ru-RU', 'sv-SE', 'tr-TR', 'zh-CN', 'zh-HK', 'zh-TW'];
export const SPEECH_LANGUAGES: Readonly<Record<string, { readonly name: string; }>> = Object.freeze(Object.fromEntries(speechLocales.map(code => [code, Object.freeze({
	get name() { return new Intl.DisplayNames([getNLSLanguage()], { type: 'language' }).of(code) ?? code; }
})])));

/** Resolves a user preference without requiring a capture or asking a provider for device access. */
export function speechLanguageConfigToLanguage(config: unknown, lang = getNLSLanguage()): string {
	const requested = config === 'auto' ? lang : config;
	if (typeof requested !== 'string') return 'en-US';
	try {
		const locale = new Intl.Locale(requested);
		const tag = config === 'auto' && !locale.region ? locale.maximize() : locale;
		const code = tag.region ? `${tag.language}-${tag.region}` : tag.language;
		return Object.hasOwn(SPEECH_LANGUAGES, code) ? code : 'en-US';
	} catch { return 'en-US'; }
}
