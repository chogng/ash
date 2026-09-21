import { raceCancellationError } from '../../../base/common/async.js';
import { onUnexpectedError } from '../../../base/common/errors.js';
import { Disposable, MutableDisposable, type IDisposable, toDisposable } from "../../../base/common/lifecycle.js";
import { type TextModelChange, type TextSnapshot } from "../core/textChange.js";
import { type TextModel } from "../model/textModel.js";

/** One immutable worker invocation against a captured model version. */
export interface LanguageWorkerRequest<TLane extends string, TPayload> {
	readonly requestId: number;
	readonly lane: TLane;
	readonly snapshot: TextSnapshot;
	readonly payload: TPayload;
}

/**
 * Executes language work for one coordinator-owned worker instance.
 *
 * Implementations must observe `signal`, tolerate cancellation of one request,
 * and remain reusable until disposed. A rejected active request is treated as
 * worker failure and causes the coordinator to replace the instance.
 */
export interface LanguageWorker<TLane extends string, TPayload, TResult> extends IDisposable {
	run(request: LanguageWorkerRequest<TLane, TPayload>, signal: AbortSignal): Promise<TResult>;
}

/**
 * Optional single-model synchronization capability for a reusable worker.
 *
 * The coordinator calls this after cancelling requests for the previous
 * version. Implementations must consume changes in increasing model-version
 * order and may discard their mirror when a version is missing.
 */
export interface LanguageWorkerModelSynchronizer {
	synchronizeModel(change: TextModelChange): void;
}

export enum LanguageWorkerResultDisposition {
	Applied = "applied",
	Discarded = "discarded",
}

/** Optional result-lifecycle hook invoked after the renderer application gate. */
export interface LanguageWorkerResultSettler {
	settleResult(requestId: number, disposition: LanguageWorkerResultDisposition): void;
}

/** The only callback allowed to publish a worker value to editor-owned state. */
export type LanguageResultApplier<TResult> = (result: VersionedLanguageResult<TResult>) => void;

/** A worker value carrying the exact request and model versions that produced it. */
export interface VersionedLanguageResult<TResult> {
	readonly requestId: number;
	readonly textModel: TextModel;
	readonly modelVersion: number;
	readonly value: TResult;
}

export enum LanguageRequestStatus {
	Applied = "applied",
	Cancelled = "cancelled",
}

export enum LanguageRequestCancellationReason {
	Caller = "caller",
	Superseded = "superseded",
	ModelChanged = "modelChanged",
	ModelUnavailable = "modelUnavailable",
	WorkerRestarted = "workerRestarted",
	CoordinatorDisposed = "coordinatorDisposed",
}

export interface LanguageRequestApplied {
	readonly status: LanguageRequestStatus.Applied;
	readonly requestId: number;
	readonly modelVersion: number;
}

export interface LanguageRequestCancelled {
	readonly status: LanguageRequestStatus.Cancelled;
	readonly requestId: number;
	readonly modelVersion: number;
	readonly reason: LanguageRequestCancellationReason;
	readonly cause?: unknown;
}

export type LanguageRequestOutcome = LanguageRequestApplied | LanguageRequestCancelled;

export interface LanguageRequestOptions {
	readonly signal?: AbortSignal;
}

interface RequestCancellation {
	readonly reason: LanguageRequestCancellationReason;
	readonly cause?: unknown;
}

interface ActiveLanguageRequest<TLane extends string> {
	readonly requestId: number;
	readonly lane: TLane;
	readonly modelVersion: number;
	readonly controller: AbortController;
	cancellation?: RequestCancellation;
}

/**
 * Owns one reusable language worker and applies only current-version results.
 *
 * Requests in the same lane are latest-wins. Different lanes may run
 * concurrently. The coordinator owns its worker, but not the text model.
 */
export class LanguageRequestCoordinator<TLane extends string, TPayload, TResult> extends Disposable {
	private readonly workerSlot = this._register(new MutableDisposable<LanguageWorker<TLane, TPayload, TResult>>());
	private readonly activeRequests = new Map<TLane, ActiveLanguageRequest<TLane>>();
	private nextRequestId = 1;

