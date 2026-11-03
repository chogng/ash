import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export type SpeechInstructionKind = 'voice' | 'dictation';

/** Exact UTF-8 Markdown in the Profile that owns this speech backend. */
export interface SpeechInstructionsDocument {
	readonly text: string;
	readonly revision: string;
	readonly exists: boolean;
}

export class SpeechInstructionsConflictError extends Error { }

/** A host provides authenticated transcription transport without choosing the user's backend. */
export const IVoiceCodeTranscriptionBackendService = createServiceIdentifier<IVoiceCodeTranscriptionBackendService | undefined>('voiceCodeTranscriptionBackendService');

export type DictationBackend =
	| { readonly type: 'local'; readonly modelId: string; }
	| { readonly type: 'cloud'; readonly provider: 'openAi' | 'xai'; readonly modelId: string; }
	| { readonly type: 'codex'; };

export interface IDictationInputOptions {
	readonly inputDevices: readonly { readonly id: string; readonly label: string; readonly isDefault: boolean; }[];
	readonly languages: readonly string[];
}

/** Host operations for capture and its Profile instruction resources; wire types remain in the adapter. */
export interface IVoiceCodeTranscriptionBackendService {
	readonly isConnected: boolean;
	readonly onDidChangeConnection: Event<void>;
	readonly onDidTranscribe: Event<{ readonly resourceId: string; readonly text: string; readonly isFinal: boolean; }>;
	readonly onDidEnd: Event<{ readonly resourceId: string; readonly error?: string; }>;
	readInstructions(kind: SpeechInstructionKind): Promise<SpeechInstructionsDocument>;
	writeInstructions(kind: SpeechInstructionKind, text: string, expectedRevision: string): Promise<string>;
	getOptions(backend: DictationBackend): Promise<IDictationInputOptions>;
	start(resourceId: string, options: { readonly backend: DictationBackend; readonly language: string | null; }): Promise<void>;
	pushAudio(resourceId: string, audio: string): Promise<void>;
	stop(resourceId: string): Promise<string | undefined>;
	cancel(resourceId: string): Promise<void>;
}
