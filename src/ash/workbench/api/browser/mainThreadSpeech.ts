import { IExtensionService } from '../../services/extensions/common/extensionService.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import { canceled } from '../../../base/common/errors.js';
import { localize } from '../../../nls.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { createUuid } from '../../../base/common/uuid.js';
import { ExtensionIdentifier } from '../../../platform/extensions/common/extensions.js';
import { IExtensionHostApi, type ExtensionHostFleetSnapshot, type JsonValue } from '../../../platform/agentHost/common/extensionHostApi.js';
import {
	ISpeechService,
	SpeechToTextStatus,
	TextToSpeechStatus,
	KeywordRecognitionStatus,
	type ISpeechProvider,
	type ISpeechToTextEvent,
	type ITextToSpeechEvent,
	type IKeywordRecognitionEvent,
} from '../../contrib/speech/common/speechService.js';

type SpeechKind = 'speechToText' | 'textToSpeech' | 'keywordRecognition';
type Invoke = (operation: string, payload: JsonValue, signal: AbortSignal) => Promise<JsonValue>;
interface Binding extends DisposableStore {
	readonly identity: string;
}
interface SynthesisCompletion {
	complete(): void;
	fail(error: unknown): void;
}

/** Binds standard Speech providers to the original admitted Host registrations and incarnation. */
export class MainThreadSpeech extends Disposable {
	private readonly bindings = this._register(new DisposableMap<string, Binding>());
	constructor(
		private readonly timeout: number,
		@IExtensionHostApi private readonly api: IExtensionHostApi,
		@ISpeechService private readonly speech: ISpeechService,
		@IExtensionService private readonly extensions: IExtensionService | undefined = undefined,
	) {
		super();
	}

	public update(snapshot: ExtensionHostFleetSnapshot): void {
		const active = new Map<string, string>();
		for (const runtime of snapshot.extensions) {
			if (runtime.lifecycle !== 'ready' || runtime.incarnation === undefined) continue;
			for (const registration of runtime.registrations)
				if (registration.kind === 'speechProvider')
					active.set(JSON.stringify([runtime.id, registration.registrationId]), JSON.stringify([runtime.incarnation, runtime.activationGeneration, registration]));
		}
		// Retire all changed identities before registering any replacement: two live handles can
		// exchange provider identifiers in one snapshot without colliding in SpeechService.
		for (const [key, binding] of this.bindings) if (active.get(key) !== binding.identity) this.bindings.deleteAndDispose(key);
		for (const runtime of snapshot.extensions) {
			if (runtime.lifecycle !== 'ready' || runtime.incarnation === undefined) continue;
			for (const registration of runtime.registrations) {
				if (registration.kind !== 'speechProvider') continue;
				const key = JSON.stringify([runtime.id, registration.registrationId]);
				const identity = JSON.stringify([runtime.incarnation, runtime.activationGeneration, registration]);
				if (this.bindings.get(key)?.identity === identity) continue;
				const lifetime: Binding = Object.assign(new DisposableStore(), { identity });
				const owner = new AbortController();
				lifetime.add(toDisposable(() => owner.abort()));
				const source = {
					extensionId: runtime.id,
					registrationId: registration.registrationId,
					registrationGeneration: registration.registrationGeneration,
					incarnation: runtime.incarnation,
					activationGeneration: runtime.activationGeneration,
				};
				const invoke: Invoke = async (operation, payload, signal) => {
					const combined = AbortSignal.any([owner.signal, signal]);
					combined.throwIfAborted();
					const value = await this.api.invoke({ ...source, operation, payload, deadlineUnixMillis: Date.now() + this.timeout }, combined);
					combined.throwIfAborted();
					return value;
				};
				const session = (kind: SpeechKind, token: CancellationToken, language?: string) => {
					const close = (sessionId: string) =>
						this.api.invoke(
							{
								...source,
								operation: 'closeSpeechSession',
								payload: { sessionId },
								deadlineUnixMillis: Date.now() + this.timeout,
							},
							new AbortController().signal,
						);
					const value = new SpeechClientSession(kind, token, invoke, owner.signal, language, close, () => lifetime.delete(value));
					lifetime.add(value);
					return value;
				};
				const descriptor = this.extensions?.currentCatalog.extensions.find(extension => extension.packageSha256 === runtime.packageDigest && extension.version === runtime.version);
				const provider: ISpeechProvider = {
					metadata: {
						extension: new ExtensionIdentifier(descriptor?.id ?? runtime.id),
						displayName: descriptor?.displayName ?? registration.identifier,
					},
					createSpeechToTextSession: (token, options) => ({
						onDidChange: session('speechToText', token, options?.language).onSpeechToText,
					}),
					createTextToSpeechSession: (token, options) => {
						const value = session('textToSpeech', token, options?.language);
						return { onDidChange: value.onTextToSpeech, synthesize: text => value.synthesize(text) };
					},
					createKeywordRecognitionSession: token => ({
						onDidChange: session('keywordRecognition', token).onKeywordRecognition,
					}),
				};
				try {
					lifetime.add(this.speech.registerSpeechProvider(`${runtime.id}/${registration.identifier}`, provider));
					this.bindings.set(key, lifetime);
				} catch (error) {
					lifetime.dispose();
					throw error;
				}
			}
		}
	}
	public clear(): void {
		this.bindings.clearAndDisposeAll();
	}
}

