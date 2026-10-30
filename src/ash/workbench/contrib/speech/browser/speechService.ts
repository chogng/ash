import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import { ExtensionsRegistry } from '../../../services/extensions/common/extensionsRegistry.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { canceled, isCancellationError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ISpeechService, SpeechToTextStatus, type ISpeechToTextEvent, type ISpeechToTextSession, type ISpeechProvider, type ITextToSpeechSession, KeywordRecognitionStatus, SPEECH_LANGUAGE_CONFIG, speechLanguageConfigToLanguage, HasSpeechProvider, SpeechToTextInProgress, TextToSpeechInProgress } from '../common/speechService.js';

export interface ISpeechProviderDescriptor {
	readonly name: string;
	readonly description?: string;
}

ExtensionsRegistry.registerExtensionPoint<readonly ISpeechProviderDescriptor[]>({
	extensionPoint: 'speechProviders',
	validate: value => {
		if (!Array.isArray(value) || value.length > 16) throw new TypeError(localize('speech.providerDeclarationInvalid', 'Invalid speech provider contribution.'));
		const names = new Set<string>();
		return Object.freeze(value.map(candidate => {
			if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || typeof candidate.name !== 'string' || !candidate.name || candidate.name.length > 256 || /\s/u.test(candidate.name) || names.has(candidate.name) || candidate.description !== undefined && (typeof candidate.description !== 'string' || candidate.description.length > 512) || Object.keys(candidate).some(key => key !== 'name' && key !== 'description')) throw new TypeError(localize('speech.providerDeclarationInvalid', 'Invalid speech provider contribution.'));
			names.add(candidate.name);
			return Object.freeze({ name: candidate.name, ...(candidate.description === undefined ? {} : { description: candidate.description }) });
		}));
	},
});

interface ProviderEntry { readonly provider: ISpeechProvider; }
interface ProviderLease { readonly entry: ProviderEntry; readonly lifetime: DisposableStore; }

interface Recording {
	provider?: ProviderEntry;
	readonly lifetime: DisposableStore;
	readonly events: Emitter<ISpeechToTextEvent>;
	subscribed: boolean;
	started: boolean;
	stopped: boolean;
	readonly pendingFinal: ISpeechToTextEvent[];
	pendingInterim?: ISpeechToTextEvent;
	pendingError?: ISpeechToTextEvent;
	starting?: Promise<void>;
	handle?: { stop(): Promise<void>; cancel(): Promise<void>; };
	stopping?: Promise<void>;
	cancelling?: Promise<void>;
	cancelled: boolean;
}

/** Owns extension speech providers and their cancellation-scoped sessions. */
export class SpeechService extends Disposable implements ISpeechService {
	public readonly _serviceBrand = undefined;
	private readonly stateChanged = this._register(new Emitter<void>());
	private readonly started = this._register(new Emitter<void>());
	public readonly onDidStartSpeechToTextSession = this.started.event;
	private readonly ended = this._register(new Emitter<void>());
	public readonly onDidEndSpeechToTextSession = this.ended.event;
	private readonly activations = new Map<AbortController, 'speechToText' | 'textToSpeech' | 'keywordRecognition'>();
	private readonly providers = new Map<string, ProviderEntry>();
	private readonly providerChanged = this._register(new Emitter<void>());
	public readonly onDidChangeHasSpeechProvider = this.providerChanged.event;
	private readonly leases = new Set<ProviderLease>();
	private readonly ttsStarted = this._register(new Emitter<void>());
	public readonly onDidStartTextToSpeechSession = this.ttsStarted.event;
	private readonly ttsEnded = this._register(new Emitter<void>());
	public readonly onDidEndTextToSpeechSession = this.ttsEnded.event;
	private readonly keywordStarted = this._register(new Emitter<void>());
	public readonly onDidStartKeywordRecognition = this.keywordStarted.event;
	private readonly keywordEnded = this._register(new Emitter<void>());
	public readonly onDidEndKeywordRecognition = this.keywordEnded.event;
	private ttsCount = 0;
	private keywordCount = 0;
	public get hasActiveTextToSpeechSession(): boolean { return this.ttsCount > 0; }
	public get hasActiveKeywordRecognition(): boolean { return this.keywordCount > 0; }
	private recording: Recording | undefined;
	public get hasActiveSpeechToTextSession(): boolean { return !!this.recording; }
	public get hasSpeechProvider(): boolean { return this.providers.size > 0 || this.hasDeclaredProvider; }
	private get hasDeclaredProvider(): boolean { return this.extensions?.getExtensionPointContributions<readonly ISpeechProviderDescriptor[]>('speechProviders').some(contribution => contribution.value.length > 0) === true; }

