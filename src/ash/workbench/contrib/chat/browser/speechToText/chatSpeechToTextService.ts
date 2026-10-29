import { Emitter, type Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { canceled, isCancellationError } from '../../../../../base/common/errors.js';
import { RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import {
	IVoiceCodeTranscriptionBackendService,
	type DictationBackend,
} from '../../../../../platform/renderer/common/dictation.js';
import { DeferredPromise, raceCancellation } from '../../../../../base/common/async.js';
import { VSBuffer, encodeBase64 } from '../../../../../base/common/buffer.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IVoiceCodeTranscriptionClient } from './voiceCodeTranscriptionClient.js';
import { createPcmCaptureNode, type IPcmCaptureNode } from '../pcmCaptureWorklet.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import {
	ILocalTranscriptionService,
	ILocalTranscriptionModelService,
	LocalTranscriptionModelState,
} from '../../../../../platform/localTranscription/common/localTranscription.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { DictationConfiguration, dictationBackend, dictationInputOptions } from '../../common/constants.js';
import { ISpeechService, SpeechToTextStatus } from '../../../speech/common/speechService.js';
import { localize } from '../../../../../nls.js';

export const IChatSpeechToTextService = createDecorator<IChatSpeechToTextService>('chatSpeechToTextService');
export const ChatSpeechToTextInProgress = new RawContextKey<boolean>('chatSpeechToTextInProgress', false);
export const DICTATION_MODEL_SETTING = 'dictation.model';
export const enum DictationSettingId {
	ShowTranscript = 'dictation.showTranscript',
	ShowButton = 'dictation.showButton',
}

export const enum ChatSpeechToTextState {
	Idle = 'idle',
	Recording = 'recording',
	Transcribing = 'transcribing',
}

export type ChatDictationSurface = 'chat' | 'editor' | 'terminal';

export interface IChatDictationTranscript {
	readonly text: string;
	readonly finalizedText: string;
}

export interface IDictationAccuracyMeasurement {
	readonly dictatedText: string;
	readonly submittedText: string;
	readonly backend: string;
	readonly surface: ChatDictationSurface;
	readonly submitted: boolean;
}

export interface IChatSpeechToTextStopOptions {
	readonly preserveLiveTranscript?: boolean;
}

export interface IChatSpeechToTextService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeState: Event<ChatSpeechToTextState>;
	readonly state: ChatSpeechToTextState;
	readonly isBusy: boolean;
	readonly currentSurface: ChatDictationSurface;
	readonly isConfigured: boolean;
	readonly onDidUpdateTranscript: Event<IChatDictationTranscript>;
	readonly showTranscriptWhileDictating: boolean;
	readonly analyserNode: AnalyserNode | undefined;
	switchMicrophone(window: Window & typeof globalThis, deviceId: string): Promise<AnalyserNode | undefined>;
	readonly onDidChangePreparingModel: Event<boolean>;
	readonly isPreparingModel: boolean;
	readonly onDidChangeDownloadingModel: Event<boolean>;
	readonly isDownloadingModel: boolean;
	readonly onDidChangeModelDownloadProgress: Event<void>;
	readonly modelDownloadProgress: number | undefined;
	start(window: Window & typeof globalThis, surface?: ChatDictationSurface): Promise<void>;
	stopAndTranscribe(options?: IChatSpeechToTextStopOptions): Promise<string | undefined>;
	cancel(): Promise<void>;
	readonly currentBackend: string;
	logDictationAccuracy(measurement: IDictationAccuracyMeasurement): void;
}

export function isDictationActiveOnSurface(service: IChatSpeechToTextService, surface: ChatDictationSurface): boolean {
	return service.currentSurface === surface && service.isBusy;
}

interface RecordingHandle {
	stop(): Promise<string | undefined>;
	cancel(): Promise<void>;
}

interface Capture {
	readonly context: AudioContext;
	readonly analyser: AnalyserNode;
	readonly pcm: IPcmCaptureNode;
	stream: MediaStream;
	source: MediaStreamAudioSourceNode;
	closed: boolean;
	microphoneRevision: number;
}

