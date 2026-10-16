import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import type { AppServerProtocolClient } from '../../../../platform/agentHost/browser/appServerProtocolClient.js';
import { APP_SERVER_METHODS } from '../../../../../../.build/protocol/typescript/index.js';
import type { IDictationBackendService, IDictationSession, IDictationInputOptions, DictationBackend } from '../../../../platform/renderer/common/rendererHost.js';
import { localize } from '../../../../nls.js';

interface DictationCallbacks {
	readonly onTranscript: (text: string, isFinal: boolean) => void;
	readonly onEnded: (error?: string) => void;
	stopping: boolean;
	cancelled: boolean;
	cancelling?: Promise<void>;
	endedError?: string;
}

type ActiveDictation = DictationCallbacks & { readonly resourceId: string; finalDelivered: boolean; };

export class AppServerDictationService extends Disposable implements IDictationBackendService {
	private readonly availabilityChanged = this._register(new Emitter<void>());
	public readonly onDidChangeAvailability = this.availabilityChanged.event;
	private active: ActiveDictation | undefined;
	private starting = false;

	constructor(private readonly client: AppServerProtocolClient) {
		super();
		this._register(client.onNotification(notification => {
			const active = this.active;
			if (!active) { return; }
			if (notification.method === 'dictation/transcript' && notification.params.resourceId === active.resourceId) {
				if (active.cancelled) { return; }
				if (notification.params.isFinal) { active.finalDelivered = true; }
				active.onTranscript(notification.params.text, notification.params.isFinal);
			} else if (notification.method === 'dictation/ended' && notification.params.resourceId === active.resourceId) {
				if (active.stopping) {
					active.endedError = active.cancelled ? undefined : dictationError(notification.params.error ?? undefined);
					return;
				}
				this.active = undefined;
				active.onEnded(dictationError(notification.params.error ?? undefined));
				if (!active.stopping) { void this.client.request(APP_SERVER_METHODS['dictation/stop'], { resourceId: active.resourceId }).catch(() => undefined); }
			}
		}));
		this._register(client.onStateChange(state => {
			this.availabilityChanged.fire();
			if (state === 'ready' || !this.active) { return; }
			const active = this.active;
			this.active = undefined;
			active.onEnded(localize('dictation.connectionLost', 'Dictation connection lost'));
		}));
	}

	public getOptions(backend: DictationBackend): Promise<IDictationInputOptions> {
		return this.client.request(APP_SERVER_METHODS['dictation/options'], { backend });
	}

	async start(options: Parameters<IDictationBackendService['start']>[0], onTranscript: (text: string, isFinal: boolean) => void, onEnded: (error?: string) => void): Promise<IDictationSession> {
		this.assertNotDisposed();
		if (this.client.state !== 'ready') { throw new Error(localize('dictation.connectionUnavailable', 'Dictation connection is unavailable')); }
		if (this.active || this.starting) { throw new Error(localize('dictation.alreadyActive', 'Dictation is already active')); }
		this.starting = true;
		try {
			this.assertNotDisposed();
			const callbacks: DictationCallbacks = { onTranscript, onEnded, stopping: false, cancelled: false };
			const active: ActiveDictation = { ...callbacks, resourceId: generateUuid(), finalDelivered: false };
			this.active = active;
			try {
				await this.client.request(APP_SERVER_METHODS['dictation/start'], { resourceId: active.resourceId, ...options });
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
			const result = await this.client.request(APP_SERVER_METHODS['dictation/stop'], { resourceId: active.resourceId });
			if (this.active !== active) { return; }
			if (!active.cancelled && !active.finalDelivered && result.text !== null) {
				active.finalDelivered = true;
				active.onTranscript(result.text, true);
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
			await this.client.request(APP_SERVER_METHODS['dictation/cancel'], { resourceId: active.resourceId });
		} finally {
			if (this.active === active) { this.active = undefined; active.onEnded(); }
		}
	}

	protected override disposeCore(): void {
		const active = this.active;
		this.active = undefined;
		if (active) {
			void this.client.request(APP_SERVER_METHODS['dictation/cancel'], { resourceId: active.resourceId }).catch(() => undefined);
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
