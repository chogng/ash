import type { TextSnapshot } from '../../core/textChange.js';

export interface LanguageWorkerDocumentChange {
	readonly rangeOffset: number;
	readonly rangeLength: number;
	readonly text: string;
}

export interface LanguageWorkerDocumentSynchronization {
	readonly previousVersion: number;
	readonly modelVersion: number;
	readonly eol: '\n' | '\r\n';
	readonly changes: readonly LanguageWorkerDocumentChange[];
	readonly snapshot: TextSnapshot;
}

export interface LanguageWorkerDocumentSynchronizationObserver {
	synchronizeDocument(synchronization: LanguageWorkerDocumentSynchronization): void;
}

export interface WorkerTextModelResult<TResult> {
	readonly requestId: number;
	readonly snapshot: TextSnapshot;
	readonly result: TResult;
}

export interface WorkerTextModelCodec<TLane extends string, TPayload, TResult> {
	readonly lanes: readonly TLane[];
	createResultStore?(): WorkerTextModelResultStore<TLane, TResult>;
	encodePayload(lane: TLane, payload: TPayload): unknown;
	decodePayload(lane: TLane, value: unknown, snapshot: TextSnapshot): TPayload;
	encodeResult(lane: TLane, result: TResult, snapshot: TextSnapshot, base: WorkerTextModelResult<TResult> | undefined): unknown;
	decodeResult(lane: TLane, value: unknown, snapshot: TextSnapshot, base: WorkerTextModelResult<TResult> | undefined): TResult;
}

export interface WorkerTextModelResultStore<TLane extends string, TResult> {
	get(lane: TLane): WorkerTextModelResult<TResult> | undefined;
	stage(lane: TLane, state: WorkerTextModelResult<TResult>): void;
	settle(requestId: number, applied: boolean): void;
	clear(): void;
}