interface Recording {
	readonly window: Window & typeof globalThis;
	readonly lifetime: DisposableStore;
	readonly cancellation: CancellationTokenSource;
	readonly backend: DictationBackend | 'extension';
	readonly inputDevice: string | null;
	readonly language: string | null;
	starting?: Promise<void>;
	handle?: RecordingHandle;
	capture?: Capture;
	stopping?: Promise<string | undefined>;
	cancelling?: Promise<void>;
	finalizedText: string;
	cancelled: boolean;
	started: boolean;
	error?: string;
	liveText: string;
	preserveLiveTranscript?: boolean;
	finalText?: string;
	timedOut?: boolean;
}

/** Owns dictation and renderer audio capture across surfaces; inference and credentials stay with the host. */
export class ChatSpeechToTextService extends Disposable implements IChatSpeechToTextService {
	public readonly _serviceBrand = undefined;
	private readonly stateChanged = this._register(new Emitter<ChatSpeechToTextState>());
	public readonly onDidChangeState = this.stateChanged.event;
	private readonly transcript = this._register(new Emitter<IChatDictationTranscript>());
	public readonly onDidUpdateTranscript = this.transcript.event;
	private readonly preparing = this._register(new Emitter<boolean>());
	public readonly onDidChangePreparingModel = this.preparing.event;
	private readonly downloading = this._register(new Emitter<boolean>());
	public readonly onDidChangeDownloadingModel = this.downloading.event;
	private readonly progress = this._register(new Emitter<void>());
	public readonly onDidChangeModelDownloadProgress = this.progress.event;
	public isPreparingModel = false;
	public isDownloadingModel = false;
	/** The backend reports file bytes without an aggregate total; downloads remain indeterminate. */
	public get modelDownloadProgress(): number | undefined {
		return undefined;
	}
	public currentBackend = '';
	public get showTranscriptWhileDictating(): boolean {
		return this.configuration.getValue<boolean>('dictation.showTranscript') ?? true;
	}
	private recording: Recording | undefined;
	private releasing: Promise<void> = Promise.resolve();
	private currentState = ChatSpeechToTextState.Idle;
	public get state(): ChatSpeechToTextState {
		return this.currentState;
	}
	public get isBusy(): boolean {
		return !!this.recording;
	}
	public currentSurface: ChatDictationSurface = 'chat';
	public get isConfigured(): boolean {
		if (this.configuration.getValue<boolean>(DictationConfiguration.enabled) === false) return false;
		if (this.speech.hasSpeechProvider) return true;
		try {
			return dictationBackend(this.configuration).type === 'local'
				? this.localTranscription.isSupported && this.localModels.isSupported
				: this.backend?.isConnected === true;
		} catch {
			return false;
		}
	}