	constructor(
		@IExtensionService private readonly extensions: IExtensionService | undefined = undefined,
		@IConfigurationService private readonly configuration: IConfigurationService | undefined = undefined,
		@IContextKeyService contextKeys: IContextKeyService | undefined = undefined,
	) {
		super();
		if (contextKeys) {
			const provider = HasSpeechProvider.bindTo(contextKeys);
			const recognition = SpeechToTextInProgress.bindTo(contextKeys);
			const synthesis = TextToSpeechInProgress.bindTo(contextKeys);
			const update = () => contextKeys.bufferChangeEvents(() => {
				provider.set(this.hasSpeechProvider);
				recognition.set(this.hasActiveSpeechToTextSession);
				synthesis.set(this.hasActiveTextToSpeechSession);
			});
			this._register(this.onDidChangeHasSpeechProvider(update));
			this._register(this.stateChanged.event(update));
			this._register(this.onDidStartTextToSpeechSession(update));
			this._register(this.onDidEndTextToSpeechSession(update));
			this._register(toDisposable(() => { provider.reset(); recognition.reset(); synthesis.reset(); }));
			update();
		}
		if (extensions) this._register(extensions.onDidChange(() => { this.providerChanged.fire(); }));
	}

	public registerSpeechProvider(identifier: string, provider: ISpeechProvider): IDisposable {
		this.assertNotDisposed();
		if (this.providers.has(identifier) || this.providers.size >= 16) throw new Error(localize('speech.providerDuplicate', 'Speech provider registration is duplicate or exceeds the limit.'));
		const entry = { provider };
		this.providers.set(identifier, entry); this.providerChanged.fire();
		return toDisposable(() => {
			if (this.providers.get(identifier) !== entry) return;
			this.providers.delete(identifier);
			if (this.recording?.provider === entry) void this.cancel().catch(() => undefined);
			for (const lease of [...this.leases]) if (lease.entry === entry) lease.lifetime.dispose();
			this.providerChanged.fire();
		});
	}

	private selectProvider(): ProviderEntry {
		this.assertNotDisposed();
		if (this.providers.size === 0) throw new Error(localize('speech.providerMissing', 'No speech extension provider is available.'));
		if (this.providers.size !== 1) throw new Error(localize('speech.providerMultiple', 'Multiple speech providers are active. Disable the providers you do not want to use before starting speech.'));
		return this.providers.values().next().value!;
	}

	private leaseProvider(entry: ProviderEntry, token: CancellationToken): { readonly lifetime: DisposableStore; readonly source: CancellationTokenSource; } {
		if (token.isCancellationRequested) throw canceled();
		const lifetime = new DisposableStore();
		const source = new CancellationTokenSource();
		const lease = { entry, lifetime };
		this.leases.add(lease);
		lifetime.add(toDisposable(() => { this.leases.delete(lease); source.dispose(true); }));
		lifetime.add(token.onCancellationRequested(() => lifetime.dispose()));
		if (token.isCancellationRequested) lifetime.dispose();
		return { lifetime, source };
	}

	public async createTextToSpeechSession(token: CancellationToken, _context?: string): Promise<ITextToSpeechSession> {
		if (this.hasDeclaredProvider) await this.activateProvider(token, 'textToSpeech');
		const entry = this.selectProvider();
		const lease = this.leaseProvider(entry, token);
		try {
			const session = entry.provider.createTextToSpeechSession(lease.source.token, { language: speechLanguageConfigToLanguage(this.configuration?.getValue(SPEECH_LANGUAGE_CONFIG) ?? 'auto') });
			if (lease.source.token.isCancellationRequested) throw canceled();
			this.ttsCount++;
			lease.lifetime.add(toDisposable(() => { this.ttsCount--; this.ttsEnded.fire(); }));
			this.ttsStarted.fire();
			return {
				onDidChange: session.onDidChange, synthesize: async text => {
					if (lease.source.token.isCancellationRequested) throw canceled();
					await session.synthesize(text);
				}
			};
		} catch (error) { lease.lifetime.dispose(); throw error; }
	}

