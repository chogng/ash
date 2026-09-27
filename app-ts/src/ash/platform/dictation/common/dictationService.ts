/** One microphone session delivers recognized phrases to the owning input. */
export interface IDictationSession {
	stop(): Promise<void>;
}

export interface IDictationService {
	start(onTranscript: (text: string) => void, onEnded: (error?: string) => void): Promise<IDictationSession>;
}
