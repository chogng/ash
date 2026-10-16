import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

/** A host can provide device access without choosing the user's transcription backend. */
export const IDictationBackendService = createServiceIdentifier<IDictationBackendService | undefined>('dictationBackendService');

export type DictationBackend =
	| { readonly type: 'local'; readonly modelId: string; }
	| { readonly type: 'cloud'; readonly provider: 'openAi' | 'xai'; readonly modelId: string; }
	| { readonly type: 'codex'; };

export interface IDictationInputOptions {
	readonly inputDevices: readonly { readonly id: string; readonly label: string; readonly isDefault: boolean; }[];
	readonly languages: readonly string[];
}

export interface IDictationSession {
	stop(): Promise<void>;
	/** Discards capture and interrupts an upload already waiting for transcription. */
	cancel(): Promise<void>;
}

/** Device options and non-local capture. Workbench owns selection; the local transcription service owns local capture. */
export interface IDictationBackendService {
	readonly onDidChangeAvailability: Event<void>;
	getOptions(backend: DictationBackend): Promise<IDictationInputOptions>;
	start(
		options: { readonly backend: Exclude<DictationBackend, { readonly type: 'local'; }>; readonly inputDevice: string | null; readonly language: string | null; },
		onTranscript: (text: string, isFinal: boolean) => void,
		onEnded: (error?: string) => void,
	): Promise<IDictationSession>;
}

/** Host operations for a client-owned capture resource; no product configuration or wire types cross this boundary. */
export interface IVoiceCodeTranscriptionBackend {
	readonly isConnected: boolean;
	readonly onDidChangeConnection: Event<void>;
	readonly onDidTranscribe: Event<{ readonly resourceId: string; readonly text: string; readonly isFinal: boolean; }>;
	readonly onDidEnd: Event<{ readonly resourceId: string; readonly error?: string; }>;
	getOptions(backend: DictationBackend): Promise<IDictationInputOptions>;
	start(resourceId: string, options: Parameters<IDictationBackendService['start']>[0]): Promise<void>;
	stop(resourceId: string): Promise<string | undefined>;
	cancel(resourceId: string): Promise<void>;
}
