import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import type { IDictationService, IDictationSession } from '../../../../../platform/dictation/common/dictationService.js';

export enum ChatSpeechToTextState {
	Idle = 'idle',
	Recording = 'recording',
	Transcribing = 'transcribing',
}

/** Composer-owned recording state; the platform adapter owns microphone and App Server transport. */
export class ChatSpeechToTextService extends Disposable {
	private readonly stateChanged = this._register(new Emitter<ChatSpeechToTextState>());
	public readonly onDidChangeState = this.stateChanged.event;
	private readonly transcript = this._register(new Emitter<{ readonly text: string; readonly isFinal: boolean }>());
	public readonly onDidUpdateTranscript = this.transcript.event;
	private readonly ended = this._register(new Emitter<string | undefined>());
	public readonly onDidEnd = this.ended.event;
	private session: IDictationSession | undefined;
	private starting: Promise<void> | undefined;
	private stopping: Promise<void> | undefined;
	private currentState = ChatSpeechToTextState.Idle;
	public get state(): ChatSpeechToTextState { return this.currentState; }
	public get isBusy(): boolean { return this.state !== ChatSpeechToTextState.Idle; }
	public get isStarting(): boolean { return !!this.starting; }

	constructor(private readonly backend: IDictationService) {
		super();
		// A pending microphone acquisition is also closed by startSession after this owner is disposed.
		this._register(toDisposable(() => { void this.stopAndTranscribe().catch(() => {}); }));
	}

	public async start(): Promise<void> {
		if (this.isBusy) { return; }
		this.setState(ChatSpeechToTextState.Recording);
		this.starting = this.startSession();
		try { await this.starting; }
		finally {
			this.starting = undefined;
			if (!this.isDisposed) { this.stateChanged.fire(this.state); }
		}
	}

	private async startSession(): Promise<void> {
		let ended = false;
		try {
			const session = await this.backend.start((text, isFinal) => {
				if (!this.isDisposed && !ended) { this.transcript.fire({ text, isFinal }); }
			}, error => {
				ended = true;
				this.session = undefined;
				if (!this.isDisposed) {
					if (!this.stopping) { this.setState(ChatSpeechToTextState.Idle); }
					this.ended.fire(error);
				}
			});
			if (this.isDisposed || ended) { await session.stop(); }
			else { this.session = session; }
		} catch (error) {
			this.setState(ChatSpeechToTextState.Idle);
			throw error;
		}
	}

	public stopAndTranscribe(): Promise<void> {
		if (this.stopping) { return this.stopping; }
		if (!this.isBusy) { return Promise.resolve(); }
		this.setState(ChatSpeechToTextState.Transcribing);
		this.stopping = this.stopSession();
		return this.stopping;
	}

	private async stopSession(): Promise<void> {
		try {
			await this.starting;
			await this.session?.stop();
		} finally {
			this.session = undefined;
			this.stopping = undefined;
			this.setState(ChatSpeechToTextState.Idle);
		}
	}

	private setState(state: ChatSpeechToTextState): void {
		if (this.currentState === state) { return; }
		this.currentState = state;
		if (!this.isDisposed) { this.stateChanged.fire(state); }
	}

}
