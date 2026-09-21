import { type TextSnapshot, type TextModelChange } from '../core/textChange.js';
import { type Event, Emitter } from '../../../base/common/event.js';
import { type IDisposable, Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { LanguageWorkerResultDisposition, type LanguageWorker, type LanguageWorkerModelSynchronizer, type LanguageWorkerRequest, type LanguageWorkerResultSettler } from '../model/languageRequestCoordinator.js';
import { LanguageWorkerDocumentMirror } from './textModelSync/textModelSync.impl.js';
import { isNonEmptyArray } from '../../../base/common/arrays.js';
import { type LanguageWorkerDocumentSynchronizationObserver, type LanguageWorkerDocumentChange } from './textModelSync/textModelSync.protocol.js';
import { isPositiveSafeInteger, isNonNegativeSafeInteger } from '../../../base/common/numbers.js';
import { CharCode } from '../../../base/common/charCode.js';

const LANGUAGE_WORKER_PROTOCOL = "ash.language-worker";

const LANGUAGE_WORKER_PROTOCOL_VERSION = 5;

export interface LanguageWorkerWireResultState<TResult> {
	readonly requestId: number;
	readonly snapshot: TextSnapshot;
	readonly result: TResult;
}

type LanguageWorkerWireResultProtocol = "stateless" | "confirmedBase";

export interface LanguageWorkerWireCodec<TLane extends string, TPayload, TResult> {
	readonly lanes: readonly TLane[];
	readonly resultProtocol: LanguageWorkerWireResultProtocol;
	encodePayload(lane: TLane, payload: TPayload): unknown;
	decodePayload(lane: TLane, value: unknown, snapshot: TextSnapshot): TPayload;
	encodeResult(lane: TLane, result: TResult, snapshot: TextSnapshot, base: LanguageWorkerWireResultState<TResult> | undefined): unknown;
	decodeResult(lane: TLane, value: unknown, snapshot: TextSnapshot, base: LanguageWorkerWireResultState<TResult> | undefined): TResult;
}

interface EncodedRequestWireMessage {
	readonly message: RequestWireMessage;
	readonly establishesMirrorVersion: number | undefined;
}

interface DecodedRequestSnapshot {
	readonly snapshot: TextSnapshot;
	readonly replacesMirror: boolean;
}

interface RequestWireMessage {
	readonly protocol: typeof LANGUAGE_WORKER_PROTOCOL;
	readonly version: typeof LANGUAGE_WORKER_PROTOCOL_VERSION;
	readonly kind: "request";
	readonly requestId: number;
	readonly lane: string;
	readonly resultBaseRequestId?: number;
	readonly snapshot: FullSnapshotWireDto | ReferencedSnapshotWireDto;
	readonly payload: unknown;
}

interface CancelWireMessage {
	readonly protocol: typeof LANGUAGE_WORKER_PROTOCOL;
	readonly version: typeof LANGUAGE_WORKER_PROTOCOL_VERSION;
	readonly kind: "cancel";
	readonly requestId: number;
}

interface SyncWireMessage {
	readonly protocol: typeof LANGUAGE_WORKER_PROTOCOL;
	readonly version: typeof LANGUAGE_WORKER_PROTOCOL_VERSION;
	readonly kind: "sync";
	readonly previousVersion: number;
	readonly modelVersion: number;
	readonly eol: '\n' | '\r\n';
	readonly changes: readonly ContentChangeWireDto[];
}

interface ResultWireMessage {
	readonly protocol: typeof LANGUAGE_WORKER_PROTOCOL;
	readonly version: typeof LANGUAGE_WORKER_PROTOCOL_VERSION;
	readonly kind: "result";
	readonly requestId: number;
	readonly result: unknown;
}

interface FailureWireMessage {
	readonly protocol: typeof LANGUAGE_WORKER_PROTOCOL;
	readonly version: typeof LANGUAGE_WORKER_PROTOCOL_VERSION;
	readonly kind: "failure";
	readonly requestId: number;
	readonly error: ErrorWireDto;
}

interface SyncFailureWireMessage {
	readonly protocol: typeof LANGUAGE_WORKER_PROTOCOL;
	readonly version: typeof LANGUAGE_WORKER_PROTOCOL_VERSION;
	readonly kind: "syncFailure";
	readonly error: ErrorWireDto;
}

interface FullSnapshotWireDto {
	readonly kind: "full";
	readonly version: number;
	readonly length: number;
	readonly lineCount: number;
	readonly text: string;
}

interface ReferencedSnapshotWireDto {
	readonly kind: "reference";
	readonly version: number;
	readonly length: number;
	readonly lineCount: number;
}

interface ContentChangeWireDto {
	readonly rangeOffset: number;
	readonly rangeLength: number;
	readonly text: string;
}

interface ErrorWireDto {
	readonly name: string;
	readonly message: string;
}

export interface LanguageWorkerWirePort extends IDisposable {
	readonly onMessage: Event<unknown>;
	send(message: unknown): void;
}

export interface LanguageWorkerWireClientPort extends LanguageWorkerWirePort {
	readonly onFailure: Event<unknown>;
}

/** Error reconstructed from a remote worker failure DTO. */
export class LanguageWorkerRemoteError extends Error {
	constructor(readonly remoteName: string, message: string) {
		super(message);
		this.name = "LanguageWorkerRemoteError";
	}
}

/** Coordinator-compatible client for one typed worker lane and model mirror. */
export class LanguageWorkerWireClient<TLane extends string, TPayload, TResult> extends Disposable implements LanguageWorker<TLane, TPayload, TResult>, LanguageWorkerModelSynchronizer, LanguageWorkerResultSettler {
	private readonly failureEmitter = this._register(new Emitter<Error>());
	private readonly pending = new Map<number, PendingWireRequest<TLane, TPayload, TResult>>();
	private readonly resultStates = new Map<TLane, LanguageWorkerWireResultState<TResult>>();
	private readonly stagedResultStates = new Map<number, StagedWireResultState<TLane, TResult>>();
	private mirroredVersion: number | undefined;
	private terminalFailure: Error | undefined;

	readonly onDidFail: Event<Error> = this.failureEmitter.event;

	constructor(
		private readonly port: LanguageWorkerWireClientPort,
		private readonly codec: LanguageWorkerWireCodec<TLane, TPayload, TResult>,
	) {
		super();
		assertPort(port, true);
		assertCodec(codec);
		this._register(port);
		this._register(port.onMessage(message => this.receive(message)));
		this._register(port.onFailure(error => this.fail(asError(error, "Language worker transport failed"))));
		this._register(toDisposable(() => {
			this.mirroredVersion = undefined;
			this.resultStates.clear();
			this.stagedResultStates.clear();
			this.failAll(new ReferenceError("LanguageWorkerWireClient is already disposed"));
		}));
	}

	run(request: LanguageWorkerRequest<TLane, TPayload>, signal: AbortSignal): Promise<TResult> {
		this.ensureAvailable();
		assertRequestId(request.requestId);
		if (!this.codec.lanes.includes(request.lane)) {
			throw new RangeError(`Language worker wire lane '${request.lane}' is unsupported`);
		}
		if (this.pending.has(request.requestId)) {
			throw new RangeError(`Language worker wire request '${request.requestId}' is already pending`);
		}
		signal.throwIfAborted();
		const resultBase = this.codec.resultProtocol === "confirmedBase" ? this.resultStates.get(request.lane) : undefined;
		const encoded = encodeRequestMessage(request, this.codec, this.mirroredVersion, resultBase?.requestId);
		return new Promise<TResult>((resolve, reject) => {
			const abort = (): void => {
				const pending = this.pending.get(request.requestId);
				if (!pending) return;
				this.pending.delete(request.requestId);
				pending.removeAbort();
				try {
					this.port.send(createCancelMessage(request.requestId));
				} catch {
					// The local cancellation outcome remains authoritative.
				}
				reject(abortError(signal.reason));
			};
			signal.addEventListener("abort", abort, { once: true });
			const pending: PendingWireRequest<TLane, TPayload, TResult> = {
				request,
				resultBase,
				resolve,
				reject,
				removeAbort: () => signal.removeEventListener("abort", abort),
			};
			this.pending.set(request.requestId, pending);
			try {
				this.port.send(encoded.message);
				if (encoded.establishesMirrorVersion !== undefined) {
					this.mirroredVersion = encoded.establishesMirrorVersion;
				}
			} catch (error) {
				this.pending.delete(request.requestId);
				pending.removeAbort();
				this.mirroredVersion = undefined;
				reject(error);
			}
		});
	}

	synchronizeModel(change: TextModelChange): void {
		this.ensureAvailable();
		if (this.mirroredVersion === undefined) return;
		if (change.version !== this.mirroredVersion + 1) {
			this.mirroredVersion = undefined;
			return;
		}
		const message = encodeSyncMessage(change);
		try {
			this.port.send(message);
			this.mirroredVersion = change.version;
		} catch {
			this.mirroredVersion = undefined;
		}
	}

	invalidate(error: unknown): void {
		this.ensureAvailable();
		this.fail(asError(error, "Language worker client was invalidated"));
	}

	settleResult(requestId: number, disposition: LanguageWorkerResultDisposition): void {
		const staged = this.stagedResultStates.get(requestId);
		if (!staged) return;
		this.stagedResultStates.delete(requestId);
		if (disposition !== LanguageWorkerResultDisposition.Applied) return;
		const current = this.resultStates.get(staged.lane);
		if (!current || requestId > current.requestId) {
			this.resultStates.set(staged.lane, staged.state);
		}
	}

	private receive(value: unknown): void {
		if (!isProtocolMessage(value)) return;
		let message: ResultWireMessage | FailureWireMessage | SyncFailureWireMessage;
		try {
			message = decodeClientMessage(value);
		} catch (error) {
			this.fail(asError(error, "Invalid language worker response"));
			return;
		}
		if (message.kind === "syncFailure") {
			this.fail(new LanguageWorkerRemoteError(message.error.name, message.error.message));
			return;
		}
		const pending = this.pending.get(message.requestId);
		if (!pending) return;
		this.pending.delete(message.requestId);
		pending.removeAbort();
		if (message.kind === "failure") {
			pending.reject(new LanguageWorkerRemoteError(message.error.name, message.error.message));
			return;
		}
		try {
			const result = this.codec.decodeResult(pending.request.lane, message.result, pending.request.snapshot, pending.resultBase);
			if (this.codec.resultProtocol === "confirmedBase") {
				this.stagedResultStates.set(message.requestId, Object.freeze({
					lane: pending.request.lane,
					state: Object.freeze({
						requestId: message.requestId,
						snapshot: pending.request.snapshot,
						result,
					}),
				}));
			}
			pending.resolve(result);
		} catch (error) {
			pending.reject(error);
		}
	}

	private failAll(error: Error): void {
		const pending = [...this.pending.values()];
		this.pending.clear();
		for (const request of pending) {
			request.removeAbort();
			request.reject(error);
		}
	}

	private fail(error: Error): void {
		const firstFailure = this.terminalFailure === undefined;
		if (firstFailure) this.terminalFailure = error;
		const terminalFailure = this.terminalFailure!;
		this.mirroredVersion = undefined;
		this.resultStates.clear();
		this.stagedResultStates.clear();
		this.failAll(terminalFailure);
		if (firstFailure) this.failureEmitter.fire(terminalFailure);
	}

	private ensureAvailable(): void {
		if (this.isDisposed) {
			throw new ReferenceError("LanguageWorkerWireClient is already disposed");
		}
		if (this.terminalFailure) throw this.terminalFailure;
	}
}

/** Worker-side dispatcher for one typed language lane and immutable mirror. */
export class LanguageWorkerWireServer<TLane extends string, TPayload, TResult> extends Disposable {
	private readonly active = new Map<number, AbortController>();
	private readonly resultStates = new Map<TLane, LanguageWorkerWireResultState<TResult>>();
	private mirror: LanguageWorkerDocumentMirror | undefined;

	constructor(
		private readonly port: LanguageWorkerWirePort,
		private readonly codec: LanguageWorkerWireCodec<TLane, TPayload, TResult>,
		private readonly worker: LanguageWorker<TLane, TPayload, TResult>,
	) {
		super();
		assertPort(port, false);
		assertCodec(codec);
		assertWorker(worker);
		this._register(port);
		this._register(worker);
		this._register(port.onMessage(message => this.receive(message)));
		this._register(toDisposable(() => {
			this.mirror?.dispose();
			this.mirror = undefined;
			this.resultStates.clear();
			for (const controller of this.active.values()) {
				controller.abort("serverDisposed");
			}
			this.active.clear();
		}));
	}

	private receive(value: unknown): void {
		if (!isProtocolMessage(value)) return;
		let message: ReturnType<typeof decodeServerMessage>;
		try {
			message = decodeServerMessage(value);
		} catch (error) {
			const requestId = readRequestId(value);
			if (requestId !== undefined) this.sendFailure(requestId, error);
			return;
		}
		if (message.kind === "cancel") {
			this.active.get(message.requestId)?.abort("clientCancelled");
			return;
		}
		if (message.kind === "sync") {
			try {
				if (!this.mirror) {
					throw new Error("Language worker sync requires an initialized document mirror");
				}
				const changes = normalizeDocumentChanges(message.changes);
				this.mirror.synchronize(message.previousVersion, message.modelVersion, changes, message.eol);
				if (supportsDocumentSynchronization(this.worker)) {
					this.worker.synchronizeDocument(Object.freeze({
						previousVersion: message.previousVersion,
						modelVersion: message.modelVersion,
						eol: message.eol,
						changes,
						snapshot: this.mirror.createSnapshot(),
					}));
				}
			} catch (error) {
				this.mirror?.dispose();
				this.mirror = undefined;
				this.port.send(createSyncFailureMessage(error));
			}
			return;
		}
		void this.runRequest(message);
	}

	private async runRequest(message: RequestWireMessage): Promise<void> {
		if (this.isDisposed) return;
		if (this.active.has(message.requestId)) {
			this.sendFailure(message.requestId, new RangeError(`Duplicate language worker request '${message.requestId}'`));
			return;
		}
		let request: LanguageWorkerRequest<TLane, TPayload>;
		try {
			if (!this.codec.lanes.includes(message.lane as TLane)) {
				throw new RangeError(`Unsupported language worker lane '${message.lane}'`);
			}
			const decoded = decodeRequestSnapshot(message.snapshot, this.mirror?.createSnapshot());
			if (decoded.replacesMirror) {
				this.mirror?.dispose();
				this.mirror = new LanguageWorkerDocumentMirror(decoded.snapshot);
			}
			request = Object.freeze({
				requestId: message.requestId,
				lane: message.lane as TLane,
				snapshot: decoded.snapshot,
				payload: this.codec.decodePayload(message.lane as TLane, message.payload, decoded.snapshot),
			});
		} catch (error) {
			this.sendFailure(message.requestId, error);
			return;
		}

		const controller = new AbortController();
		this.active.set(message.requestId, controller);
		const currentBase = this.codec.resultProtocol === "confirmedBase" ? this.resultStates.get(request.lane) : undefined;
		const resultBase = currentBase?.requestId === message.resultBaseRequestId ? currentBase : undefined;
		try {
			const result = await this.worker.run(request, controller.signal);
			if (!this.isDisposed && !controller.signal.aborted) {
				const encoded = this.codec.encodeResult(request.lane, result, request.snapshot, resultBase);
				this.port.send(createResultMessage(message.requestId, encoded));
				const current = this.resultStates.get(request.lane);
				if (this.codec.resultProtocol === "confirmedBase" && (!current || message.requestId > current.requestId)) {
					this.resultStates.set(request.lane, Object.freeze({
						requestId: message.requestId,
						snapshot: request.snapshot,
						result,
					}));
				}
			}
		} catch (error) {
			if (!this.isDisposed && !controller.signal.aborted) {
				this.sendFailure(message.requestId, error);
			}
		} finally {
			if (this.active.get(message.requestId) === controller) {
				this.active.delete(message.requestId);
			}
		}
	}

	private sendFailure(requestId: number, error: unknown): void {
		if (this.isDisposed) return;
		this.port.send(createFailureMessage(requestId, error));
	}
}

interface PendingWireRequest<TLane extends string, TPayload, TResult> {
	readonly request: LanguageWorkerRequest<TLane, TPayload>;
	readonly resultBase: LanguageWorkerWireResultState<TResult> | undefined;
	readonly resolve: (value: TResult) => void;
	readonly reject: (reason: unknown) => void;
	readonly removeAbort: () => void;
}

interface StagedWireResultState<TLane extends string, TResult> {
	readonly lane: TLane;
	readonly state: LanguageWorkerWireResultState<TResult>;
}

function assertPort(value: LanguageWorkerWirePort, requireFailure: boolean): void {
	if (!value || typeof value.send !== "function" || typeof value.onMessage !== "function" || typeof value.dispose !== "function" || (requireFailure && typeof (value as LanguageWorkerWireClientPort).onFailure !== "function")) {
		throw new TypeError("Language worker wire port is invalid");
	}
}

function assertCodec<TLane extends string, TPayload, TResult>(value: LanguageWorkerWireCodec<TLane, TPayload, TResult>): void {
	if (!value || !isNonEmptyArray(value.lanes) || value.lanes.some(lane => typeof lane !== "string" || lane.length === 0) || new Set(value.lanes).size !== value.lanes.length || (value.resultProtocol !== "stateless" && value.resultProtocol !== "confirmedBase") || typeof value.encodePayload !== "function" || typeof value.decodePayload !== "function" || typeof value.encodeResult !== "function" || typeof value.decodeResult !== "function") {
		throw new TypeError("Language worker wire codec is invalid");
	}
}

function assertWorker<TLane extends string, TPayload, TResult>(value: LanguageWorker<TLane, TPayload, TResult>): void {
	if (!value || typeof value.run !== "function" || typeof value.dispose !== "function" || typeof value[Symbol.dispose] !== "function") {
		throw new TypeError("Language worker wire server worker is invalid");
	}
}

function supportsDocumentSynchronization(value: IDisposable): value is IDisposable & LanguageWorkerDocumentSynchronizationObserver {
	return typeof (value as Partial<LanguageWorkerDocumentSynchronizationObserver>).synchronizeDocument === "function";
}

function normalizeDocumentChanges(changes: readonly LanguageWorkerDocumentChange[]): readonly LanguageWorkerDocumentChange[] {
	return Object.freeze(changes.map(change => Object.freeze({
		rangeOffset: change.rangeOffset,
		rangeLength: change.rangeLength,
		text: change.text,
	})));
}

function abortError(reason: unknown): Error {
	if (reason instanceof Error) return reason;
	const error = new Error(reason === undefined ? "Language worker request was cancelled" : String(reason));
	error.name = "AbortError";
	return error;
}

function asError(value: unknown, fallbackMessage: string): Error {
	return value instanceof Error ? value : new Error(value === undefined ? fallbackMessage : String(value));
}

function encodeRequestMessage<TLane extends string, TPayload, TResult>(request: LanguageWorkerRequest<TLane, TPayload>, codec: LanguageWorkerWireCodec<TLane, TPayload, TResult>, mirroredVersion: number | undefined, resultBaseRequestId: number | undefined): EncodedRequestWireMessage {
	if (resultBaseRequestId !== undefined) assertRequestId(resultBaseRequestId);
	const snapshot = mirroredVersion === request.snapshot.version
		? encodeReferencedSnapshot(request.snapshot)
		: encodeFullSnapshot(request.snapshot);
	return Object.freeze({
		message: Object.freeze<RequestWireMessage>({
			protocol: LANGUAGE_WORKER_PROTOCOL,
			version: LANGUAGE_WORKER_PROTOCOL_VERSION,
			kind: "request",
			requestId: request.requestId,
			lane: request.lane,
			...(resultBaseRequestId === undefined ? {} : { resultBaseRequestId }),
			snapshot,
			payload: codec.encodePayload(request.lane, request.payload),
		}),
		establishesMirrorVersion: snapshot.kind === "full" ? snapshot.version : undefined,
	});
}

function encodeSyncMessage(change: TextModelChange): SyncWireMessage {
	assertPositiveSafeInteger(change.version, "Language worker sync model version");
	if (change.version <= 1) {
		throw new RangeError("Language worker sync must describe one committed model version");
	}
	if (change.eol !== '\n' && change.eol !== '\r\n') throw new TypeError('Language worker sync EOL must be LF or CRLF');
	const eol = change.eol;
	return Object.freeze({
		protocol: LANGUAGE_WORKER_PROTOCOL,
		version: LANGUAGE_WORKER_PROTOCOL_VERSION,
		kind: "sync",
		previousVersion: change.version - 1,
		modelVersion: change.version,
		eol: change.eol,
		changes: Object.freeze(change.changes.map(contentChange => {
			assertNonNegativeSafeInteger(contentChange.rangeOffset, "Language worker sync range offset");
			assertNonNegativeSafeInteger(contentChange.rangeLength, "Language worker sync range length");
			if (typeof contentChange.text !== "string" || normalizeEOL(contentChange.text, eol) !== contentChange.text) {
				throw new TypeError("Language worker sync text must use the resulting document EOL");
			}
			return Object.freeze({
				rangeOffset: contentChange.rangeOffset,
				rangeLength: contentChange.rangeLength,
				text: contentChange.text,
			});
		})),
	});
}

function decodeRequestSnapshot(value: RequestWireMessage["snapshot"], mirror: TextSnapshot | undefined): DecodedRequestSnapshot {
	assertRecord(value, "Language worker snapshot");
	if (value.kind === "full") {
		return Object.freeze({
			snapshot: decodeFullSnapshot(value as FullSnapshotWireDto),
			replacesMirror: true,
		});
	}
	if (value.kind !== "reference") {
		throw new TypeError(`Unknown language worker snapshot kind '${String(value.kind)}'`);
	}
	assertSnapshotMetadata(value);
	if (!mirror) {
		throw new Error("Language worker request references an unavailable snapshot mirror");
	}
	if (mirror.version !== value.version || mirror.length !== value.length || mirror.lineCount !== value.lineCount) {
		throw new Error("Language worker request snapshot reference does not match its mirror");
	}
	return Object.freeze({ snapshot: mirror, replacesMirror: false });
}

function createCancelMessage(requestId: number): CancelWireMessage {
	return Object.freeze({ protocol: LANGUAGE_WORKER_PROTOCOL, version: LANGUAGE_WORKER_PROTOCOL_VERSION, kind: "cancel", requestId });
}

function createResultMessage(requestId: number, result: unknown): ResultWireMessage {
	return Object.freeze({ protocol: LANGUAGE_WORKER_PROTOCOL, version: LANGUAGE_WORKER_PROTOCOL_VERSION, kind: "result", requestId, result });
}

function createFailureMessage(requestId: number, error: unknown): FailureWireMessage {
	return Object.freeze({
		protocol: LANGUAGE_WORKER_PROTOCOL,
		version: LANGUAGE_WORKER_PROTOCOL_VERSION,
		kind: "failure",
		requestId,
		error: encodeError(error, "Remote language worker failed"),
	});
}

function createSyncFailureMessage(error: unknown): SyncFailureWireMessage {
	return Object.freeze({
		protocol: LANGUAGE_WORKER_PROTOCOL,
		version: LANGUAGE_WORKER_PROTOCOL_VERSION,
		kind: "syncFailure",
		error: encodeError(error, "Remote language worker synchronization failed"),
	});
}

function decodeClientMessage(value: Record<string, unknown>): ResultWireMessage | FailureWireMessage | SyncFailureWireMessage {
	assertEnvelope(value);
	if (value.kind === "syncFailure") {
		assertError(value.error);
		return value as unknown as SyncFailureWireMessage;
	}
	assertRequestId(value.requestId);
	if (value.kind === "result") return value as unknown as ResultWireMessage;
	if (value.kind === "failure") {
		assertError(value.error);
		return value as unknown as FailureWireMessage;
	}
	throw new TypeError(`Unknown language worker client message '${String(value.kind)}'`);
}

function decodeServerMessage(value: Record<string, unknown>): RequestWireMessage | CancelWireMessage | SyncWireMessage {
	assertEnvelope(value);
	if (value.kind === "sync") {
		assertPositiveSafeInteger(value.previousVersion, "Language worker sync previous version");
		assertPositiveSafeInteger(value.modelVersion, "Language worker sync model version");
		if (!Array.isArray(value.changes)) {
			throw new TypeError("Language worker sync changes must be an array");
		}
		if (value.eol !== '\n' && value.eol !== '\r\n') throw new TypeError('Language worker sync EOL must be LF or CRLF');
		return value as unknown as SyncWireMessage;
	}
	assertRequestId(value.requestId);
	if (value.kind === "cancel") return value as unknown as CancelWireMessage;
	if (value.kind === "request") {
		if (typeof value.lane !== "string" || value.lane.length === 0) {
			throw new TypeError("Language worker request lane must be a non-empty string");
		}
		if (value.resultBaseRequestId !== undefined) {
			assertRequestId(value.resultBaseRequestId);
		}
		assertRecord(value.snapshot, "Language worker snapshot");
		return value as unknown as RequestWireMessage;
	}
	throw new TypeError(`Unknown language worker server message '${String(value.kind)}'`);
}

function isProtocolMessage(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && (value as Record<string, unknown>).protocol === LANGUAGE_WORKER_PROTOCOL;
}

function readRequestId(value: Record<string, unknown>): number | undefined {
	return Number.isSafeInteger(value.requestId) && (value.requestId as number) > 0 ? value.requestId as number : undefined;
}

function assertRequestId(value: unknown): asserts value is number {
	assertPositiveSafeInteger(value, "Language worker request ID");
}

function encodeFullSnapshot(snapshot: TextSnapshot): FullSnapshotWireDto {
	const value = Object.freeze({
		kind: "full" as const,
		version: snapshot.version,
		length: snapshot.length,
		lineCount: snapshot.lineCount,
		text: snapshot.getText(),
	});
	assertFullSnapshot(value);
	return value;
}

function encodeReferencedSnapshot(snapshot: TextSnapshot): ReferencedSnapshotWireDto {
	const value = Object.freeze({
		kind: "reference" as const,
		version: snapshot.version,
		length: snapshot.length,
		lineCount: snapshot.lineCount,
	});
	assertSnapshotMetadata(value);
	return value;
}

function decodeFullSnapshot(value: FullSnapshotWireDto): TextSnapshot {
	assertFullSnapshot(value);
	return createSnapshot(value.version, value.text, value.lineCount);
}

function assertFullSnapshot(value: FullSnapshotWireDto): void {
	assertSnapshotMetadata(value);
	if (typeof value.text !== "string" || !hasConsistentEOL(value.text)) {
		throw new TypeError("Language worker snapshot text must use one consistent EOL sequence");
	}
	if (value.length !== value.text.length) {
		throw new RangeError("Language worker snapshot length does not match its text");
	}
	if (value.lineCount !== countLines(value.text)) {
		throw new RangeError("Language worker snapshot line count does not match its text");
	}
}

function createSnapshot(version: number, text: string, lineCount = countLines(text)): TextSnapshot {
	return Object.freeze({
		version,
		length: text.length,
		lineCount,
		getText: () => text,
		getTextBetweenOffsets: (startOffset: number, endOffset: number) => {
			assertNonNegativeSafeInteger(startOffset, "Snapshot start offset");
			assertNonNegativeSafeInteger(endOffset, "Snapshot end offset");
			if (startOffset > endOffset || endOffset > text.length) {
				throw new RangeError("Snapshot offset range is outside its text");
			}
			return text.slice(startOffset, endOffset);
		},
	});
}

function assertSnapshotMetadata(value: { readonly version: unknown; readonly length: unknown; readonly lineCount: unknown }): void {
	assertPositiveSafeInteger(value.version, "Language worker snapshot version");
	assertNonNegativeSafeInteger(value.length, "Language worker snapshot length");
	assertPositiveSafeInteger(value.lineCount, "Language worker snapshot line count");
}

function assertEnvelope(value: Record<string, unknown>): void {
	if (value.version !== LANGUAGE_WORKER_PROTOCOL_VERSION) {
		throw new RangeError(`Unsupported language worker protocol version '${String(value.version)}'`);
	}
}

function assertError(value: unknown): asserts value is ErrorWireDto {
	assertRecord(value, "Language worker failure");
	if (typeof value.name !== "string" || typeof value.message !== "string") {
		throw new TypeError("Language worker failure must contain string name and message");
	}
}

function encodeError(value: unknown, fallbackMessage: string): ErrorWireDto {
	const error = value instanceof Error ? value : new Error(value === undefined ? fallbackMessage : String(value));
	return Object.freeze({ name: error.name, message: error.message });
}

function assertPositiveSafeInteger(value: unknown, owner: string): asserts value is number {
	if (!isPositiveSafeInteger(value)) {
		throw new RangeError(`${owner} must be a positive safe integer`);
	}
}

function assertNonNegativeSafeInteger(value: unknown, owner: string): asserts value is number {
	if (!isNonNegativeSafeInteger(value)) {
		throw new RangeError(`${owner} must be a non-negative safe integer`);
	}
}

function assertRecord(value: unknown, owner: string): asserts value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`${owner} must be an object`);
	}
}

function countLines(text: string): number {
	let result = 1;
	for (let index = 0; index < text.length; index += 1) {
		if (text.charCodeAt(index) === CharCode.LineFeed) result += 1;
	}
	return result;
}

function normalizeEOL(text: string, eol: '\n' | '\r\n'): string {
	return text.replace(/\r\n|\r|\n/g, eol);
}

function hasConsistentEOL(text: string): boolean {
	const withoutCRLF = text.replace(/\r\n/g, '');
	if (withoutCRLF.includes('\r')) return false;
	return !text.includes('\r\n') || !withoutCRLF.includes('\n');
}
