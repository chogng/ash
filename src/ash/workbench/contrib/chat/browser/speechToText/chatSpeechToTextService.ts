import { Emitter, type Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { canceled, isCancellationError } from '../../../../../base/common/errors.js';
import { RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IDictationBackendService, type IDictationSession, type IDictationInputOptions } from '../../../../../platform/renderer/common/dictation.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILocalTranscriptionService, type ILocalTranscriptionModelSnapshot } from '../../../../../platform/localTranscription/common/localTranscription.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { DictationConfiguration, dictationBackend, dictationInputOptions } from '../../common/constants.js';
import { ISpeechService, SpeechToTextStatus } from '../../../speech/common/speechService.js';
import { localize } from '../../../../../nls.js';

export const IChatSpeechToTextService = createDecorator<IChatSpeechToTextService>('chatSpeechToTextService');
export const ChatSpeechToTextInProgress = new RawContextKey<boolean>('chatSpeechToTextInProgress', false);

export enum ChatSpeechToTextState {
	Idle = 'idle',
	Recording = 'recording',
	Transcribing = 'transcribing',
}

export type ChatDictationSurface = 'chat' | 'editor' | 'terminal';

export interface IChatDictationTranscript {
	readonly text: string;
	readonly finalizedText: string;
}

export interface IChatSpeechToTextService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeState: Event<ChatSpeechToTextState>;
	readonly state: ChatSpeechToTextState;
	readonly isBusy: boolean;
	readonly isStarting: boolean;
	readonly currentSurface: ChatDictationSurface;
	readonly isConfigured: boolean;
	readonly onDidUpdateTranscript: Event<IChatDictationTranscript>;
	readonly onDidEnd: Event<string | undefined>;
	readonly onDidChangePreparation: Event<void>;
	getPreparation(): Promise<ILocalTranscriptionModelSnapshot | undefined>;
	getOptions(): Promise<IDictationInputOptions | undefined>;
	start(window: Window & typeof globalThis, surface?: ChatDictationSurface): Promise<void>;
	stopAndTranscribe(): Promise<string | undefined>;
	cancel(): Promise<void>;
}

interface Recording {
	readonly lifetime: DisposableStore;
	readonly cancellation: CancellationTokenSource;
	starting?: Promise<void>;
	handle?: IDictationSession;
	stopping?: Promise<string | undefined>;
	cancelling?: Promise<void>;
	finalizedText: string;
	cancelled: boolean;
	started: boolean;
	error?: string;
}

/** Owns input dictation across surfaces. Audio capture and transport stay with the host. */
export class ChatSpeechToTextService extends Disposable implements IChatSpeechToTextService {
	public readonly _serviceBrand = undefined;
	private readonly stateChanged = this._register(new Emitter<ChatSpeechToTextState>());
	public readonly onDidChangeState = this.stateChanged.event;
	private readonly transcript = this._register(new Emitter<IChatDictationTranscript>());
	public readonly onDidUpdateTranscript = this.transcript.event;
	private readonly ended = this._register(new Emitter<string | undefined>());
	public readonly onDidEnd = this.ended.event;
	private readonly preparationChanged = this._register(new Emitter<void>());
	public readonly onDidChangePreparation = this.preparationChanged.event;
	private recording: Recording | undefined;
	private currentState = ChatSpeechToTextState.Idle;
	public get state(): ChatSpeechToTextState { return this.currentState; }
	public get isBusy(): boolean { return !!this.recording; }
	public get isStarting(): boolean { return !!this.recording && !this.recording.started; }
	public currentSurface: ChatDictationSurface = 'chat';
	public get isConfigured(): boolean {
		if (this.speech.hasSpeechProvider) return true;
		try {
			return dictationBackend(this.configuration).type === 'local' ? this.localTranscription.isSupported : !!this.backend;
		} catch { return false; }
	}

