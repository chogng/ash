import type { Event } from '../../../base/common/event.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const ILocalTranscriptionService = createDecorator<ILocalTranscriptionService>('localTranscriptionService');
export const ILocalTranscriptionBackendService = createDecorator<ILocalTranscriptionBackendService>('localTranscriptionBackendService');

export interface ILocalTranscriptionResult {
	readonly text: string;
	readonly isFinal: boolean;
}

/** Capture, model preparation and inference belong to the shared Rust backend. */
export interface ILocalTranscriptionService extends IDisposable {
	readonly _serviceBrand: undefined;
	readonly isSupported: boolean;
	readonly onDidTranscribe: Event<ILocalTranscriptionResult>;
	readonly onDidEnd: Event<{ readonly error?: string }>;
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
	start(resourceId: string, model: string): Promise<void>;
	stop(resourceId: string): Promise<string | null>;
}
