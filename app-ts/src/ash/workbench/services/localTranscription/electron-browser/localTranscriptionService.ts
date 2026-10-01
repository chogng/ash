import { Emitter } from '../../../../base/common/event.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import type { AppServerProtocolClient } from '../../../../platform/app-server/browser/appServerProtocolClient.js';
import { createAppServerLocalTranscriptionBackendService } from '../../../../platform/localTranscription/browser/appServerLocalTranscriptionBackendService.js';
import { ILocalTranscriptionBackendService, ILocalTranscriptionService, LocalTranscriptionModelState, type ILocalTranscriptionResult, type ILocalTranscriptionModelStatus, type ILocalTranscriptionModelOperation, type LocalTranscriptionModelOperation } from '../../../../platform/localTranscription/common/localTranscription.js';
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
	private readonly modelStatus = this._register(new Emitter<{ readonly model: string; readonly status: ILocalTranscriptionModelStatus }>());
	public readonly onDidChangeModelStatus = this.modelStatus.event;
	private readonly models = this._register(new DisposableMap<string, ModelOperation>());

	constructor(@ILocalTranscriptionBackendService private readonly backend: ILocalTranscriptionBackendService) {
		super();
		this._register(backend.onDidChangeModelStatus(result => {
			if (result.resourceId === this.active?.resourceId && !this.active.discard && !this.active.hasEnded) {
				this.modelStatus.fire({ model: result.model, status: result.status });
			}
		}));
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

	public getModelStatus(model: string): Promise<{ readonly model: string; readonly available: boolean }> {
		this.assertNotDisposed();
		return this.backend.getModelStatus(model);
	}

	public prepareModel(model: string, onProgress: (status: ILocalTranscriptionModelStatus) => void): ILocalTranscriptionModelOperation {
		return this.startModelOperation(model, { type: 'prepare' }, onProgress);
	}

	public importModel(options: { readonly model: string; readonly sourcePath: string }, onProgress: (status: ILocalTranscriptionModelStatus) => void): ILocalTranscriptionModelOperation {
		return this.startModelOperation(options.model, { type: 'import', sourceDirectory: options.sourcePath }, onProgress);
	}

	private startModelOperation(model: string, operation: LocalTranscriptionModelOperation, onProgress: (status: ILocalTranscriptionModelStatus) => void): ILocalTranscriptionModelOperation {
		this.assertNotDisposed();
		if (!this.backend.isConnected) { throw new Error(localize('dictation.connectionUnavailable', 'Dictation connection is unavailable')); }
		const resourceId = generateUuid();
		const handle = this.models.set(resourceId, new ModelOperation(this.backend, resourceId, onProgress));
		void handle.completed.then(() => this.models.deleteAndDispose(resourceId), () => this.models.deleteAndDispose(resourceId));
		handle.start(model, operation);
		return handle;
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

class ModelOperation extends Disposable implements ILocalTranscriptionModelOperation {
	private readonly completion = new DeferredPromise<LocalTranscriptionModelState.Ready | LocalTranscriptionModelState.Cancelled>();
	public readonly completed = this.completion.p;
	private started: Promise<void> = Promise.resolve();
	private released: Promise<void> | undefined;
	private terminal: ILocalTranscriptionModelStatus | undefined;

	constructor(private readonly backend: ILocalTranscriptionBackendService, private readonly resourceId: string, private readonly onProgress: (status: ILocalTranscriptionModelStatus) => void) {
		super();
		this._register(backend.onDidChangeModelStatus(event => {
			if (event.resourceId !== resourceId || this.terminal || this.completion.isSettled) { return; }
			const status = event.status;
			if (status.state === LocalTranscriptionModelState.Ready || status.state === LocalTranscriptionModelState.Cancelled || status.state === LocalTranscriptionModelState.Error) {
				this.terminal = status;
				void this.release();
			}
			if (!this.isDisposed) { this.onProgress(status); }
		}));
		this._register(backend.onDidDisconnect(() => {
			void this.completion.error(new Error(localize('dictation.connectionLost', 'Dictation connection lost')));
		}));
	}

	public start(model: string, operation: LocalTranscriptionModelOperation): void {
		// Register delivery before issuing start: a cached model may finish before acceptance arrives.
		this.started = Promise.resolve().then(() => this.backend.startModelOperation(this.resourceId, model, operation));
		void this.started.catch(error => { void this.completion.error(error); });
	}

	public cancel(): Promise<void> {
		return this.completion.isSettled ? Promise.resolve() : this.release();
	}

	private release(): Promise<void> {
		this.released ??= this.releaseBackend();
		return this.released;
	}

	private async releaseBackend(): Promise<void> {
		try {
			await this.started;
			if (this.backend.isConnected) { await this.backend.stopModelOperation(this.resourceId); }
			const terminal = this.terminal;
			if (terminal?.state === LocalTranscriptionModelState.Error) { throw new Error(terminal.error); }
			await this.completion.complete(terminal?.state === LocalTranscriptionModelState.Ready ? LocalTranscriptionModelState.Ready : LocalTranscriptionModelState.Cancelled);
		} catch (error) {
			await this.completion.error(error);
		}
	}

	protected override disposeCore(): void {
		void this.cancel();
		super.disposeCore();
	}
}

/** The renderer entry owns this service scope and releases it with the window. */
export function registerLocalTranscriptionService(services: InstantiationService, client: AppServerProtocolClient): RendererHostCapabilities {
	services.registerInstance(ILocalTranscriptionBackendService, createAppServerLocalTranscriptionBackendService(client));
	services.registerSingleton(ILocalTranscriptionService, () => services.createInstance(LocalTranscriptionService));
	return { localTranscription: services.get(ILocalTranscriptionService) };
}
