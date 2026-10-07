import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import { generateUuid } from '../../../base/common/uuid.js';
import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import { APP_SERVER_METHODS } from '../../app-server/common/generated/index.js';
import { validateConfigurationSnapshot, type IConfigurationApi } from '../../configuration/common/configurationIpc.js';
import { dictationBackend, dictationInputOptions } from '../common/dictationConfiguration.js';
import type { IDictationService, IDictationSession, IDictationOptions } from '../common/dictationService.js';
import { ILocalTranscriptionService } from '../../localTranscription/common/localTranscription.js';
import { localize } from '../../../nls.js';

interface DictationCallbacks {
	readonly onTranscript: (text: string, isFinal: boolean) => void;
	readonly onEnded: (error?: string) => void;
	stopping: boolean;
	endedError?: string;
}

type ActiveDictation = DictationCallbacks & (
	{ readonly source: 'local'; } |
	{ readonly source: 'cloud'; readonly resourceId: string; finalDelivered: boolean; }
);

export class AppServerDictationService extends Disposable implements IDictationService {
	private readonly preparationChanged = this._register(new Emitter<void>());
	public readonly onDidChangePreparation = this.preparationChanged.event;
	private active: ActiveDictation | undefined;
	private starting = false;

	constructor(private readonly client: AppServerProtocolClient, private readonly configuration: IConfigurationApi, @ILocalTranscriptionService private readonly localTranscription: ILocalTranscriptionService) {
		super();
		const configurationSubscription = configuration.onDidChange(() => this.preparationChanged.fire());
		this._register(toDisposable(() => configurationSubscription.dispose()));
		this._register(localTranscription.onDidChangeModels(() => this.preparationChanged.fire()));
		this._register(client.onStateChange(() => this.preparationChanged.fire()));
		this._register(localTranscription.onDidTranscribe(result => {
			const active = this.active;
			if (!active || active.source !== 'local') { return; }
			active.onTranscript(result.text, result.isFinal);
		}));
		this._register(localTranscription.onDidEnd(result => {
			const active = this.active;
			if (!active || active.source !== 'local') { return; }
			if (active.stopping) {
				active.endedError = result.error;
				return;
			}
			this.active = undefined;
			active.onEnded(result.error);
		}));
		this._register(client.onNotification(notification => {
			const active = this.active;
			if (!active || active.source !== 'cloud') { return; }
			if (notification.method === 'dictation/transcript' && notification.params.resourceId === active.resourceId) {
				if (notification.params.isFinal) { active.finalDelivered = true; }
				active.onTranscript(notification.params.text, notification.params.isFinal);
			} else if (notification.method === 'dictation/ended' && notification.params.resourceId === active.resourceId) {
				if (active.stopping) {
					active.endedError = notification.params.error ?? undefined;
					return;
				}
				this.active = undefined;
				active.onEnded(notification.params.error ?? undefined);
				if (!active.stopping) { void this.client.request(APP_SERVER_METHODS['dictation/stop'], { resourceId: active.resourceId }).catch(() => undefined); }
			}
		}));
		this._register(client.onStateChange(state => {
			if (state === 'ready' || !this.active || this.active.source !== 'cloud') { return; }
			const active = this.active;
			this.active = undefined;
			active.onEnded(localize('dictation.connectionLost', 'Dictation connection lost'));
		}));
	}

	public async getPreparation() {
		const backend = dictationBackend(validateConfigurationSnapshot(await this.configuration.read()).document);
		return backend.type === 'local' ? this.localTranscription.getModelStatus(backend.modelId) : undefined;
	}
	public async prepareModel(): Promise<void> {
		const backend = dictationBackend(validateConfigurationSnapshot(await this.configuration.read()).document);
		if (backend.type === 'local') { await this.localTranscription.prepareModel(backend.modelId, () => { }).completed; }
	}
	public async cancelPreparation(): Promise<void> {
		const backend = dictationBackend(validateConfigurationSnapshot(await this.configuration.read()).document);
		if (backend.type === 'local') { await this.localTranscription.cancelModel(backend.modelId); }
	}

	public async getOptions(): Promise<IDictationOptions> {
		const backend = dictationBackend(validateConfigurationSnapshot(await this.configuration.read()).document);
		return this.client.request(APP_SERVER_METHODS['dictation/options'], { backend });
	}

	async start(onTranscript: (text: string, isFinal: boolean) => void, onEnded: (error?: string) => void): Promise<IDictationSession> {
		this.assertNotDisposed();
		if (this.client.state !== 'ready') { throw new Error(localize('dictation.connectionUnavailable', 'Dictation connection is unavailable')); }
		if (this.active || this.starting) { throw new Error(localize('dictation.alreadyActive', 'Dictation is already active')); }
		this.starting = true;
		try {
			const document = validateConfigurationSnapshot(await this.configuration.read()).document;
			const backend = dictationBackend(document);
			const options = dictationInputOptions(document, backend.type);
			this.assertNotDisposed();
			const callbacks: DictationCallbacks = { onTranscript, onEnded, stopping: false };
			const active: ActiveDictation = backend.type === 'local'
				? { ...callbacks, source: 'local' }
				: { ...callbacks, source: 'cloud', resourceId: generateUuid(), finalDelivered: false };
			this.active = active;
			try {
				if (active.source === 'local') {
					await this.localTranscription.start({ model: backend.modelId, inputDevice: options.inputDevice ?? undefined });
				} else {
					await this.client.request(APP_SERVER_METHODS['dictation/start'], { resourceId: active.resourceId, backend, ...options });
				}
			} catch (error) {
				if (this.active === active) { this.active = undefined; }
				throw error;
			}
			return { stop: () => this.stop(active) };
		} finally {
			this.starting = false;
		}
	}

	private async stop(active: ActiveDictation): Promise<void> {
		if (this.active !== active) { return; }
		active.stopping = true;
		try {
			if (active.source === 'local') {
				await this.localTranscription.stop();
				if (this.active === active) {
					this.active = undefined;
					active.onEnded(active.endedError);
				}
				return;
			}
			const result = await this.client.request(APP_SERVER_METHODS['dictation/stop'], { resourceId: active.resourceId });
			if (!active.finalDelivered && result.text !== null) {
				active.finalDelivered = true;
				active.onTranscript(result.text, true);
			}
			if (this.active === active) {
				this.active = undefined;
				active.onEnded(active.endedError);
			}
		} catch (error) {
			if (this.active === active) { this.active = undefined; }
			throw error;
		}
	}

	protected override disposeCore(): void {
		const active = this.active;
		this.active = undefined;
		if (active?.source === 'local') {
			void this.localTranscription.cancel().catch(() => undefined);
		} else if (active) {
			void this.client.request(APP_SERVER_METHODS['dictation/stop'], { resourceId: active.resourceId }).catch(() => undefined);
		}
		super.disposeCore();
	}
}