	constructor(
		@IDictationBackendService private readonly backend: IDictationBackendService | undefined,
		@ISpeechService private readonly speech: ISpeechService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@ILocalTranscriptionService private readonly localTranscription: ILocalTranscriptionService,
	) {
		super();
		if (backend) this._register(backend.onDidChangeAvailability(() => this.preparationChanged.fire()));
		this._register(localTranscription.onDidChangeModels(() => this.preparationChanged.fire()));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (Object.values(DictationConfiguration).some(key => event.affectsConfiguration(key))) this.preparationChanged.fire();
		}));
		this._register(speech.onDidChangeHasSpeechProvider(() => this.preparationChanged.fire()));
		const inProgress = ChatSpeechToTextInProgress.bindTo(contextKeys);
		this._register(this.onDidChangeState(() => inProgress.set(this.isBusy)));
		this._register(toDisposable(() => inProgress.reset()));
	}

	public getPreparation(): Promise<ILocalTranscriptionModelSnapshot | undefined> {
		if (this.speech.hasSpeechProvider) return Promise.resolve(undefined);
		const backend = dictationBackend(this.configuration);
		return backend.type === 'local' && this.localTranscription.isSupported
			? this.localTranscription.getModelStatus(backend.modelId)
			: Promise.resolve(undefined);
	}

	public getOptions(): Promise<IDictationInputOptions | undefined> {
		return this.speech.hasSpeechProvider || !this.backend ? Promise.resolve(undefined) : this.backend.getOptions(dictationBackend(this.configuration));
	}

	public async start(_window: Window & typeof globalThis, surface: ChatDictationSurface = 'chat'): Promise<void> {
		this.assertNotDisposed();
		if (!this.isConfigured) throw new Error(localize('chat.input.dictationUnavailable', 'Dictation is unavailable'));
		if (this.isBusy || this.speech.hasActiveSpeechToTextSession) throw new Error(localize('dictation.alreadyActive', 'Dictation is already active'));
		const lifetime = new DisposableStore();
		const cancellation = lifetime.add(new CancellationTokenSource());
		const recording: Recording = { lifetime, cancellation, finalizedText: '', cancelled: false, started: false };
		this.recording = recording;
		this.currentSurface = surface;
		this.setState(ChatSpeechToTextState.Recording);
		recording.starting = this.startRecording(recording);
		try {
			await recording.starting;
			if (recording.cancelled || this.isDisposed) throw canceled();
		} finally {
			recording.starting = undefined;
			if (!this.isDisposed) this.stateChanged.fire(this.state);
		}
	}

	private async startRecording(recording: Recording): Promise<void> {
		try {
			// State listeners can cancel synchronously before any microphone is acquired.
			if (recording.cancelled || this.recording !== recording || this.isDisposed) throw canceled();
			if (this.speech.hasSpeechProvider) {
				const session = await this.speech.createSpeechToTextSession(recording.cancellation.token, this.currentSurface);
				recording.handle = {
					stop: async () => { recording.cancellation.cancel(); },
					cancel: async () => { recording.cancellation.cancel(); },
				};
				recording.lifetime.add(session.onDidChange(event => {
					if (this.recording !== recording || recording.cancelled || this.isDisposed) return;
					if (event.status === SpeechToTextStatus.Started) {
						recording.started = true;
						this.stateChanged.fire(this.state);
					} else if (event.status === SpeechToTextStatus.Recognizing || event.status === SpeechToTextStatus.Recognized) {
						this.receiveTranscript(recording, event.text ?? '', event.status === SpeechToTextStatus.Recognized);
					} else if (event.status === SpeechToTextStatus.Error || event.status === SpeechToTextStatus.Stopped) {
						if (event.status === SpeechToTextStatus.Error) recording.error = event.text;
						if (!recording.stopping) this.finish(recording);
					}
				}));
			} else {
				const backend = dictationBackend(this.configuration);
				const options = dictationInputOptions(this.configuration, backend.type);
				if (backend.type === 'local') {
					// Model selection is a Workbench decision; the existing local service owns capture and inference.
					recording.lifetime.add(this.localTranscription.onDidTranscribe(result => this.receiveTranscript(recording, result.text, result.isFinal)));
					recording.lifetime.add(this.localTranscription.onDidEnd(result => {
						if (this.recording !== recording) return;
						recording.error = result.error;
						if (!recording.stopping) this.finish(recording);
					}));
					await this.localTranscription.start({ model: backend.modelId, inputDevice: options.inputDevice ?? undefined });
					const handle: IDictationSession = {
						stop: async () => { await this.localTranscription.stop(); },
						cancel: () => this.localTranscription.cancel(),
					};
					if (this.recording !== recording || this.isDisposed) await handle.cancel();
					else { recording.handle = handle; recording.started = !recording.cancelled; }
					return;
				}
				const handle = await this.backend!.start(
					{ backend, ...options },
					(text, isFinal) => this.receiveTranscript(recording, text, isFinal),
					error => {
						if (this.recording !== recording) return;
						recording.error = error;
						// stop owns the final flush; publish Idle only after its promise settles.
						if (!recording.stopping) this.finish(recording);
					},
				);
				if (this.recording !== recording || this.isDisposed) await handle.cancel();
				else { recording.handle = handle; recording.started = !recording.cancelled; }
			}
		} catch (error) {
			this.finish(recording);
			throw error;
		}
	}

	private receiveTranscript(recording: Recording, text: string, isFinal: boolean): void {
		if (this.recording !== recording || recording.cancelled || this.isDisposed) return;
		const separator = /[A-Za-z0-9]$/u.test(recording.finalizedText) && /^[A-Za-z0-9]/u.test(text) ? ' ' : '';
		const transcript = recording.finalizedText + separator + text;
		if (isFinal) recording.finalizedText = transcript;
		this.transcript.fire({ text: transcript, finalizedText: recording.finalizedText });
	}

	public stopAndTranscribe(): Promise<string | undefined> {
		const recording = this.recording;
		if (!recording) return Promise.resolve(undefined);
		if (recording.stopping) return recording.stopping;
		// Reserve stop before notifying state listeners, which may request it again.
		recording.stopping = Promise.resolve().then(() => this.stopRecording(recording));
		this.setState(ChatSpeechToTextState.Transcribing);
		return recording.stopping;
	}

	public async cancel(): Promise<void> {
		const recording = this.recording;
		if (!recording) return;
		recording.cancelled = true;
		recording.cancellation.cancel();
		if (recording.handle) recording.cancelling ??= recording.handle.cancel();
		await Promise.all([recording.cancelling, this.stopAndTranscribe()]);
	}

	private async stopRecording(recording: Recording): Promise<string | undefined> {
		try {
			await recording.starting;
			if (recording.cancelled && recording.handle) await (recording.cancelling ??= recording.handle.cancel());
			else await recording.handle?.stop();
			return recording.cancelled ? undefined : recording.finalizedText || undefined;
		} catch (error) {
			if (recording.cancelled || isCancellationError(error)) return undefined;
			throw error;
		} finally {
			this.finish(recording);
		}
	}

	private finish(recording: Recording): void {
		if (this.recording !== recording) return;
		this.recording = undefined;
		recording.lifetime.dispose();
		this.ended.fire(recording.error);
		this.setState(ChatSpeechToTextState.Idle);
	}

	private setState(state: ChatSpeechToTextState): void {
		if (this.currentState === state) return;
		this.currentState = state;
		if (!this.isDisposed) this.stateChanged.fire(state);
	}

	protected override disposeCore(): void {
		void this.cancel().catch(() => undefined);
		super.disposeCore();
	}
}