	constructor(
		private readonly model: TextModel,
		private readonly createWorker: () => LanguageWorker<TLane, TPayload, TResult>,
	) {
		super();
		if (typeof createWorker !== "function") {
			this.dispose();
			throw new TypeError("Language worker factory must be a function");
		}
		this._register(model.onDidChangeContent(change => {
			this.cancelAll(LanguageRequestCancellationReason.ModelChanged);
			this.synchronizeWorker(change);
		}));
		this._register(model.onWillDispose(() => {
			this.cancelAll(LanguageRequestCancellationReason.ModelUnavailable);
			this.workerSlot.clear();
		}));
		this._register(toDisposable(() => {
			this.cancelAll(LanguageRequestCancellationReason.CoordinatorDisposed);
		}));
	}

	startWorker(): void {
		this.assertNotDisposed();
		this.getWorker();
	}

	restartWorker(): void {
		this.assertNotDisposed();
		if (!this.workerSlot.value) return;
		this.cancelAll(LanguageRequestCancellationReason.WorkerRestarted);
		this.workerSlot.clear();
	}

	async runLatest(lane: TLane, payload: TPayload, apply: LanguageResultApplier<TResult>, options: LanguageRequestOptions = {}): Promise<LanguageRequestOutcome> {
		this.assertNotDisposed();
		assertLane(lane);
		if (typeof apply !== "function") {
			throw new TypeError("Language result applier must be a function");
		}
		this.cancelLane(lane, LanguageRequestCancellationReason.Superseded);

		const requestId = this.nextRequestId++;
		const snapshot = this.model.createVersionedSnapshot();
		if (options.signal?.aborted) {
			return cancelledOutcome(requestId, snapshot.version, {
				reason: LanguageRequestCancellationReason.Caller,
				cause: options.signal.reason,
			});
		}

		const worker = this.getWorker();
		const versionAfterWorkerCreation = this.readModelVersion();
		if (this.isDisposed) {
			return cancelledOutcome(requestId, snapshot.version, {
				reason: LanguageRequestCancellationReason.CoordinatorDisposed,
			});
		}
		if (versionAfterWorkerCreation === undefined) {
			return cancelledOutcome(requestId, snapshot.version, {
				reason: LanguageRequestCancellationReason.ModelUnavailable,
			});
		}
		if (versionAfterWorkerCreation !== snapshot.version) {
			return cancelledOutcome(requestId, snapshot.version, {
				reason: LanguageRequestCancellationReason.ModelChanged,
			});
		}

		const active: ActiveLanguageRequest<TLane> = {
			requestId,
			lane,
			modelVersion: snapshot.version,
			controller: new AbortController(),
		};
		this.activeRequests.set(lane, active);
		const cancelFromCaller = (): void => {
			this.cancelRequest(active, LanguageRequestCancellationReason.Caller, options.signal?.reason);
		};
		options.signal?.addEventListener("abort", cancelFromCaller, { once: true });
		if (options.signal?.aborted) cancelFromCaller();
		const request = Object.freeze<LanguageWorkerRequest<TLane, TPayload>>({
			requestId,
			lane,
			snapshot,
			payload,
		});

		try {
			let value: TResult;
			let computation: Promise<TResult> | undefined;
			try {
				computation = worker.run(request, active.controller.signal);
				value = await raceCancellationError(computation, active.controller.signal);
			} catch (error) {
				if (active.cancellation) {
					void computation?.then(() => settleWorkerResult(worker, requestId, LanguageWorkerResultDisposition.Discarded), () => undefined).catch(onUnexpectedError);
					return cancelledOutcome(requestId, snapshot.version, active.cancellation);
				}
				const disposalError = this.invalidateWorker(worker, active);
				if (disposalError !== undefined) {
					throw new AggregateError(
						[error, disposalError],
						"Language worker request and disposal both failed",
					);
				}
				throw error;
			}
			if (active.cancellation) {
				settleWorkerResult(worker, requestId, LanguageWorkerResultDisposition.Discarded);
				return cancelledOutcome(requestId, snapshot.version, active.cancellation);
			}
			if (this.activeRequests.get(lane) !== active) {
				settleWorkerResult(worker, requestId, LanguageWorkerResultDisposition.Discarded);
				return cancelledOutcome(requestId, snapshot.version, {
					reason: LanguageRequestCancellationReason.Superseded,
				});
			}
			const currentVersion = this.readModelVersion();
			if (currentVersion === undefined) {
				this.cancelRequest(active, LanguageRequestCancellationReason.ModelUnavailable);
				settleWorkerResult(worker, requestId, LanguageWorkerResultDisposition.Discarded);
				return cancelledOutcome(requestId, snapshot.version, active.cancellation!);
			}
			if (currentVersion !== snapshot.version) {
				this.cancelRequest(active, LanguageRequestCancellationReason.ModelChanged);
				settleWorkerResult(worker, requestId, LanguageWorkerResultDisposition.Discarded);
				return cancelledOutcome(requestId, snapshot.version, active.cancellation!);
			}

			this.activeRequests.delete(lane);
			try {
				apply(Object.freeze({
					requestId,
					textModel: this.model,
					modelVersion: snapshot.version,
					value,
				}));
			} catch (error) {
				settleWorkerResult(worker, requestId, LanguageWorkerResultDisposition.Discarded);
				throw error;
			}
			settleWorkerResult(worker, requestId, LanguageWorkerResultDisposition.Applied);
			return Object.freeze({
				status: LanguageRequestStatus.Applied,
				requestId,
				modelVersion: snapshot.version,
			});
		} finally {
			options.signal?.removeEventListener("abort", cancelFromCaller);
			if (this.activeRequests.get(lane) === active) {
				this.activeRequests.delete(lane);
			}
		}
	}

