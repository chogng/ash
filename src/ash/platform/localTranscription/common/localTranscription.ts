import type { Event } from '../../../base/common/event.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { VSBuffer } from '../../../base/common/buffer.js';

/** Default on-device model package supplied by Ash. */
export const DEFAULT_LOCAL_TRANSCRIPTION_MODEL = 'paraformer-large-online-ec6a3c64';

export const ILocalTranscriptionService = createDecorator<ILocalTranscriptionService>('localTranscriptionService');
export const ILocalTranscriptionBackendService = createDecorator<ILocalTranscriptionBackendService>('localTranscriptionBackendService');

export interface ILocalTranscriptionResult {
	readonly text: string;
	readonly isFinal: boolean;
	readonly finalizedText?: string;
}

export enum DictationModelState {
	Checking = 'checking',
	Downloading = 'downloading',
	Loading = 'loading',
	Ready = 'ready',
	Cancelled = 'cancelled',
	Error = 'error',
}

export type IDictationModelStatus =
	| {
			readonly state: DictationModelState.Checking | DictationModelState.Loading | DictationModelState.Ready | DictationModelState.Cancelled;
	  }
	| { readonly state: DictationModelState.Downloading; readonly file: string; readonly downloadedBytes: number }
	| { readonly state: DictationModelState.Error; readonly error: string };

export interface ILocalTranscriptionModelSnapshot {
	readonly model: string;
	readonly available: boolean;
	readonly sizeBytes: number;
	readonly status?: IDictationModelStatus;
}

export function isModelPreparing(status: IDictationModelStatus | undefined): boolean {
	return status?.state === DictationModelState.Checking || status?.state === DictationModelState.Downloading || status?.state === DictationModelState.Loading;
}

/** Disposing detaches delivery. Only cancel explicitly stops the process-owned preparation. */
export interface ILocalTranscriptionModelOperation extends IDisposable {
	readonly completed: Promise<DictationModelState.Ready | DictationModelState.Cancelled>;
	cancel(): Promise<void>;
}

export type LocalTranscriptionModelOperation = { readonly type: 'prepare' } | { readonly type: 'import'; readonly sourceDirectory: string };

/** Ash model inventory and preparation; inference uses the standard transcription contract below. */
export const ILocalTranscriptionModelService = createDecorator<ILocalTranscriptionModelService>('localTranscriptionModelService');
export interface ILocalTranscriptionModelService {
	readonly _serviceBrand: undefined;
	readonly isSupported: boolean;
	readonly onDidChangeModels: Event<void>;
	getCacheDirectory(): Promise<string>;
	getModel(model: string): Promise<ILocalTranscriptionModelSnapshot>;
	listModels(): Promise<readonly ILocalTranscriptionModelSnapshot[]>;
	cancelModel(model: string): Promise<void>;
	deleteModel(model: string): Promise<void>;
	prepareModel(model: string, onProgress: (status: IDictationModelStatus) => void): ILocalTranscriptionModelOperation;
	importPackage(options: { readonly model: string; readonly sourcePath: string }, onProgress: (status: IDictationModelStatus) => void): ILocalTranscriptionModelOperation;
}
export interface ILocalTranscriptionModelImportResult {
	readonly model: string;
	readonly version: number;
}
export const enum LocalTranscriptionModelState {
	Idle = 'idle',
	Downloading = 'downloading',
	Loading = 'loading',
	Ready = 'ready',
	Error = 'error',
}
export interface ILocalTranscriptionModelStatus {
	readonly state: LocalTranscriptionModelState;
	readonly progress?: number;
	readonly downloaded?: boolean;
	readonly error?: string;
	readonly errorCode?: string;
}
/** Renderer PCM is transcribed by Ash's Rust backend. Foundry-specific runtime options are unsupported. */
export interface ILocalTranscriptionService {
	readonly _serviceBrand: undefined;
	readonly isSupported: boolean;
	readonly onDidChangeModelStatus: Event<ILocalTranscriptionModelStatus>;
	readonly onDidTranscribe: Event<ILocalTranscriptionResult>;
	getModelStatus(): Promise<ILocalTranscriptionModelStatus>;
	importModel(options: { readonly sourcePath: string; readonly cacheDir: string }): Promise<ILocalTranscriptionModelImportResult>;
	start(options: {
		readonly cacheDir: string;
		readonly model?: string;
		readonly language?: string;
		readonly proxyUrl?: string;
		readonly noProxy?: string;
		readonly proxyStrictSSL?: boolean;
		readonly proxyAuthorization?: string;
		readonly runtimeUrlTemplate?: string;
		readonly runtimeVersion?: string;
	}): Promise<void>;
	pushAudio(chunk: VSBuffer): Promise<void>;
	stop(): Promise<string>;
	cancel(): Promise<void>;
}

/** Connection-scoped backend operations; resource IDs never escape the frontend service. */
export interface ILocalTranscriptionBackendService {
	readonly isConnected: boolean;
	readonly onDidDisconnect: Event<void>;
	readonly onDidTranscribe: Event<ILocalTranscriptionResult & { readonly resourceId: string }>;
	readonly onDidEnd: Event<{ readonly resourceId: string; readonly error?: string }>;
	readonly onDidChangeModelStatus: Event<{
		readonly resourceId: string;
		readonly model: string;
		readonly status: IDictationModelStatus;
	}>;
	readonly onDidChangeModels: Event<void>;
	getModelStatus(model: string): Promise<ILocalTranscriptionModelSnapshot>;
	getModelCacheInfo(): Promise<{ readonly directory: string; readonly version: number }>;
	listModels(): Promise<readonly ILocalTranscriptionModelSnapshot[]>;
	cancelModel(model: string): Promise<void>;
	deleteModel(model: string): Promise<void>;
	startModelOperation(resourceId: string, model: string, operation: LocalTranscriptionModelOperation): Promise<void>;
	stopModelOperation(resourceId: string): Promise<void>;
	start(resourceId: string, model: string): Promise<void>;
	pushAudio(resourceId: string, chunk: VSBuffer): Promise<void>;
	stop(resourceId: string): Promise<string | null>;
	cancel(resourceId: string): Promise<void>;
}
