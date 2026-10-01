import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import type { AppServerProtocolClient } from '../../../../platform/app-server/browser/appServerProtocolClient.js';
import { createAppServerLocalTranscriptionBackendService } from '../../../../platform/localTranscription/browser/appServerLocalTranscriptionBackendService.js';
import { ILocalTranscriptionBackendService, ILocalTranscriptionService, type ILocalTranscriptionResult } from '../../../../platform/localTranscription/common/localTranscription.js';
import type { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import type { RendererHostCapabilities } from '../../../../platform/renderer/common/rendererHost.js';
import { localize } from '../../../../nls.js';

interface ActiveTranscription {
	readonly resourceId: string;
	readonly started: Promise<void>;
	text: string;
	finalDelivered: boolean;
	discard: boolean;
	hasEnded: boolean;
	endedError?: string;
	stopping?: Promise<string>;
}

export class LocalTranscriptionService extends Disposable implements ILocalTranscriptionService {
	public readonly _serviceBrand = undefined;
	public readonly isSupported = true;
	private readonly transcribed = this._register(new Emitter<ILocalTranscriptionResult>());
	public readonly onDidTranscribe = this.transcribed.event;
	private readonly ended = this._register(new Emitter<{ readonly error?: string }>());
	public readonly onDidEnd = this.ended.event;
	private active: ActiveTranscription | undefined;

	constructor(@ILocalTranscriptionBackendService private readonly backend: ILocalTranscriptionBackendService) {
		super();
		this._register(backend.onDidTranscribe(result => {
			const active = this.active;
			if (!active || result.resourceId !== active.resourceId || active.discard || active.finalDelivered || active.hasEnded) { return; }
			active.text = result.text;
			active.finalDelivered = result.isFinal;
			this.transcribed.fire({ text: result.text, isFinal: result.isFinal });
		}));
		this._register(backend.onDidEnd(result => {
			const active = this.active;
			if (!active || result.resourceId !== active.resourceId) { return; }
			active.hasEnded = true;
			active.endedError = result.error;
			if (active.stopping) { return; }
			// Ended stops delivery, but the backend resource still needs its explicit release.
			void this.finish(active).catch(() => undefined);
		}));
		this._register(backend.onDidDisconnect(() => {
			if (!this.active) { return; }
			this.active = undefined;
			this.ended.fire({ error: localize('dictation.connectionLost', 'Dictation connection lost') });
		}));
	}

	public async start(options: { readonly model: string }): Promise<void> {
		this.assertNotDisposed();
		if (!this.backend.isConnected) { throw new Error(localize('dictation.connectionUnavailable', 'Dictation connection is unavailable')); }
		if (this.active) { throw new Error(localize('dictation.alreadyActive', 'Dictation is already active')); }
		const resourceId = generateUuid();
		const started = Promise.resolve().then(() => this.backend.start(resourceId, options.model));
		const active: ActiveTranscription = { resourceId, started, text: '', finalDelivered: false, discard: false, hasEnded: false };
		this.active = active;
		try {
			await started;
		} catch (error) {
			if (this.active === active) { this.active = undefined; }
			throw error;
		}
	}

	public stop(): Promise<string> {
		return this.active ? this.finish(this.active) : Promise.resolve('');
	}

	public async cancel(): Promise<void> {
		const active = this.active;
		if (!active) { return; }
		active.discard = true;
		await this.finish(active);
	}

	private finish(active: ActiveTranscription): Promise<string> {
		if (active.stopping) { return active.stopping; }
		active.stopping = this.stopBackend(active);
		return active.stopping;
	}

	private async stopBackend(active: ActiveTranscription): Promise<string> {
		try {
			// A stop issued while startup is pending must release the resource after acceptance.
			await active.started;
			if (this.active !== active) { return ''; }
			const text = await this.backend.stop(active.resourceId);
			if (this.active !== active) { return ''; }
			if (!active.discard && !active.finalDelivered && text !== null) {
				active.text = text;
				active.finalDelivered = true;
				this.transcribed.fire({ text, isFinal: true });
			}
			if (active.endedError) { throw new Error(active.endedError); }
			return active.discard ? '' : active.text;
		} catch (error) {
			active.endedError ??= String(error);
			throw error;
		} finally {
			if (this.active === active) {
				this.active = undefined;
				this.ended.fire({ error: active.discard ? undefined : active.endedError });
			}
		}
	}

	protected override disposeCore(): void {
		void this.cancel().catch(() => undefined);
		super.disposeCore();
	}
}

/** The renderer entry owns this service scope and releases it with the window. */
export function registerLocalTranscriptionService(services: InstantiationService, client: AppServerProtocolClient): RendererHostCapabilities {
	services.registerInstance(ILocalTranscriptionBackendService, createAppServerLocalTranscriptionBackendService(client));
	services.registerSingleton(ILocalTranscriptionService, () => services.createInstance(LocalTranscriptionService));
	return { localTranscription: services.get(ILocalTranscriptionService) };
}