	public async recognizeKeyword(token: CancellationToken): Promise<KeywordRecognitionStatus> {
		if (token.isCancellationRequested) return KeywordRecognitionStatus.Canceled;
		if (this.hasDeclaredProvider) {
			try { await this.activateProvider(token, 'keywordRecognition'); }
			catch (error) { if (token.isCancellationRequested || this.isDisposed) return KeywordRecognitionStatus.Canceled; throw error; }
		}
		const entry = this.selectProvider();
		const lease = this.leaseProvider(entry, token);
		try {
			const session = entry.provider.createKeywordRecognitionSession(lease.source.token);
			if (lease.source.token.isCancellationRequested) throw canceled();
			this.keywordCount++;
			lease.lifetime.add(toDisposable(() => { this.keywordCount--; this.keywordEnded.fire(); }));
			this.keywordStarted.fire();
			if (lease.lifetime.isDisposed) return token.isCancellationRequested ? KeywordRecognitionStatus.Canceled : KeywordRecognitionStatus.Stopped;
			return await new Promise<KeywordRecognitionStatus>(resolve => {
				lease.lifetime.add(toDisposable(() => resolve(token.isCancellationRequested ? KeywordRecognitionStatus.Canceled : KeywordRecognitionStatus.Stopped)));
				const listener = session.onDidChange(event => {
					if (event.status === KeywordRecognitionStatus.Recognized || event.status === KeywordRecognitionStatus.Stopped) { resolve(event.status); lease.lifetime.dispose(); }
				});
				if (lease.lifetime.isDisposed) listener.dispose();
				else lease.lifetime.add(listener);
			});
		} catch (error) {
			lease.lifetime.dispose();
			if (token.isCancellationRequested || this.isDisposed) return KeywordRecognitionStatus.Canceled;
			throw error;
		}
	}

	public async createSpeechToTextSession(token: CancellationToken, _context?: string): Promise<ISpeechToTextSession> {
		this.assertNotDisposed();
		if (!this.hasSpeechProvider) throw new Error(localize('speech.providerMissing', 'No speech extension provider is available.'));
		if (this.hasActiveSpeechToTextSession) { throw new Error(localize('dictation.alreadyActive', 'Dictation is already active')); }
		if (token.isCancellationRequested) throw canceled();
		// Admit before binding the token: a rejected caller must never acquire the current owner.
		const recording = this.start();
		const starting = recording.starting;
		if (!recording.lifetime.isDisposed) recording.lifetime.add(token.onCancellationRequested(() => {
			if (this.recording === recording) void this.cancel().catch(() => undefined);
		}));
		if (token.isCancellationRequested) void this.cancel().catch(() => undefined);
		await starting;
		if (token.isCancellationRequested || recording.cancelled || this.isDisposed) throw canceled();
		return {
			onDidChange: (listener, thisArgs, disposables) => {
				if (recording.stopped && recording.subscribed) return Disposable.None;
				if (!recording.stopped) return recording.events.event(listener, thisArgs, disposables);
				// A provider may finish before the awaited session reaches its caller. The closed session
				// retains only its bounded event receipt; no capture or service-owned listener stays alive.
				recording.subscribed = true;
				using receipt = new Emitter<ISpeechToTextEvent>();
				const subscription = receipt.event(listener, thisArgs, disposables);
				if (recording.started) receipt.fire({ status: SpeechToTextStatus.Started });
				for (const event of recording.pendingFinal) receipt.fire(event);
				if (recording.pendingError) receipt.fire(recording.pendingError);
				receipt.fire({ status: SpeechToTextStatus.Stopped });
				recording.pendingFinal.length = 0;
				recording.pendingInterim = recording.pendingError = undefined;
				return subscription;
			}
		};
	}

	private async activateProvider(token: CancellationToken, kind: 'speechToText' | 'textToSpeech' | 'keywordRecognition'): Promise<void> {
		if (token.isCancellationRequested || this.isDisposed) throw canceled();
		const controller = new AbortController();
		using cancellation = token.onCancellationRequested(() => controller.abort());
		this.activations.set(controller, kind);
		this.stateChanged.fire();
		try {
			await this.extensions!.activateByEvent('onSpeech', controller.signal);
			if (controller.signal.aborted || this.isDisposed) throw canceled();
			if (!this.providers.size) throw new Error(localize('speech.providerMissing', 'No speech extension provider is available.'));
		} catch (error) {
			if (controller.signal.aborted || this.isDisposed) throw canceled();
			throw error;
		} finally {
			this.activations.delete(controller);
			if (!this.isDisposed) this.stateChanged.fire();
		}
	}

	private start(): Recording {
		const lifetime = new DisposableStore();
		// Providers can emit during acquisition; keep bounded final phrases and the latest interim value until subscription.
		const events = lifetime.add(new Emitter<ISpeechToTextEvent>({
			onDidAddFirstListener: emitter => {
				if (recording.subscribed) return;
				recording.subscribed = true;
				if (recording.started) emitter.fire({ status: SpeechToTextStatus.Started });
				for (const event of recording.pendingFinal) emitter.fire(event);
				if (recording.pendingInterim) emitter.fire(recording.pendingInterim);
				if (recording.pendingError) emitter.fire(recording.pendingError);
				recording.pendingFinal.length = 0; recording.pendingInterim = undefined;
				if (recording.stopped) emitter.fire({ status: SpeechToTextStatus.Stopped });
			}
		}));
		const recording: Recording = { lifetime, events, subscribed: false, started: false, stopped: false, pendingFinal: [], cancelled: false };
		this.recording = recording;
		this.stateChanged.fire();
		recording.starting = this.startRecording(recording).finally(() => {
			recording.starting = undefined;
			if (!this.isDisposed) { this.stateChanged.fire(); }
		});
		return recording;
	}

