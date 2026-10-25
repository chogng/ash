import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, type Event } from '../../../../../base/common/event.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { canceled } from '../../../../../base/common/errors.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IVoiceCodeTranscriptionBackendService, type DictationBackend } from '../../../../../platform/renderer/common/dictation.js';
import { dictationBackend, dictationInputOptions } from '../../common/constants.js';
import { localize } from '../../../../../nls.js';

export const IVoiceCodeTranscriptionClient = createDecorator<IVoiceCodeTranscriptionClient>('voiceCodeTranscriptionClient');

export interface IVoiceCodeTranscription {
	readonly turnId: string;
	readonly text: string;
	readonly status: 'partial' | 'final';
	readonly revision: number;
	readonly committed: string;
}

export interface IVoiceCodeTranscriptionError {
	readonly detail: string;
	readonly code?: string;
	readonly turnId?: string;
	readonly terminal?: boolean;
}

export interface IVoiceCodeTranscriptionClient {
	readonly _serviceBrand: undefined;
	readonly onTranscription: Event<IVoiceCodeTranscription>;
	readonly onError: Event<IVoiceCodeTranscriptionError>;
	readonly onDidClose: Event<number>;
	readonly isConnected: boolean;
	connect(window: Window & typeof globalThis, authToken: string): Promise<void>;
	startSession(options?: { readonly backend: DictationBackend; readonly language: string | null; }): Promise<void>;
	sendPttStart(turnId: string): void;
	sendPttAudioChunk(turnId: string, audio: string): void;
	sendPttEnd(turnId: string): void;
	disconnect(): void;
}

interface TranscriptionTurn {
	readonly id: string;
	readonly resourceId: string;
	operations: Promise<void>;
	started: Promise<void>;
	accepted: boolean;
	queuedBytes: number;
	revision: number;
	text: string;
	stopping: boolean;
	error?: string;
}

/** One frontend session over the host's authenticated connection; audio and turn identity stay explicit. */
export class VoiceCodeTranscriptionClient extends Disposable implements IVoiceCodeTranscriptionClient {
	public readonly _serviceBrand = undefined;
	private readonly transcriptions = this._register(new Emitter<IVoiceCodeTranscription>());
	public readonly onTranscription = this.transcriptions.event;
	private readonly errors = this._register(new Emitter<IVoiceCodeTranscriptionError>());
	public readonly onError = this.errors.event;
	private readonly closed = this._register(new Emitter<number>());
	public readonly onDidClose = this.closed.event;
	private connected = false;
	private connectionGeneration = 0;
	private session: { backend: DictationBackend; language: string | null; resourceId: string; claimed: boolean; operations: Promise<void>; error?: string; } | undefined;
	private active: TranscriptionTurn | undefined;
	private release = Promise.resolve();
	public get isConnected(): boolean { return this.connected && !!this.backend?.isConnected; }

	constructor(
		@IVoiceCodeTranscriptionBackendService private readonly backend: IVoiceCodeTranscriptionBackendService | undefined,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		if (!backend) return;
		this._register(backend.onDidTranscribe(result => {
			const turn = this.active;
			if (!turn || turn.resourceId !== result.resourceId) return;
			turn.text = result.text;
			// The host may publish its final notification before stop acknowledges
			// resource release. Keep final delivery behind that acknowledgment.
			if (!result.isFinal) this.publish(turn, false);
		}));
		this._register(backend.onDidEnd(result => {
			const turn = this.active;
			if (!turn || turn.resourceId !== result.resourceId) {
				if (this.session?.resourceId === result.resourceId && !this.session.claimed) {
					this.session.error = result.error ?? localize('dictation.sessionUnavailable', 'Transcription session is not initialized');
					this.release = backend.cancel(result.resourceId).catch(() => undefined);
					this.errors.fire({ detail: this.session.error, terminal: true });
				}
				return;
			}
			turn.error = result.error;
			if (!turn.stopping) this.sendPttEnd(turn.id);
		}));
		this._register(backend.onDidChangeConnection(() => {
			if (!this.connected || backend.isConnected) return;
			const turnId = this.active?.id;
			this.connected = false;
			this.session = undefined;
			this.active = undefined;
			this.closed.fire(1006);
			this.errors.fire({ detail: localize('dictation.connectionLost', 'Dictation connection lost'), turnId, terminal: true });
		}));
	}