	private getWorker(): LanguageWorker<TLane, TPayload, TResult> {
		if (this.model.isDisposed()) {
			throw new ReferenceError("Language worker model is disposed");
		}
		const current = this.workerSlot.value;
		if (current) return current;
		const worker = this.createWorker();
		if (
			!worker ||
			typeof worker.run !== "function" ||
			typeof worker.dispose !== "function" ||
			typeof worker[Symbol.dispose] !== "function"
		) {
			throw new TypeError("Language worker factory returned an invalid worker");
		}
		this.workerSlot.value = worker;
		if (this.model.isDisposed()) {
			this.workerSlot.clear();
		}
		return worker;
	}

	private invalidateWorker(worker: LanguageWorker<TLane, TPayload, TResult>, failedRequest: ActiveLanguageRequest<TLane>): unknown | undefined {
		if (this.workerSlot.value !== worker) return undefined;
		for (const active of this.activeRequests.values()) {
			if (active !== failedRequest) {
				this.cancelRequest(active, LanguageRequestCancellationReason.WorkerRestarted);
			}
		}
		try {
			this.workerSlot.clear();
			return undefined;
		} catch (error) {
			return error;
		}
	}

	private cancelLane(lane: TLane, reason: LanguageRequestCancellationReason): void {
		const active = this.activeRequests.get(lane);
		if (active) this.cancelRequest(active, reason);
	}

	private cancelAll(reason: LanguageRequestCancellationReason): void {
		for (const active of this.activeRequests.values()) {
			this.cancelRequest(active, reason);
		}
	}

	private cancelRequest(active: ActiveLanguageRequest<TLane>, reason: LanguageRequestCancellationReason, cause?: unknown): void {
		if (active.cancellation) return;
		active.cancellation = cause === undefined ? { reason } : { reason, cause };
		active.controller.abort(cause ?? reason);
	}

	private readModelVersion(): number | undefined {
		try {
			return this.model.version;
		} catch (error) {
			if (error instanceof ReferenceError) return undefined;
			throw error;
		}
	}

	private synchronizeWorker(change: TextModelChange): void {
		const worker = this.workerSlot.value;
		if (!worker || !supportsModelSynchronization(worker)) return;
		try {
			worker.synchronizeModel(change);
		} catch {
			if (this.workerSlot.value === worker) this.workerSlot.clear();
		}
	}

}

function supportsModelSynchronization(value: IDisposable): value is IDisposable & LanguageWorkerModelSynchronizer {
	return typeof (value as Partial<LanguageWorkerModelSynchronizer>).synchronizeModel === "function";
}

function settleWorkerResult(value: IDisposable, requestId: number, disposition: LanguageWorkerResultDisposition): void {
	const settler = value as Partial<LanguageWorkerResultSettler>;
	if (typeof settler.settleResult === "function") settler.settleResult(requestId, disposition);
}

function cancelledOutcome(requestId: number, modelVersion: number, cancellation: RequestCancellation): LanguageRequestCancelled {
	return Object.freeze(cancellation.cause === undefined ? {
		status: LanguageRequestStatus.Cancelled,
		requestId,
		modelVersion,
		reason: cancellation.reason,
	} : {
		status: LanguageRequestStatus.Cancelled,
		requestId,
		modelVersion,
		reason: cancellation.reason,
		cause: cancellation.cause,
	});
}

function assertLane(lane: string): void {
	if (typeof lane !== "string" || lane.length === 0) {
		throw new TypeError("Language request lane must be a non-empty string");
	}
}