	private async startRecording(recording: Recording): Promise<void> {
		try {
			// Recording is published before acquisition so commands can cancel immediately.
			// A synchronous cancellation from that notification must never open media afterwards.
			if (recording.cancelled || recording.stopping || this.recording !== recording || this.isDisposed) throw canceled();
			if (this.hasDeclaredProvider) {
				await this.activateProvider(CancellationToken.None, 'speechToText');
				if (recording.cancelled || this.recording !== recording || this.isDisposed) throw canceled();
			}
			if (this.providers.size) {
				const entry = this.selectProvider(); recording.provider = entry;
				const source = new CancellationTokenSource();
				recording.lifetime.add(toDisposable(() => source.dispose(true)));
				const session = entry.provider.createSpeechToTextSession(source.token, { language: speechLanguageConfigToLanguage(this.configuration?.getValue(SPEECH_LANGUAGE_CONFIG) ?? 'auto') });
				if (source.token.isCancellationRequested) throw canceled();
				recording.handle = { stop: async () => { source.cancel(); }, cancel: async () => { source.cancel(); } };
				const listener = session.onDidChange(event => {
					if (this.recording !== recording || recording.cancelled || this.isDisposed) return;
					if (event.status === SpeechToTextStatus.Started) {
						if (!recording.started) { recording.started = true; this.started.fire(); this.stateChanged.fire(); }
					} else if (event.status === SpeechToTextStatus.Recognizing || event.status === SpeechToTextStatus.Recognized) {
						this.receiveTranscript(recording, event.text ?? '', event.status === SpeechToTextStatus.Recognized);
						return;
					}
					if (recording.subscribed && event.status !== SpeechToTextStatus.Stopped) recording.events.fire(event);
					else if (event.status === SpeechToTextStatus.Error) recording.pendingError = event;
					if (event.status === SpeechToTextStatus.Stopped || event.status === SpeechToTextStatus.Error) {
						if (!recording.stopping) {
							this.recording = undefined;
							this.endRecording(recording);
							this.stateChanged.fire();
						}
					}
				});
				if (recording.lifetime.isDisposed) listener.dispose();
				else recording.lifetime.add(listener);
				return;
			}
		} catch (error) {
			if (this.recording === recording) {
				this.recording = undefined;
				this.endRecording(recording);
				this.stateChanged.fire();
			}
			throw error;
		}
	}

	private receiveTranscript(recording: Recording, text: string, isFinal: boolean): void {
		const event = { status: isFinal ? SpeechToTextStatus.Recognized : SpeechToTextStatus.Recognizing, text };
		if (recording.subscribed) recording.events.fire(event);
		else if (isFinal) {
			if (recording.pendingFinal.length >= 128) { void this.cancel(); return; }
			recording.pendingFinal.push(event); recording.pendingInterim = undefined;
		}
		else recording.pendingInterim = event;
	}

	private stopRecognition(): Promise<void> {
		for (const [controller, kind] of this.activations) if (kind === 'speechToText') controller.abort();
		const recording = this.recording;
		if (!recording) return Promise.resolve(undefined);
		if (recording.stopping) { return recording.stopping; }
		this.stateChanged.fire();
		recording.stopping = this.stopRecording(recording);
		return recording.stopping;
	}

	private async cancel(): Promise<void> {
		const recording = this.recording;
		if (recording) { recording.cancelled = true; }
		if (recording?.handle) { recording.cancelling ??= recording.handle.cancel(); }
		await Promise.all([recording?.cancelling, this.stopRecognition()]);
	}

	private async stopRecording(recording: Recording): Promise<void> {
		try {
			await recording.starting;
			if (recording.cancelled && recording.handle) { await (recording.cancelling ??= recording.handle.cancel()); }
			else { await recording.handle?.stop(); }
		} catch (error) {
			if (recording.cancelled || isCancellationError(error)) return undefined;
			throw error;
		} finally {
			if (this.recording === recording) {
				this.recording = undefined;
				this.endRecording(recording);
				this.stateChanged.fire();
			}
		}
	}

	private endRecording(recording: Recording): void {
		if (recording.stopped) return;
		recording.stopped = true;
		if (recording.started) this.ended.fire();
		recording.events.fire({ status: SpeechToTextStatus.Stopped });
		recording.lifetime.dispose();
	}

	protected override disposeCore(): void {
		for (const controller of this.activations.keys()) controller.abort();
		this.activations.clear();
		void this.cancel().catch(() => undefined);
		for (const lease of [...this.leases]) lease.lifetime.dispose();
		this.providers.clear();
		super.disposeCore();
	}
}
