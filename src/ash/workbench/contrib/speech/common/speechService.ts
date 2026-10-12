import type { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { IDictationOptions } from '../../../../platform/dictation/common/dictationService.js';
import type { ILocalTranscriptionModelSnapshot } from '../../../../platform/localTranscription/common/localTranscription.js';

export const ISpeechService = createDecorator<ISpeechService>('speechService');

export enum SpeechToTextState {
	Idle = 'idle',
	Recording = 'recording',
	Transcribing = 'transcribing',
}

export interface ISpeechToTextTranscript {
	readonly text: string;
	readonly finalizedText: string;
}

export interface ISpeechService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeState: Event<SpeechToTextState>;
	readonly onDidUpdateTranscript: Event<ISpeechToTextTranscript>;
	readonly onDidEnd: Event<string | undefined>;
	readonly onDidChangePreparation: Event<void>;
	readonly state: SpeechToTextState;
	readonly isBusy: boolean;
	readonly isStarting: boolean;
	readonly isConfigured: boolean;
	getPreparation(): Promise<ILocalTranscriptionModelSnapshot | undefined>;
	prepareModel(): Promise<void>;
	cancelPreparation(): Promise<void>;
	getOptions(): Promise<IDictationOptions>;
	start(): Promise<void>;
	stopAndTranscribe(): Promise<string | undefined>;
	cancel(): Promise<void>;
}

