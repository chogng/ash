import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import type { IDictationBackendService, IDictationSession, IDictationInputOptions, DictationBackend, IVoiceCodeTranscriptionBackend } from '../../../../../platform/renderer/common/dictation.js';
import { localize } from '../../../../../nls.js';

interface DictationCallbacks {
	readonly onTranscript: (text: string, isFinal: boolean) => void;
	readonly onEnded: (error?: string) => void;
	stopping: boolean;
	cancelled: boolean;
	cancelling?: Promise<void>;
	endedError?: string;
}

type ActiveDictation = DictationCallbacks & { readonly resourceId: string; finalDelivered: boolean; };

/**
 * Adapts cloud and subscription transcription to the host's dictation contract.
 * The host owns audio capture and transport; this client owns session lifetimes, while
 * ChatSpeechToTextService owns backend selection and cumulative transcripts.
 */
export class VoiceCodeTranscriptionClient extends Disposable implements IDictationBackendService {
	private readonly availabilityChanged = this._register(new Emitter<void>());
	public readonly onDidChangeAvailability = this.availabilityChanged.event;
	private active: ActiveDictation | undefined;
	private starting = false;

	constructor(private readonly backend: IVoiceCodeTranscriptionBackend) {
		super();
		this._register(backend.onDidTranscribe(result => {
			const active = this.active;
			if (!active || result.resourceId !== active.resourceId || active.cancelled) { return; }
			if (result.isFinal) { active.finalDelivered = true; }
			active.onTranscript(result.text, result.isFinal);
		}));
		this._register(backend.onDidEnd(result => {
			const active = this.active;
			if (!active || result.resourceId !== active.resourceId) { return; }
			if (active.stopping) {
				active.endedError = active.cancelled ? undefined : dictationError(result.error);
				return;
			}
			this.active = undefined;
			active.onEnded(dictationError(result.error));
			void this.backend.stop(active.resourceId).catch(() => undefined);
		}));
		this._register(backend.onDidChangeConnection(() => {
			this.availabilityChanged.fire();
			if (backend.isConnected || !this.active) { return; }
			const active = this.active;
			this.active = undefined;
			active.onEnded(localize('dictation.connectionLost', 'Dictation connection lost'));
		}));
	}

	public getOptions(backend: DictationBackend): Promise<IDictationInputOptions> {
		return this.backend.getOptions(backend);
	}

	async start(options: Parameters<IDictationBackendService['start']>[0], onTranscript: (text: string, isFinal: boolean) => void, onEnded: (error?: string) => void): Promise<IDictationSession> {
		this.assertNotDisposed();
		if (!this.backend.isConnected) { throw new Error(localize('dictation.connectionUnavailable', 'Dictation connection is unavailable')); }
		if (this.active || this.starting) { throw new Error(localize('dictation.alreadyActive', 'Dictation is already active')); }
		this.starting = true;
		try {
			this.assertNotDisposed();
			const callbacks: DictationCallbacks = { onTranscript, onEnded, stopping: false, cancelled: false };
			const active: ActiveDictation = { ...callbacks, resourceId: generateUuid(), finalDelivered: false };
			this.active = active;
			try {
				await this.backend.start(active.resourceId, options);
			} catch (error) {
				if (this.active === active) { this.active = undefined; }
				throw new Error(dictationError(String(error)));
			}
			return { stop: () => this.stop(active), cancel: () => this.cancel(active) };
		} finally {
			this.starting = false;
		}
	}

	private async stop(active: ActiveDictation): Promise<void> {
		if (this.active !== active) { return; }
		active.stopping = true;
		try {
			const text = await this.backend.stop(active.resourceId);
			if (this.active !== active) { return; }
			if (!active.cancelled && !active.finalDelivered && text !== undefined) {
				active.finalDelivered = true;
				active.onTranscript(text, true);
			}
			if (this.active === active) {
				this.active = undefined;
				active.onEnded(active.endedError);
			}
		} catch (error) {
			if (this.active === active) { this.active = undefined; }
			if (!active.cancelled) { throw new Error(dictationError(String(error))); }
		}
	}

	private cancel(active: ActiveDictation): Promise<void> {
		if (active.cancelling) { return active.cancelling; }
		if (this.active !== active) { return Promise.resolve(); }
		active.cancelled = active.stopping = true;
		return active.cancelling = this.cancelRecording(active);
	}

	private async cancelRecording(active: ActiveDictation): Promise<void> {
		try {
			await this.backend.cancel(active.resourceId);
		} finally {
			if (this.active === active) { this.active = undefined; active.onEnded(); }
		}
	}

	protected override disposeCore(): void {
		const active = this.active;
		this.active = undefined;
		if (active) {
			void this.backend.cancel(active.resourceId).catch(() => undefined);
		}
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