/** Only event delivery and a cancellation lease live here; the extension owns its media session. */
class SpeechClientSession extends Disposable {
	private readonly stt = this._register(new Emitter<ISpeechToTextEvent>());
	private readonly tts = this._register(new Emitter<ITextToSpeechEvent>());
	private readonly keyword = this._register(new Emitter<IKeywordRecognitionEvent>());
	public readonly onSpeechToText = this.stt.event;
	public readonly onTextToSpeech = this.tts.event;
	public readonly onKeywordRecognition = this.keyword.event;
	private terminalDelivered = false;
	private readonly controller = new AbortController();
	private readonly id = createUuid();
	private readonly starting: Promise<void>;
	private ended = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private synthesis: SynthesisCompletion | undefined;
	constructor(
		private readonly kind: SpeechKind,
		token: CancellationToken,
		private readonly invoke: Invoke,
		owner: AbortSignal,
		language: string | undefined,
		private readonly close: (sessionId: string) => Promise<JsonValue>,
		private readonly released: () => void,
	) {
		super();
		this._register(token.onCancellationRequested(() => this.finish()));
		const onOwnerAbort = () => this.finish();
		owner.addEventListener('abort', onOwnerAbort, { once: true });
		this._register(toDisposable(() => owner.removeEventListener('abort', onOwnerAbort)));
		this.starting = invoke('createSpeechSession', { sessionId: this.id, kind, ...(language === undefined ? {} : { language }) }, this.controller.signal).then(() => undefined);
		void this.starting.then(
			() => this.poll(),
			error => this.fail(error),
		);
		if (token.isCancellationRequested || owner.aborted) this.finish();
	}
	public async synthesize(text: string): Promise<void> {
		await this.starting;
		this.controller.signal.throwIfAborted();
		if (this.synthesis) throw new Error(localize('speech.synthesisBusy', 'Speech synthesis is already in progress.'));
		let completion!: SynthesisCompletion;
		const completed = new Promise<void>((resolve, reject) => {
			completion = { complete: resolve, fail: reject };
		});
		this.synthesis = completion;
		try {
			// Standard extension providers return void from synthesize. Only their event confirms
			// completion; install this receipt before dispatch so immediate events are not lost.
			await Promise.all([this.invoke('synthesizeSpeech', { sessionId: this.id, text }, this.controller.signal), completed]);
		} finally {
			if (this.synthesis === completion) this.synthesis = undefined;
		}
	}
	private async poll(): Promise<void> {
		if (this.ended) return;
		try {
			const reply = await this.invoke('readSpeechSession', { sessionId: this.id }, this.controller.signal);
			if (this.ended) return;
			if (
				!isRecord(reply) ||
				!Array.isArray(reply.events) ||
				reply.events.length > 128 ||
				typeof reply.closed !== 'boolean' ||
				Object.keys(reply).some(key => !['events', 'closed'].includes(key))
			)
				throw new TypeError('Invalid Speech event batch');
			for (const event of reply.events) {
				if (this.ended) return;
				if (
					!isRecord(event) ||
					!Number.isInteger(event.status) ||
					typeof event.status !== 'number' ||
					event.status < 1 ||
					event.status > (this.kind === 'speechToText' ? 5 : this.kind === 'textToSpeech' ? 3 : 2) ||
					(event.text !== undefined && (typeof event.text !== 'string' || event.text.length > 16384)) ||
					Object.keys(event).some(key => !['status', 'text'].includes(key))
				)
					throw new TypeError('Invalid Speech event');
				this.deliver(event.status, typeof event.text === 'string' ? event.text : undefined);
			}
			if (reply.closed) this.finish();
			else if (!this.ended)
				this.timer = setTimeout(() => {
					this.timer = undefined;
					void this.poll();
				}, 100);
		} catch (error) {
			if (!this.ended) this.fail(error);
		}
	}
	private fail(error: unknown): void {
		if (this.ended) return;
		if (this.kind !== 'keywordRecognition') this.deliver(this.kind === 'speechToText' ? 5 : 3, String(error));
		this.finish();
	}
	private finish(): void {
		if (this.ended) return;
		this.ended = true;
		this.controller.abort();
		this.synthesis?.fail(canceled());
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (!this.terminalDelivered) this.deliver(this.kind === 'speechToText' ? 4 : 2);
		// Cancellation can cross an already-completed Host invocation. Its persistent provider
		// token then needs an explicit close, even if the local wrapper rejects the late receipt.
		// Cleanup uses the original backend fence, rather than the locally aborted binding.
		// A retired registration rejects this close; it cannot reach a replacement incarnation.
		void this.starting?.finally(() => this.close(this.id)).catch(() => undefined);
		queueMicrotask(() => {
			this.released();
			this.dispose();
		});
	}
	private deliver(status: number, text?: string): void {
		if (this.kind === 'speechToText') {
			const value = [undefined, SpeechToTextStatus.Started, SpeechToTextStatus.Recognizing, SpeechToTextStatus.Recognized, SpeechToTextStatus.Stopped, SpeechToTextStatus.Error][status];
			if (value === undefined) throw new TypeError('Invalid speech-to-text status');
			if (value === SpeechToTextStatus.Stopped || value === SpeechToTextStatus.Error) this.terminalDelivered = true;
			this.stt.fire({ status: value, ...(text === undefined ? {} : { text }) });
		} else if (this.kind === 'textToSpeech') {
			const value = [undefined, TextToSpeechStatus.Started, TextToSpeechStatus.Stopped, TextToSpeechStatus.Error][status];
			if (value === undefined) throw new TypeError('Invalid text-to-speech status');
			if (value === TextToSpeechStatus.Stopped) this.synthesis?.complete();
			else if (value === TextToSpeechStatus.Error) this.synthesis?.fail(new Error(text ?? localize('speech.synthesisFailed', 'Speech synthesis failed.')));
			this.tts.fire({ status: value, ...(text === undefined ? {} : { text }) });
		} else {
			const value = [undefined, KeywordRecognitionStatus.Recognized, KeywordRecognitionStatus.Stopped][status];
			if (value === undefined) throw new TypeError('Invalid keyword status');
			this.terminalDelivered = true;
			this.keyword.fire({ status: value });
		}
	}
	protected override disposeCore(): void {
		this.finish();
		super.disposeCore();
	}
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