	public async connect(_window: Window & typeof globalThis, _authToken: string): Promise<void> {
		this.assertNotDisposed();
		this.disconnect();
		const generation = this.connectionGeneration;
		await this.release;
		// Resource release belongs to the old session; only the latest connect may admit its replacement.
		if (generation !== this.connectionGeneration) throw canceled();
		if (this.isDisposed || !this.backend?.isConnected) throw new Error(localize('dictation.connectionUnavailable', 'Dictation connection is unavailable'));
		// The host already authenticates this renderer and resolves provider credentials.
		// Browser bearer credentials never replace the host's account authority.
		this.connected = true;
	}

	public async startSession(options?: { readonly backend: DictationBackend; readonly language: string | null; }): Promise<void> {
		this.requireConnection();
		if (this.active) throw new Error(localize('dictation.alreadyActive', 'Dictation is already active'));
		if (this.session && !this.session.claimed) throw new Error(localize('dictation.alreadyActive', 'Dictation is already active'));
		const backend = options?.backend ?? dictationBackend(this.configuration);
		const language = options ? options.language : dictationInputOptions(this.configuration, backend.type).language;
		const resourceId = generateUuid();
		const session: NonNullable<VoiceCodeTranscriptionClient['session']> = {
			backend, language, resourceId, claimed: false, operations: this.release.then(() => {
				if (this.session !== session) throw canceled();
				this.requireConnection();
				return this.backend!.start(resourceId, { backend, language });
			})
		};
		this.session = session;
		try {
			await session.operations;
			if (session.error) throw new Error(session.error);
			if (this.session !== session || !this.isConnected) throw canceled();
		} catch (error) {
			if (this.session === session) this.session = undefined;
			throw error;
		}
	}

	public sendPttStart(turnId: string): void {
		this.requireConnection();
		if (!turnId || turnId.length > 128) throw new TypeError(localize('dictation.invalidTurn', 'Invalid transcription turn ID'));
		if (!this.session) throw new Error(localize('dictation.sessionUnavailable', 'Transcription session is not initialized'));
		if (this.active) throw new Error(localize('dictation.alreadyActive', 'Dictation is already active'));
		const session = this.session;
		if (session.error) throw new Error(session.error);
		const primed = !session.claimed;
		session.claimed = true;
		const turn: TranscriptionTurn = { id: turnId, resourceId: primed ? session.resourceId : generateUuid(), operations: primed ? session.operations : this.release, started: primed ? session.operations : this.release, accepted: primed, queuedBytes: 0, revision: 0, text: '', stopping: false };
		this.active = turn;
		if (!primed) this.enqueue(turn, async () => {
			await this.backend!.start(turn.resourceId, { backend: session.backend, language: session.language });
			turn.accepted = true;
			if (this.active !== turn) await this.backend!.cancel(turn.resourceId);
		});
		turn.started = turn.operations;
	}

	public sendPttAudioChunk(turnId: string, audio: string): void {
		const turn = this.requireTurn(turnId);
		if (turn.stopping) throw new Error(localize('dictation.turnStopping', 'Transcription turn is stopping'));
		if (!audio || audio.length > 42668 || turn.queuedBytes + audio.length > 4 * 1024 * 1024) {
			this.fail(turn, new Error(localize('dictation.audioBackpressure', 'Transcription audio is empty or backpressured')));
			return;
		}
		turn.queuedBytes += audio.length;
		this.enqueue(turn, async () => {
			try { await this.backend!.pushAudio(turn.resourceId, audio); }
			finally { turn.queuedBytes -= audio.length; }
		});
	}