	constructor(
		@IVoiceCodeTranscriptionBackendService
		private readonly backend: IVoiceCodeTranscriptionBackendService | undefined,
		@ISpeechService private readonly speech: ISpeechService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@ILocalTranscriptionService private readonly localTranscription: ILocalTranscriptionService,
		@IVoiceCodeTranscriptionClient private readonly transcription: IVoiceCodeTranscriptionClient,
		@INotificationService private readonly notifications: INotificationService,
		@ITelemetryService private readonly telemetry: ITelemetryService,
		@ILocalTranscriptionModelService private readonly localModels: ILocalTranscriptionModelService,
	) {
		super();
		if (backend) this._register(backend.onDidChangeConnection(() => this.stateChanged.fire(this.state)));
		this._register(localModels.onDidChangeModels(() => this.stateChanged.fire(this.state)));
		this._register(
			configuration.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(DictationConfiguration.enabled) && !this.isConfigured)
					void this.cancel().catch(() => undefined);
				if (
					Object.values(DictationConfiguration).some(key => event.affectsConfiguration(key)) ||
					event.affectsConfiguration('dictation.showTranscript')
				)
					this.stateChanged.fire(this.state);
			}),
		);
		this._register(speech.onDidChangeHasSpeechProvider(() => this.stateChanged.fire(this.state)));
		this._register(
			localTranscription.onDidChangeModelStatus(status => {
				if (!this.recording || this.currentBackend !== 'local') return;
				const downloading = status.state === LocalTranscriptionModelState.Downloading;
				const preparing = downloading || status.state === LocalTranscriptionModelState.Loading;
				if (this.isDownloadingModel !== downloading) {
					this.isDownloadingModel = downloading;
					this.downloading.fire(downloading);
				}
				if (this.isPreparingModel !== preparing) {
					this.isPreparingModel = preparing;
					this.preparing.fire(preparing);
				}
				this.progress.fire();
			}),
		);
		const inProgress = ChatSpeechToTextInProgress.bindTo(contextKeys);
		this._register(this.onDidChangeState(() => inProgress.set(this.isBusy)));
		this._register(toDisposable(() => inProgress.reset()));
	}

	public async start(window: Window & typeof globalThis, surface: ChatDictationSurface = 'chat'): Promise<void> {
		this.assertNotDisposed();
		if (!this.isConfigured)
			throw new Error(localize('chat.input.dictationUnavailable', 'Dictation is unavailable'));
		if (this.isBusy || this.speech.hasActiveSpeechToTextSession)
			throw new Error(localize('dictation.alreadyActive', 'Dictation is already active'));
		const backend = this.speech.hasSpeechProvider ? 'extension' : dictationBackend(this.configuration);
		const options =
			backend === 'extension'
				? { inputDevice: null, language: null }
				: dictationInputOptions(this.configuration, backend.type);
		const lifetime = new DisposableStore();
		const cancellation = lifetime.add(new CancellationTokenSource());
		const recording: Recording = {
			window,
			lifetime,
			cancellation,
			backend,
			...options,
			finalizedText: '',
			liveText: '',
			cancelled: false,
			started: false,
		};
		this.recording = recording;
		this.currentSurface = surface;
		this.currentBackend = backend === 'extension' ? 'extension' : backend.type;
		this.stateChanged.fire(this.state);
		recording.starting = this.startRecording(recording);
		try {
			if (recording.starting) await raceCancellation(recording.starting, recording.cancellation.token);
			if (recording.cancelled || this.isDisposed) throw canceled();
			if (this.recording === recording && recording.started) this.setState(ChatSpeechToTextState.Recording);
		} finally {
			recording.starting = undefined;
			if (!this.isDisposed) this.stateChanged.fire(this.state);
		}
	}

	private async startRecording(recording: Recording): Promise<void> {
		try {
			recording.lifetime.add(
				toDisposable(() => {
					if (recording.capture) void this.closeCapture(recording.capture).catch(() => undefined);
				}),
			);
			await this.releasing;
			// State listeners can cancel synchronously before any microphone is acquired.
			if (recording.cancelled || this.recording !== recording || this.isDisposed) throw canceled();
			if (recording.backend === 'extension') {
				const session = await this.speech.createSpeechToTextSession(
					recording.cancellation.token,
					this.currentSurface,
				);
				recording.handle = {
					stop: async () => {
						recording.cancellation.cancel();
						return undefined;
					},
					cancel: async () => {
						recording.cancellation.cancel();
					},
				};
				recording.lifetime.add(
					session.onDidChange(event => {
						if (this.recording !== recording || recording.cancelled || this.isDisposed) return;
						if (event.status === SpeechToTextStatus.Started) {
							recording.started = true;
							this.setState(ChatSpeechToTextState.Recording);
							this.stateChanged.fire(this.state);
						} else if (
							event.status === SpeechToTextStatus.Recognizing ||
							event.status === SpeechToTextStatus.Recognized
						) {
							this.receiveTranscript(
								recording,
								event.text ?? '',
								event.status === SpeechToTextStatus.Recognized,
							);
						} else if (
							event.status === SpeechToTextStatus.Error ||
							event.status === SpeechToTextStatus.Stopped
						) {
							if (event.status === SpeechToTextStatus.Error) recording.error = event.text;
							if (!recording.stopping) this.finish(recording);
						}
					}),
				);
			} else {
				const backend = recording.backend;
				if (backend.type === 'local') {
					// Workbench owns microphone capture; the local service owns model preparation and inference.
					recording.lifetime.add(
						this.localTranscription.onDidTranscribe(result =>
							this.receiveTranscript(recording, result.text, result.isFinal, true),
						),
					);
					recording.lifetime.add(
						this.localTranscription.onDidChangeModelStatus(result => {
							if (this.recording !== recording) return;
							if (
								result.state !== LocalTranscriptionModelState.Idle &&
								result.state !== LocalTranscriptionModelState.Error
							)
								return;
							recording.error = result.error;
							if (!recording.stopping) this.finish(recording);
						}),
					);
					const cacheDir = await this.localModels.getCacheDirectory();
					if (recording.cancelled || this.recording !== recording || this.isDisposed) throw canceled();
					const handle: RecordingHandle = {
						stop: async () => {
							if (recording.capture) {
								await recording.capture.pcm.flush();
								await this.closeCapture(recording.capture);
							}
							return this.localTranscription.stop();
						},
						cancel: async () => {
							if (recording.capture) await this.closeCapture(recording.capture);
							await this.localTranscription.cancel();
						},
					};
					recording.handle = handle;
					recording.lifetime.add(
						toDisposable(() => {
							void this.cancelHandle(recording).catch(() => undefined);
						}),
					);
					await this.localTranscription.start({ cacheDir, model: backend.modelId });
					if (this.recording !== recording || recording.cancelled || this.isDisposed)
						await this.cancelHandle(recording);
					else {
						await this.capture(recording, recording.inputDevice, samples => {
							void this.localTranscription.pushAudio(pcm16(samples)).catch(error => {
								if (this.recording !== recording || recording.cancelled) return;
								recording.error = String(error);
								if (!recording.stopping) this.finish(recording);
							});
						});
						recording.started = !recording.cancelled;
					}
					return;
				}
				const done = new DeferredPromise<string>();
				void done.p.catch(() => undefined);
				const turnId = generateUuid();
				recording.lifetime.add(
					this.transcription.onTranscription(event => {
						if (event.turnId !== turnId || this.recording !== recording || recording.cancelled) return;
						this.receiveTranscript(recording, event.text, event.status === 'final', true);
						if (event.status === 'final') void done.complete(event.text);
					}),
				);
				recording.lifetime.add(
					this.transcription.onError(event => {
						if (
							(event.turnId && event.turnId !== turnId) ||
							this.recording !== recording ||
							recording.cancelled
						)
							return;
						recording.error = event.detail;
						void done.error(new Error(event.detail));
						if (!recording.stopping) this.finish(recording);
					}),
				);
				recording.lifetime.add(
					toDisposable(() => {
						this.transcription.disconnect();
					}),
				);
				await this.transcription.connect(recording.window, '');
				if (this.recording !== recording || recording.cancelled || this.isDisposed) throw canceled();
				await this.transcription.startSession({ backend, language: recording.language });
				if (this.recording !== recording || recording.cancelled || this.isDisposed) throw canceled();
				this.transcription.sendPttStart(turnId);
				recording.handle = {
					stop: async () => {
						if (recording.capture) {
							await recording.capture.pcm.flush();
							await this.closeCapture(recording.capture);
						}
						if (recording.cancelled) return undefined;
						this.transcription.sendPttEnd(turnId);
						return done.p;
					},
					cancel: async () => {
						this.transcription.disconnect();
						if (recording.capture) await this.closeCapture(recording.capture);
						await done.complete('');
					},
				};
				await this.capture(recording, recording.inputDevice, samples => {
					this.transcription.sendPttAudioChunk(turnId, encodeBase64(pcm16(samples)));
				});
				recording.started = !recording.cancelled;
			}
		} catch (error) {
			const reported = this.recording !== recording && !!recording.error;
			this.finish(recording);
			if (reported) throw canceled();
			throw error;
		}
	}

	public get analyserNode(): AnalyserNode | undefined {
		return this.recording?.capture?.analyser;
	}

	public async switchMicrophone(
		window: Window & typeof globalThis,
		deviceId: string,
	): Promise<AnalyserNode | undefined> {
		const recording = this.recording;
		const capture = recording?.capture;
		if (!recording || !capture || capture.closed) return undefined;
		const revision = ++capture.microphoneRevision;
		const stream = await window.navigator.mediaDevices.getUserMedia({
			audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 1 },
		});
		if (this.recording !== recording || capture.closed || revision !== capture.microphoneRevision) {
			stream.getTracks().forEach(track => track.stop());
			return undefined;
		}
		try {
			const source = capture.context.createMediaStreamSource(stream);
			source.connect(capture.analyser);
			capture.source.disconnect();
			capture.stream.getTracks().forEach(track => track.stop());
			capture.stream = stream;
			capture.source = source;
			return capture.analyser;
		} catch (error) {
			stream.getTracks().forEach(track => track.stop());
			throw error;
		}
	}

	private async capture(
		recording: Recording,
		deviceId: string | null,
		onChunk: (samples: Float32Array) => void,
	): Promise<void> {
		const window = recording.window;
		const stream = await window.navigator.mediaDevices.getUserMedia({
			audio: {
				deviceId: deviceId ? { exact: deviceId } : undefined,
				channelCount: 1,
				echoCancellation: true,
				noiseSuppression: true,
			},
		});
		if (this.recording !== recording || recording.cancelled || this.isDisposed) {
			stream.getTracks().forEach(track => track.stop());
			throw canceled();
		}
		let context: AudioContext | undefined;
		try {
			context = new window.AudioContext({ sampleRate: 16000 });
			const analyser = context.createAnalyser();
			const source = context.createMediaStreamSource(stream);
			const pcm = await createPcmCaptureNode(window, context, 4096, samples => {
				if (this.recording !== recording || recording.cancelled) return;
				try {
					onChunk(samples);
				} catch (error) {
					recording.error = String(error);
					this.finish(recording);
				}
			});
			recording.capture = { context, analyser, source, pcm, stream, closed: false, microphoneRevision: 0 };
			if (this.recording !== recording || recording.cancelled || this.isDisposed) {
				await this.closeCapture(recording.capture);
				throw canceled();
			}
			source.connect(analyser);
			analyser.connect(pcm.node);
			pcm.node.connect(context.destination);
			await context.resume();
		} catch (error) {
			stream.getTracks().forEach(track => track.stop());
			if (context && context.state !== 'closed') await context.close();
			throw error;
		}
	}

	private async closeCapture(capture: Capture): Promise<void> {
		if (capture.closed) return;
		capture.closed = true;
		capture.stream.getTracks().forEach(track => track.stop());
		capture.source.disconnect();
		capture.analyser.disconnect();
		capture.pcm.node.disconnect();
		capture.pcm.node.port.onmessage = null;
		if (capture.context.state !== 'closed') await capture.context.close();
	}

	private receiveTranscript(recording: Recording, text: string, isFinal: boolean, snapshot = false): void {
		if (this.recording !== recording || recording.cancelled || recording.timedOut || this.isDisposed) return;
		const separator = /[A-Za-z0-9]$/u.test(recording.finalizedText) && /^[A-Za-z0-9]/u.test(text) ? ' ' : '';
		const transcript = snapshot ? text : recording.finalizedText + separator + text;
		const visible =
			isFinal &&
			recording.preserveLiveTranscript &&
			recording.liveText &&
			!transcript.startsWith(recording.liveText)
				? recording.liveText
				: transcript;
		if (recording.liveText === visible && (!isFinal || recording.finalText === visible)) return;
		recording.liveText = visible;
		if (isFinal) recording.finalText = recording.finalizedText = visible;
		this.transcript.fire({ text: visible, finalizedText: recording.finalizedText });
	}

	public stopAndTranscribe(options?: IChatSpeechToTextStopOptions): Promise<string | undefined> {
		const recording = this.recording;
		if (!recording) return Promise.resolve(undefined);
		if (recording.stopping) return recording.stopping;
		recording.preserveLiveTranscript = options?.preserveLiveTranscript;
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
		if (!recording.handle && this.currentBackend !== 'local' && this.currentBackend !== 'extension')
			this.transcription.disconnect();
		if (recording.handle) void this.cancelHandle(recording).catch(() => undefined);
		await Promise.all([recording.cancelling, this.stopAndTranscribe()]);
	}

	private async stopRecording(recording: Recording): Promise<string | undefined> {
		try {
			if (recording.starting) await raceCancellation(recording.starting, recording.cancellation.token);
			if (recording.cancelled) {
				await this.cancelHandle(recording);
				return undefined;
			}
			const final = await this.finalize(recording);
			if (recording.cancelled) return undefined;
			if (final !== undefined && final !== recording.finalText)
				this.receiveTranscript(recording, final, true, true);
			return recording.finalText ?? (recording.finalizedText || undefined);
		} catch (error) {
			if (recording.cancelled || isCancellationError(error)) return undefined;
			throw error;
		} finally {
			this.finish(recording);
		}
	}

	private cancelHandle(recording: Recording): Promise<void> {
		if (!recording.handle) return Promise.resolve();
		if (!recording.cancelling) {
			const handle = recording.handle;
			// Reserve before invoking a backend: cancellation can publish Idle synchronously.
			recording.cancelling = Promise.resolve().then(() => handle.cancel());
			this.releasing = recording.cancelling.catch(() => undefined);
		}
		return recording.cancelling;
	}

	private async finalize(recording: Recording): Promise<string | undefined> {
		const expired = Symbol('expired');
		const cancelled = Symbol('cancelled');
		const deadline = recording.backend !== 'extension' && recording.backend.type === 'local' ? 8000 : 35000;
		let timer: number | undefined;
		const timeout = new Promise<typeof expired>(resolve => {
			timer = recording.window.setTimeout(() => resolve(expired), deadline);
		});
		let cancel!: () => void;
		const cancellation = new Promise<typeof cancelled>(resolve => {
			cancel = () => resolve(cancelled);
		});
		using listener = recording.cancellation.token.onCancellationRequested(cancel);
		if (recording.cancelled) cancel();
		try {
			const final = await Promise.race([
				Promise.resolve().then(() => recording.handle?.stop()),
				timeout,
				cancellation,
			]);
			if (final === cancelled) {
				await this.cancelHandle(recording);
				return undefined;
			}
			if (final !== expired) return final;
			// Retire delivery before cancelling; a late backend result must not replace the streamed fallback.
			const fallback = recording.liveText;
			if (fallback.trim()) this.receiveTranscript(recording, fallback, true, true);
			recording.timedOut = true;
			void this.cancelHandle(recording).catch(() => undefined);
			if (!fallback.trim())
				throw new Error(
					localize(
						'dictation.finalizationTimeout',
						'Transcription timed out without returning text. Try recording again.',
					),
				);
			return recording.finalText;
		} finally {
			if (timer !== undefined) recording.window.clearTimeout(timer);
		}
	}

	private finish(recording: Recording): void {
		if (this.recording !== recording) return;
		this.recording = undefined;
		recording.lifetime.dispose();
		if (recording.error && !recording.stopping && !recording.cancelled)
			this.notifications.error(localize('chat.input.dictationFailed', 'Dictation failed: {0}', recording.error));
		if (this.isPreparingModel) {
			this.isPreparingModel = false;
			this.preparing.fire(false);
		}
		if (this.isDownloadingModel) {
			this.isDownloadingModel = false;
			this.downloading.fire(false);
		}
		this.setState(ChatSpeechToTextState.Idle);
	}

	public logDictationAccuracy(measurement: IDictationAccuracyMeasurement): void {
		const { dictatedText, submittedText } = measurement;
		if (!dictatedText || dictatedText.length > 4096 || submittedText.length > 4096) return;
		let previous = Array.from({ length: submittedText.length + 1 }, (_, index) => index);
		for (let row = 1; row <= dictatedText.length; row++) {
			const current = [row];
			for (let column = 1; column <= submittedText.length; column++) {
				current[column] = Math.min(
					current[column - 1] + 1,
					previous[column] + 1,
					previous[column - 1] + Number(dictatedText[row - 1] !== submittedText[column - 1]),
				);
			}
			previous = current;
		}
		this.telemetry.publicLog('dictation.accuracy', {
			backend: measurement.backend,
			surface: measurement.surface,
			submitted: measurement.submitted,
			dictatedLength: dictatedText.length,
			submittedLength: submittedText.length,
			editDistance: previous[submittedText.length],
		});
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

function pcm16(samples: Float32Array): VSBuffer {
	const bytes = new Uint8Array(samples.length * 2);
	const view = new DataView(bytes.buffer);
	samples.forEach((sample, index) => {
		const value = Math.max(-1, Math.min(1, sample));
		view.setInt16(index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
	});
	return VSBuffer.wrap(bytes);
}
