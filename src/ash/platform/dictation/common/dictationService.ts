import type { Event } from '../../../base/common/event.js';
import type { ILocalTranscriptionModelSnapshot } from '../../localTranscription/common/localTranscription.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/** Every window registers its capture capability; unavailable hosts explicitly register undefined. */
export const IDictationService = createDecorator<IDictationService | undefined>('dictationService');

/** One microphone session delivers recognized phrases to the owning input. */
export interface IDictationSession {
	stop(): Promise<void>;
}

export interface IDictationService {
	readonly onDidChangePreparation: Event<void>;
	/** Cloud input has no local package prerequisite. */
	getPreparation(): Promise<ILocalTranscriptionModelSnapshot | undefined>;
	prepareModel(): Promise<void>;
	cancelPreparation(): Promise<void>;
	getOptions(): Promise<IDictationOptions>;
	start(onTranscript: (text: string, isFinal: boolean) => void, onEnded: (error?: string) => void): Promise<IDictationSession>;
}

export interface IDictationOptions {
	readonly inputDevices: readonly { readonly id: string; readonly label: string; readonly isDefault: boolean; }[];
	readonly languages: readonly string[];
}
