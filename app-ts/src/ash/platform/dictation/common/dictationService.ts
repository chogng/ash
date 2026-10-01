import type { Event } from '../../../base/common/event.js';
import type { ILocalTranscriptionModelSnapshot } from '../../localTranscription/common/localTranscription.js';

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
	start(onTranscript: (text: string, isFinal: boolean) => void, onEnded: (error?: string) => void): Promise<IDictationSession>;
}
