import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IDictationService, type IDictationSession, type IDictationOptions } from '../../../../platform/dictation/common/dictationService.js';
import type { ILocalTranscriptionModelSnapshot } from '../../../../platform/localTranscription/common/localTranscription.js';
import { localize } from '../../../../nls.js';
import { ISpeechService, SpeechToTextState, type ISpeechToTextTranscript } from '../common/speechService.js';

interface Recording {
	starting?: Promise<void>;
	handle?: IDictationSession;
	stopping?: Promise<string | undefined>;
	finalizedText: string;
	cancelled: boolean;
}

/** One window owns capture orchestration; the host owns audio and backend execution. */
export class SpeechService extends Disposable implements ISpeechService {
	public readonly _serviceBrand = undefined;
	private readonly stateChanged = this._register(new Emitter<SpeechToTextState>());
	public readonly onDidChangeState = this.stateChanged.event;
	private readonly transcript = this._register(new Emitter<ISpeechToTextTranscript>());
	public readonly onDidUpdateTranscript = this.transcript.event;
	private readonly ended = this._register(new Emitter<string | undefined>());
	public readonly onDidEnd = this.ended.event;
	private readonly preparationChanged = this._register(new Emitter<void>());
	public readonly onDidChangePreparation = this.preparationChanged.event;
	private recording: Recording | undefined;
	private currentState = SpeechToTextState.Idle;
	public get state(): SpeechToTextState { return this.currentState; }
	public get isBusy(): boolean { return this.state !== SpeechToTextState.Idle; }
	public get isStarting(): boolean { return !!this.recording && !this.recording.handle; }
	public get isConfigured(): boolean { return !!this.backend; }

	constructor(@IDictationService private readonly backend: IDictationService | undefined) {
		super();
		if (backend) {
			this._register(backend.onDidChangePreparation(() => this.preparationChanged.fire()));
		}
	}

	public getPreparation(): Promise<ILocalTranscriptionModelSnapshot | undefined> {
		return this.backend!.getPreparation();
	}

	public prepareModel(): Promise<void> {
		return this.backend!.prepareModel();
	}

	public cancelPreparation(): Promise<void> {
		return this.backend!.cancelPreparation();
	}

	public getOptions(): Promise<IDictationOptions> {
		return this.backend!.getOptions();
	}

	public async start(): Promise<void> {
		this.assertNotDisposed();
		if (!this.isConfigured) { throw new Error(localize('chat.input.dictationUnavailable', 'Dictation is unavailable')); }
		if (this.isBusy) { throw new Error(localize('dictation.alreadyActive', 'Dictation is already active')); }
		const recording: Recording = { finalizedText: '', cancelled: false };
		this.recording = recording;
		this.setState(SpeechToTextState.Recording);
		recording.starting = this.startRecording(recording);
		try {
			await recording.starting;
		} finally {
			recording.starting = undefined;
			if (!this.isDisposed) { this.stateChanged.fire(this.state); }
		}
	}

	private async startRecording(recording: Recording): Promise<void> {
		try {
			const handle = await this.backend!.start((text, isFinal) => {
				if (this.recording !== recording || recording.cancelled || this.isDisposed) { return; }
				const separator = /[A-Za-z0-9]$/u.test(recording.finalizedText) && /^[A-Za-z0-9]/u.test(text) ? ' ' : '';
				const transcript = recording.finalizedText + separator + text;
				if (isFinal) { recording.finalizedText = transcript; }
				this.transcript.fire({ text: transcript, finalizedText: recording.finalizedText });
			}, error => {
				if (this.recording !== recording || this.isDisposed) { return; }
				// During stop the handle still owns flushing its last phrase. Idle must follow that flush.
				this.ended.fire(error);
				if (!recording.stopping) {
					this.recording = undefined;
					this.setState(SpeechToTextState.Idle);
				}
			});
			if (this.recording !== recording || this.isDisposed) { await handle.stop(); }
			else { recording.handle = handle; }
		} catch (error) {
			if (this.recording === recording) {
				this.recording = undefined;
				this.setState(SpeechToTextState.Idle);
			}
			throw error;
		}
	}

	public stopAndTranscribe(): Promise<string | undefined> {
		const recording = this.recording;
		if (!recording) { return Promise.resolve(undefined); }
		if (recording.stopping) { return recording.stopping; }
		this.setState(SpeechToTextState.Transcribing);
		recording.stopping = this.stopRecording(recording);
		return recording.stopping;
	}

	public async cancel(): Promise<void> {
		if (this.recording) { this.recording.cancelled = true; }
		await this.stopAndTranscribe();
	}

	private async stopRecording(recording: Recording): Promise<string | undefined> {
		try {
			await recording.starting;
			await recording.handle?.stop();
			return recording.cancelled ? undefined : recording.finalizedText || undefined;
		} finally {
			if (this.recording === recording) {
				this.recording = undefined;
				this.setState(SpeechToTextState.Idle);
			}
		}
	}

	private setState(state: SpeechToTextState): void {
		if (this.currentState === state) { return; }
		this.currentState = state;
		if (!this.isDisposed) { this.stateChanged.fire(state); }
	}

	protected override disposeCore(): void {
		void this.cancel().catch(() => undefined);
		super.disposeCore();
	}
}
