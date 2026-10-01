import type { Event } from '../../../base/common/event.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const ILocalTranscriptionService = createDecorator<ILocalTranscriptionService>('localTranscriptionService');
export const ILocalTranscriptionBackendService = createDecorator<ILocalTranscriptionBackendService>('localTranscriptionBackendService');

export interface ILocalTranscriptionResult {
	readonly text: string;
	readonly isFinal: boolean;
}

export enum LocalTranscriptionModelState {
	Checking = 'checking',
	Downloading = 'downloading',
	Loading = 'loading',
	Ready = 'ready',
	Cancelled = 'cancelled',
	Error = 'error',
}

export type ILocalTranscriptionModelStatus =
	| { readonly state: LocalTranscriptionModelState.Checking | LocalTranscriptionModelState.Loading | LocalTranscriptionModelState.Ready | LocalTranscriptionModelState.Cancelled }
	| { readonly state: LocalTranscriptionModelState.Downloading; readonly file: string; readonly downloadedBytes: number }
	| { readonly state: LocalTranscriptionModelState.Error; readonly error: string };

/** Completion waits for backend release. Disposing an unfinished operation cancels its work. */
export interface ILocalTranscriptionModelOperation extends IDisposable {
	readonly completed: Promise<LocalTranscriptionModelState.Ready | LocalTranscriptionModelState.Cancelled>;
	cancel(): Promise<void>;
}

export type LocalTranscriptionModelOperation = { readonly type: 'prepare' } | { readonly type: 'import'; readonly sourceDirectory: string };

/** Capture, model preparation and inference belong to the shared Rust backend. */
export interface ILocalTranscriptionService extends IDisposable {
	readonly _serviceBrand: undefined;
	readonly isSupported: boolean;
	readonly onDidTranscribe: Event<ILocalTranscriptionResult>;
	readonly onDidEnd: Event<{ readonly error?: string }>;
	readonly onDidChangeModelStatus: Event<{ readonly model: string; readonly status: ILocalTranscriptionModelStatus }>;
	/** Checks installed files without loading the model or starting capture. */
	getModelStatus(model: string): Promise<{ readonly model: string; readonly available: boolean }>;
	prepareModel(model: string, onProgress: (status: ILocalTranscriptionModelStatus) => void): ILocalTranscriptionModelOperation;
	importModel(options: { readonly model: string; readonly sourcePath: string }, onProgress: (status: ILocalTranscriptionModelStatus) => void): ILocalTranscriptionModelOperation;
	start(options: { readonly model: string }): Promise<void>;
	/** Waits for capture to stop and returns the final transcript. */
	stop(): Promise<string>;
	/** Stops backend work and discards subsequent transcript delivery. */
	cancel(): Promise<void>;
}

/** Connection-scoped backend operations; resource IDs never escape the frontend service. */
export interface ILocalTranscriptionBackendService {
	readonly isConnected: boolean;
	readonly onDidDisconnect: Event<void>;
	readonly onDidTranscribe: Event<ILocalTranscriptionResult & { readonly resourceId: string }>;
	readonly onDidEnd: Event<{ readonly resourceId: string; readonly error?: string }>;
	readonly onDidChangeModelStatus: Event<{ readonly resourceId: string; readonly model: string; readonly status: ILocalTranscriptionModelStatus }>;
	getModelStatus(model: string): Promise<{ readonly model: string; readonly available: boolean }>;
	startModelOperation(resourceId: string, model: string, operation: LocalTranscriptionModelOperation): Promise<void>;
	stopModelOperation(resourceId: string): Promise<void>;
	start(resourceId: string, model: string): Promise<void>;
	stop(resourceId: string): Promise<string | null>;
}