	public sendPttEnd(turnId: string): void {
		const turn = this.requireTurn(turnId);
		if (turn.stopping) return;
		turn.stopping = true;
		this.enqueue(turn, async () => {
			const text = await this.backend!.stop(turn.resourceId);
			if (this.active !== turn) return;
			if (turn.error) throw new Error(turn.error);
			turn.text = text ?? turn.text;
			this.active = undefined;
			this.publish(turn, true);
		});
		this.release = turn.operations;
	}

	public disconnect(): void {
		this.connectionGeneration++;
		this.connected = false;
		const session = this.session;
		this.session = undefined;
		const turn = this.active;
		this.active = undefined;
		if (turn && this.backend) {
			// Cancel bypasses queued audio and stop, including a pending subscription upload.
			const backend = this.backend;
			this.release = Promise.all([
				backend.cancel(turn.resourceId).catch(() => undefined),
				// Wait only for acquisition. A cancelled stop/upload is no longer a release barrier.
				turn.accepted ? undefined : turn.started.then(() => backend.cancel(turn.resourceId)).catch(() => undefined),
			]).then(() => undefined);
		} else if (session && !session.claimed && this.backend) {
			const backend = this.backend;
			this.release = Promise.all([
				backend.cancel(session.resourceId).catch(() => undefined),
				session.operations.then(() => backend.cancel(session.resourceId)).catch(() => undefined),
			]).then(() => undefined);
		}
	}

	private enqueue(turn: TranscriptionTurn, operation: () => Promise<void>): void {
		turn.operations = turn.operations.then(async () => {
			if (this.active === turn) await operation();
		}).catch(error => this.fail(turn, error));
	}

	private fail(turn: TranscriptionTurn, error: unknown): void {
		if (this.active !== turn) return;
		this.active = undefined;
		this.release = this.backend!.cancel(turn.resourceId).catch(() => undefined);
		this.errors.fire({ detail: dictationError(String(error)) ?? String(error), turnId: turn.id, terminal: true });
	}

	private publish(turn: TranscriptionTurn, final: boolean): void {
		this.transcriptions.fire({ turnId: turn.id, text: turn.text, status: final ? 'final' : 'partial', revision: ++turn.revision, committed: final ? turn.text : '' });
	}

	private requireConnection(): void {
		this.assertNotDisposed();
		if (!this.isConnected) throw new Error(localize('dictation.connectionUnavailable', 'Dictation connection is unavailable'));
	}

	private requireTurn(turnId: string): TranscriptionTurn {
		this.requireConnection();
		if (!this.active || this.active.id !== turnId) throw new Error(localize('dictation.turnInactive', 'Transcription turn is not active'));
		return this.active;
	}

	protected override disposeCore(): void {
		this.disconnect();
		super.disposeCore();
	}
}

function dictationError(message: string | undefined): string | undefined {
	if (!message) { return message; }
	if (message.includes('CodexDictationAuthenticationRequired')) { return localize('dictation.codex.authenticationRequired', 'Connect your Codex account in Models. If its login has expired, sign in again.'); }
	if (message.includes('CodexDictationAccessDenied')) { return localize('dictation.codex.accessDenied', 'This Codex account cannot currently use subscription dictation. Check the account or choose another dictation service.'); }
	if (message.includes('CodexDictationAccountChanged')) { return localize('dictation.codex.accountChanged', 'The Codex account changed during recording. Record again with the current account.'); }
	if (message.includes('CodexDictationAudioTooLong')) { return localize('dictation.codex.audioTooLong', 'Codex dictation recordings can be up to 3 minutes long.'); }
	if (message.includes('CodexDictationRateLimited')) { return localize('dictation.codex.rateLimited', 'Codex dictation is temporarily rate limited. Try again later.'); }
	if (message.includes('CodexDictationCancelled')) { return localize('dictation.codex.cancelled', 'Codex dictation was cancelled.'); }
	if (/CodexDictation(?:InvalidAudio|InvalidResponse|RequestFailed)/.test(message)) { return localize('dictation.codex.failed', 'Could not transcribe this recording with Codex. Record again and try once more.'); }
	return message;
}
