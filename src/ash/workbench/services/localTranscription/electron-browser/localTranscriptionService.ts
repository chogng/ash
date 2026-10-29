import { Emitter } from '../../../../base/common/event.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { canceled } from '../../../../base/common/errors.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import type { VSBuffer } from '../../../../base/common/buffer.js';
import type { AppServerProtocolClient } from '../../../../platform/agentHost/browser/appServerProtocolClient.js';
import { createAppServerLocalTranscriptionBackendService } from '../../../../platform/localTranscription/browser/appServerLocalTranscriptionBackendService.js';
import {
	ILocalTranscriptionBackendService,
	ILocalTranscriptionService,
	ILocalTranscriptionModelService,
	DEFAULT_LOCAL_TRANSCRIPTION_MODEL,
	LocalTranscriptionModelState,
	DictationModelState,
	type ILocalTranscriptionModelStatus,
	type ILocalTranscriptionResult,
	type IDictationModelStatus,
	type ILocalTranscriptionModelOperation,
	type LocalTranscriptionModelOperation,
} from '../../../../platform/localTranscription/common/localTranscription.js';
import type { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import type { RendererHostCapabilities } from '../../../../platform/renderer/common/rendererHost.js';
import { localize } from '../../../../nls.js';

interface ActiveTranscription {
	readonly resourceId: string;
	readonly started: Promise<void>;
	audio: Promise<void>;
	text: string;
	finalDelivered: boolean;
	finalReceived: boolean;
	queuedBytes: number;
	discard: boolean;
	hasEnded: boolean;
	endedError?: string;
	stopping?: Promise<string>;
	cancelling?: Promise<void>;
	readonly cancelled: DeferredPromise<string>;
}

export class LocalTranscriptionService extends Disposable implements ILocalTranscriptionService, ILocalTranscriptionModelService {
	public readonly _serviceBrand = undefined;
	public readonly isSupported = true;
	private readonly transcribed = this._register(new Emitter<ILocalTranscriptionResult>());
	public readonly onDidTranscribe = this.transcribed.event;
	private active: ActiveTranscription | undefined;
	private readonly modelStatus = this._register(new Emitter<ILocalTranscriptionModelStatus>());
	public readonly onDidChangeModelStatus = this.modelStatus.event;
	private status: ILocalTranscriptionModelStatus = { state: LocalTranscriptionModelState.Idle };
	private readonly models = this._register(new DisposableMap<string, ModelOperation>());

	constructor(@ILocalTranscriptionBackendService private readonly backend: ILocalTranscriptionBackendService) {
		super();
		this._register(
			backend.onDidChangeModelStatus(result => {
				if (result.resourceId === this.active?.resourceId && !this.active.discard && !this.active.hasEnded) {
					const stage = result.status;
					this.setStatus(transcriptionStatus(stage));
				}
			}),
		);
		this._register(
			backend.onDidTranscribe(result => {
				const active = this.active;
				if (!active || result.resourceId !== active.resourceId || active.discard || active.finalReceived || active.hasEnded) {
					return;
				}
				active.text = result.text;
				active.finalReceived = result.isFinal;
				// Final delivery follows the stop receipt, including failures reported after the notification.
				if (!result.isFinal) this.transcribed.fire({ text: result.text, isFinal: false });
			}),
		);
		this._register(
			backend.onDidEnd(result => {
				const active = this.active;
				if (!active || result.resourceId !== active.resourceId) {
					return;
				}
				active.hasEnded = true;
				active.endedError = result.error;
				if (active.stopping) {
					return;
				}
				// Ended stops delivery, but the backend resource still needs its explicit release.
				void this.finish(active).catch(() => undefined);
			}),
		);
		this._register(
			backend.onDidDisconnect(() => {
				if (!this.active) {
					return;
				}
				this.active = undefined;
				this.setStatus({
					state: LocalTranscriptionModelState.Error,
					error: localize('dictation.connectionLost', 'Dictation connection lost'),
				});
			}),
		);
	}

	public get onDidChangeModels() {
		return this.backend.onDidChangeModels;
	}
	public listModels() {
		this.assertNotDisposed();
		return this.backend.listModels();
	}
	public cancelModel(model: string) {
		this.assertNotDisposed();
		return this.backend.cancelModel(model);
	}
	public deleteModel(model: string) {
		this.assertNotDisposed();
		return this.backend.deleteModel(model);
	}
	public getModel(model: string) {
		this.assertNotDisposed();
		return this.backend.getModelStatus(model);
	}

	public prepareModel(model: string, onProgress: (status: IDictationModelStatus) => void): ILocalTranscriptionModelOperation {
		return this.startModelOperation(model, { type: 'prepare' }, onProgress);
	}

	public importPackage(options: { readonly model: string; readonly sourcePath: string }, onProgress: (status: IDictationModelStatus) => void): ILocalTranscriptionModelOperation {
		return this.startModelOperation(options.model, { type: 'import', sourceDirectory: options.sourcePath }, onProgress);
	}

	private startModelOperation(model: string, operation: LocalTranscriptionModelOperation, onProgress: (status: IDictationModelStatus) => void): ILocalTranscriptionModelOperation {
		this.assertNotDisposed();
		if (!this.backend.isConnected) {
			throw new Error(localize('dictation.connectionUnavailable', 'Dictation connection is unavailable'));
		}
		const resourceId = generateUuid();
		const handle = this.models.set(resourceId, new ModelOperation(this.backend, resourceId, onProgress));
		void handle.completed.then(
			() => this.models.deleteAndDispose(resourceId),
			() => this.models.deleteAndDispose(resourceId),
		);
		handle.start(model, operation);
		return handle;
	}

	public async getModelStatus(): Promise<ILocalTranscriptionModelStatus> {
		this.assertNotDisposed();
		return this.status;
	}
	public async getCacheDirectory(): Promise<string> {
		this.assertNotDisposed();
		return (await this.backend.getModelCacheInfo()).directory;
	}
	private setStatus(status: ILocalTranscriptionModelStatus): void {
		this.status = status;
		this.modelStatus.fire(status);
	}

	/** Cache location and package format are backend-owned; foreign cache roots cannot be silently ignored. */
	public async importModel(options: Parameters<ILocalTranscriptionService['importModel']>[0]) {
		this.assertNotDisposed();
		const cache = await this.backend.getModelCacheInfo();
		if (options.cacheDir !== cache.directory) throw new Error(localize('dictation.managedCache', 'Local transcription uses the managed cache directory: {0}', cache.directory));
		const operation = this.importPackage({ model: DEFAULT_LOCAL_TRANSCRIPTION_MODEL, sourcePath: options.sourcePath }, () => {});
		try {
			if ((await operation.completed) !== DictationModelState.Ready) throw new Error(localize('dictation.importCancelled', 'Model import was cancelled'));
			return { model: DEFAULT_LOCAL_TRANSCRIPTION_MODEL, version: cache.version };
		} finally {
			operation.dispose();
		}
	}

	public async start(options: Parameters<ILocalTranscriptionService['start']>[0]): Promise<void> {
		this.assertNotDisposed();
		if (!this.backend.isConnected) {
			throw new Error(localize('dictation.connectionUnavailable', 'Dictation connection is unavailable'));
		}
		if (this.active) {
			throw new Error(localize('dictation.alreadyActive', 'Dictation is already active'));
		}
		const resourceId = generateUuid();
		const started = Promise.resolve().then(async () => {
			const unsupported = (['language', 'proxyUrl', 'noProxy', 'proxyStrictSSL', 'proxyAuthorization', 'runtimeUrlTemplate', 'runtimeVersion'] as const).filter(
				key => options[key] !== undefined,
			);
			if (unsupported.length) throw new Error(localize('dictation.unsupportedLocalOptions', 'This local transcription backend does not support: {0}', unsupported.join(', ')));
			const cacheDirectory = await this.getCacheDirectory();
			if (options.cacheDir !== cacheDirectory) throw new Error(localize('dictation.managedCache', 'Local transcription uses the managed cache directory: {0}', cacheDirectory));
			if (active.discard) throw canceled();
			await this.backend.start(resourceId, options.model ?? DEFAULT_LOCAL_TRANSCRIPTION_MODEL);
		});
		const active: ActiveTranscription = {
			resourceId,
			started,
			audio: started,
			text: '',
			finalDelivered: false,
			finalReceived: false,
			queuedBytes: 0,
			discard: false,
			hasEnded: false,
			cancelled: new DeferredPromise<string>(),
		};
		this.active = active;
		this.setStatus({ state: LocalTranscriptionModelState.Loading });
		try {
			await started;
		} catch (error) {
			if (this.active === active) {
				this.active = undefined;
				this.setStatus(active.discard ? { state: LocalTranscriptionModelState.Idle } : { state: LocalTranscriptionModelState.Error, error: String(error) });
			}
			throw error;
		}
	}

	public stop(): Promise<string> {
		return this.active ? this.finish(this.active) : Promise.resolve('');
	}

	public pushAudio(chunk: VSBuffer): Promise<void> {
		this.assertNotDisposed();
		const active = this.active;
		if (!active || active.discard || active.hasEnded || active.stopping) return Promise.resolve();
		if (active.queuedBytes + chunk.byteLength > 4 * 1024 * 1024) return Promise.reject(new Error(localize('dictation.audioBackpressure', 'Transcription audio is empty or backpressured')));
		active.queuedBytes += chunk.byteLength;
		active.audio = active.audio
			.then(async () => {
				if (this.active === active && !active.discard) await this.backend.pushAudio(active.resourceId, chunk);
			})
			.finally(() => {
				active.queuedBytes -= chunk.byteLength;
			});
		return active.audio;
	}

	public cancel(): Promise<void> {
		const active = this.active;
		if (!active) return Promise.resolve();
		active.discard = true;
		// Cancellation bypasses audio and finalization; both may be waiting for the backend being cancelled.
		active.cancelling ??= Promise.resolve()
			.then(async () => {
				try {
					await active.started;
				} catch {
					return;
				}
				await this.backend.cancel(active.resourceId);
			})
			.then(
				() => {
					void active.cancelled.complete('');
					if (this.active === active) {
						this.active = undefined;
						this.setStatus({ state: LocalTranscriptionModelState.Idle });
					}
				},
				error => {
					active.cancelling = undefined;
					if (this.active === active) this.setStatus({ state: LocalTranscriptionModelState.Error, error: String(error) });
					throw error;
				},
			);
		return active.cancelling;
	}

	private finish(active: ActiveTranscription): Promise<string> {
		if (active.stopping) {
			return active.stopping;
		}
		active.stopping = Promise.race([this.stopBackend(active), active.cancelled.p]);
		return active.stopping;
	}

	private async stopBackend(active: ActiveTranscription): Promise<string> {
		try {
			// A stop issued while startup is pending must release the resource after acceptance.
			await active.started;
			// Failed audio must still release the admitted backend resource.
			let audioError: unknown;
			try {
				await active.audio;
			} catch (error) {
				audioError = error;
			}
			if (this.active !== active) {
				return '';
			}
			const text = await this.backend.stop(active.resourceId);
			if (this.active !== active) {
				return '';
			}
			if (audioError) throw audioError;
			if (active.endedError) {
				throw new Error(active.endedError);
			}
			if (!active.discard && !active.finalDelivered) {
				active.text = text ?? active.text;
				active.finalDelivered = true;
				this.transcribed.fire({ text: active.text, isFinal: true });
			}
			return active.discard ? '' : active.text;
		} catch (error) {
			active.endedError ??= String(error);
			if (active.discard) return '';
			throw error;
		} finally {
			if (this.active === active && !active.cancelling) {
				this.active = undefined;
				this.setStatus(active.endedError && !active.discard ? { state: LocalTranscriptionModelState.Error, error: active.endedError } : { state: LocalTranscriptionModelState.Idle });
			}
		}
	}

	protected override disposeCore(): void {
		void this.cancel().catch(() => undefined);
		super.disposeCore();
	}
}

class ModelOperation extends Disposable implements ILocalTranscriptionModelOperation {
	private readonly completion = new DeferredPromise<DictationModelState.Ready | DictationModelState.Cancelled>();
	public readonly completed = this.completion.p;
	private started: Promise<void> = Promise.resolve();
	private released: Promise<void> | undefined;
	private terminal: IDictationModelStatus | undefined;

	constructor(
		private readonly backend: ILocalTranscriptionBackendService,
		private readonly resourceId: string,
		private readonly onProgress: (status: IDictationModelStatus) => void,
	) {
		super();
		this._register(
			backend.onDidChangeModelStatus(event => {
				if (event.resourceId !== resourceId || this.terminal || this.completion.isSettled) {
					return;
				}
				const status = event.status;
				if (status.state === DictationModelState.Ready || status.state === DictationModelState.Cancelled || status.state === DictationModelState.Error) {
					this.terminal = status;
					void this.release();
				}
				if (!this.isDisposed) {
					this.onProgress(status);
				}
			}),
		);
		this._register(
			backend.onDidDisconnect(() => {
				void this.completion.error(new Error(localize('dictation.connectionLost', 'Dictation connection lost')));
			}),
		);
	}

	public start(model: string, operation: LocalTranscriptionModelOperation): void {
		// Register delivery before issuing start: a cached model may finish before acceptance arrives.
		this.started = Promise.resolve().then(() => this.backend.startModelOperation(this.resourceId, model, operation));
		void this.started.catch(error => {
			void this.completion.error(error);
		});
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
			if (this.backend.isConnected) {
				await this.backend.stopModelOperation(this.resourceId);
			}
			const terminal = this.terminal;
			if (terminal?.state === DictationModelState.Error) {
				throw new Error(terminal.error);
			}
			await this.completion.complete(terminal?.state === DictationModelState.Ready ? DictationModelState.Ready : DictationModelState.Cancelled);
		} catch (error) {
			await this.completion.error(error);
		}
	}

	protected override disposeCore(): void {
		if (!this.completion.isSettled) {
			void this.completion.error(new Error(localize('dictation.connectionLost', 'Dictation connection lost')));
		}
		super.disposeCore();
	}
}

/** The renderer entry owns this service scope and releases it with the window. */
export function registerLocalTranscriptionService(services: InstantiationService, client: AppServerProtocolClient): RendererHostCapabilities {
	services.registerInstance(ILocalTranscriptionBackendService, createAppServerLocalTranscriptionBackendService(client));
	services.registerSingleton(ILocalTranscriptionService, () => services.createInstance(LocalTranscriptionService));
	services.registerSingleton(ILocalTranscriptionModelService, () => services.get(ILocalTranscriptionService) as LocalTranscriptionService);
	return {
		localTranscription: services.get(ILocalTranscriptionService),
		localTranscriptionModels: services.get(ILocalTranscriptionModelService),
	};
}

function transcriptionStatus(status: IDictationModelStatus): ILocalTranscriptionModelStatus {
	switch (status.state) {
		case DictationModelState.Checking:
		case DictationModelState.Loading:
			return { state: LocalTranscriptionModelState.Loading };
		case DictationModelState.Cancelled:
			return { state: LocalTranscriptionModelState.Idle };
		case DictationModelState.Downloading:
			return { state: LocalTranscriptionModelState.Downloading };
		case DictationModelState.Ready:
			return { state: LocalTranscriptionModelState.Ready };
		case DictationModelState.Error:
			return { state: LocalTranscriptionModelState.Error, error: status.error };
	}
}
