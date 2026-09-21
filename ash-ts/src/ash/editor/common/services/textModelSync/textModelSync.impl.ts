import { CharCode } from '../../../../base/common/charCode.js';
import { MutableDisposable, toDisposable, Disposable } from '../../../../base/common/lifecycle.js';
import { isNonNegativeSafeInteger, isPositiveSafeInteger } from '../../../../base/common/numbers.js';
import { type TextModelChange, type TextSnapshot } from '../../core/textChange.js';
import { ValidAnnotatedEditOperation, type ITextBuffer } from '../../model.js';
import { type WorkerTextModelCodec, type WorkerTextModelResultStore, type LanguageWorkerDocumentSynchronizationObserver, type LanguageWorkerDocumentChange } from './textModelSync.protocol.js';
import { WebWorkerClient, WebWorkerServer, type WebWorkerPort, type WebWorkerClientPort } from '../../../../base/common/worker/webWorker.js';
import { LanguageWorkerResultDisposition, type LanguageWorker, type LanguageWorkerRequest, type LanguageWorkerModelSynchronizer, type LanguageWorkerResultSettler } from '../../model/languageRequestCoordinator.js';
import { createPieceTreeTextBuffer } from '../../model/pieceTreeTextBuffer/pieceTreeTextBufferBuilder.js';

const modelChannel = Object.freeze({ protocol: 'ash.text-model', version: 1 });

/** Single-document Piece Tree mirror owned by one language-worker server. */
export class LanguageWorkerDocumentMirror extends Disposable {
	private readonly buffer: ITextBuffer;
	private versionValue: number;

	constructor(snapshot: TextSnapshot) {
		super();
		assertPositiveSafeInteger(snapshot.version, 'Language worker mirror version');
		const text = snapshot.getText();
		if (text.length !== snapshot.length || countLines(text) !== snapshot.lineCount) {
			throw new Error('Language worker mirror snapshot metadata is inconsistent');
		}
		this.versionValue = snapshot.version;
		this.buffer = this._register(createPieceTreeTextBuffer(text));
	}

	public get version(): number {
		return this.versionValue;
	}

	public get length(): number {
		return this.buffer.getLength();
	}

	public get lineCount(): number {
		return this.buffer.getLineCount();
	}

	public createSnapshot(): TextSnapshot {
		const version = this.versionValue;
		const snapshot = this.buffer.createSnapshot();
		return Object.freeze({
			version,
			length: snapshot.length,
			lineCount: snapshot.lineCount,
			getText: () => snapshot.getText(),
			getTextBetweenOffsets: (startOffset: number, endOffset: number) => snapshot.getTextBetweenOffsets(startOffset, endOffset),
		});
	}

	public synchronize(previousVersion: number, modelVersion: number, changes: readonly LanguageWorkerDocumentChange[], eol: '\n' | '\r\n' = this.buffer.getEOL()): void {
		if (previousVersion !== this.versionValue || modelVersion !== this.versionValue + 1) {
			throw new Error('Language worker sync version does not follow its document mirror');
		}
		if (eol !== '\n' && eol !== '\r\n') throw new TypeError('Language worker sync EOL must be LF or CRLF');
		let previousStart = -1;
		let previousEnd = 0;
		for (const change of changes) {
			assertNonNegativeSafeInteger(change.rangeOffset, 'Language worker sync range offset');
			assertNonNegativeSafeInteger(change.rangeLength, 'Language worker sync range length');
			if (typeof change.text !== 'string' || normalizeEOL(change.text, eol) !== change.text) {
				throw new TypeError('Language worker sync text must use the resulting document EOL');
			}
			const end = change.rangeOffset + change.rangeLength;
			const ambiguousSharedStart = change.rangeOffset === previousStart && (change.rangeLength === 0 || previousEnd === previousStart);
			if (change.rangeOffset < previousEnd || ambiguousSharedStart || end > this.buffer.getLength()) {
				throw new RangeError('Language worker sync ranges must be ordered, non-overlapping, and inside the mirror');
			}
			previousStart = change.rangeOffset;
			previousEnd = end;
		}
		this.buffer.applyEdits(changes.map(change => new ValidAnnotatedEditOperation(
			null,
			this.buffer.getRangeAt(change.rangeOffset, change.rangeLength),
			change.text,
			false,
			false,
			false,
		)), false, false);
		this.buffer.setEOL(eol);
		this.versionValue = modelVersion;
	}
}

/** Encodes model requests and keeps the remote mirror at the requested version. */
export class WorkerTextModelSyncClient<TLane extends string, TPayload, TResult> extends Disposable implements LanguageWorker<TLane, TPayload, TResult>, LanguageWorkerModelSynchronizer, LanguageWorkerResultSettler {
	private readonly transport: WebWorkerClient;
	private readonly results: WorkerTextModelResultStore<TLane, TResult> | undefined;
	private mirroredVersion: number | undefined;
	public readonly onDidFail;

	constructor(port: WebWorkerClientPort, private readonly codec: WorkerTextModelCodec<TLane, TPayload, TResult>) {
		super();
		this.transport = this._register(new WebWorkerClient(port, modelChannel));
		this.results = codec.createResultStore?.();
		this.onDidFail = this.transport.onDidFail;
		const clear = (): void => {
			this.mirroredVersion = undefined;
			this.results?.clear();
		};
		this._register(this.transport.onDidFail(clear));
		this._register(toDisposable(clear));
	}

	public run(request: LanguageWorkerRequest<TLane, TPayload>, signal: AbortSignal): Promise<TResult> {
		this.transport.ensureAvailable();
		if (!this.codec.lanes.includes(request.lane)) {
			throw new RangeError(`Unsupported worker lane '${request.lane}'`);
		}
		signal.throwIfAborted();
		const base = this.results?.get(request.lane);
		const encoded = encodeRequestMessage(request, this.codec, this.mirroredVersion, base?.requestId);
		const pending = this.transport.request(request.requestId, encoded.message, signal);
		if (encoded.establishesMirrorVersion !== undefined) {
			this.mirroredVersion = encoded.establishesMirrorVersion;
		}
		return pending.then(value => {
			this.transport.ensureAvailable();
			signal.throwIfAborted();
			const result = this.codec.decodeResult(request.lane, value, request.snapshot, base);
			this.results?.stage(request.lane, Object.freeze({ requestId: request.requestId, snapshot: request.snapshot, result }));
			return result;
		}, error => {
			this.mirroredVersion = undefined;
			throw error;
		});
	}

	public synchronizeModel(change: TextModelChange): void {
		this.transport.ensureAvailable();
		if (this.mirroredVersion === undefined) {
			return;
		}
		if (change.version !== this.mirroredVersion + 1) {
			this.mirroredVersion = undefined;
			return;
		}
		const message = encodeSyncMessage(change);
		try {
			this.transport.send('sync', message);
			this.mirroredVersion = change.version;
		} catch {
			this.mirroredVersion = undefined;
		}
	}

	public settleResult(requestId: number, disposition: LanguageWorkerResultDisposition): void {
		this.results?.settle(requestId, disposition === LanguageWorkerResultDisposition.Applied);
	}

	public invalidate(error: unknown): void {
		this.transport.invalidate(error);
	}
}

/** Owns the worker mirror and invokes computations against immutable snapshots. */
export class WorkerTextModelSyncServer<TLane extends string, TPayload, TResult> extends Disposable {
	private readonly mirror = this._register(new MutableDisposable<LanguageWorkerDocumentMirror>());
	private readonly results: WorkerTextModelResultStore<TLane, TResult> | undefined;

	constructor(port: WebWorkerPort, private readonly codec: WorkerTextModelCodec<TLane, TPayload, TResult>, private readonly worker: LanguageWorker<TLane, TPayload, TResult>) {
		super();
		this.results = codec.createResultStore?.();
		this._register(worker);
		this._register(toDisposable(() => this.results?.clear()));
		this._register(new WebWorkerServer(port, modelChannel, {
			handleRequest: (message, signal) => this.run(message, signal),
			handleNotification: message => this.synchronize(message),
		}));
	}

	private synchronize(message: Record<string, unknown>): void {
		try {
			if (message.kind !== 'sync') {
				throw new TypeError('Unknown model worker notification');
			}
			assertPositiveSafeInteger(message.previousVersion, 'Previous model version');
			assertPositiveSafeInteger(message.modelVersion, 'Model version');
			if (!Array.isArray(message.changes)) {
				throw new TypeError('Model changes must be an array');
			}
			if (message.eol !== '\n' && message.eol !== '\r\n') {
				throw new TypeError('Model EOL must be LF or CRLF');
			}
			const mirror = this.mirror.value;
			if (!mirror) {
				throw new Error('Model synchronization requires a document mirror');
			}
			const changes = Object.freeze(message.changes.map((change: LanguageWorkerDocumentChange) => Object.freeze({ rangeOffset: change.rangeOffset, rangeLength: change.rangeLength, text: change.text })));
			mirror.synchronize(message.previousVersion, message.modelVersion, changes, message.eol);
			const observer = this.worker as Partial<LanguageWorkerDocumentSynchronizationObserver>;
			observer.synchronizeDocument?.({ previousVersion: message.previousVersion, modelVersion: message.modelVersion, eol: message.eol, changes, snapshot: mirror.createSnapshot() });
		} catch (error) {
			this.mirror.clear();
			throw error;
		}
	}

	private async run(message: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		assertPositiveSafeInteger(message.requestId, 'Worker request ID');
		const lane = message.lane as TLane;
		if (!this.codec.lanes.includes(lane)) {
			throw new RangeError(`Unsupported worker lane '${String(lane)}'`);
		}
		if (message.resultBaseRequestId !== undefined) {
			assertPositiveSafeInteger(message.resultBaseRequestId, 'Result base request ID');
		}
		const decoded = decodeRequestSnapshot(message.snapshot as RequestWireMessage['snapshot'], this.mirror.value?.createSnapshot());
		if (decoded.replacesMirror) {
			this.mirror.value = new LanguageWorkerDocumentMirror(decoded.snapshot);
		}
		const request = Object.freeze({ requestId: message.requestId, lane, snapshot: decoded.snapshot, payload: this.codec.decodePayload(lane, message.payload, decoded.snapshot) });
		const currentBase = this.results?.get(lane);
		const base = currentBase?.requestId === message.resultBaseRequestId ? currentBase : undefined;
		const result = await this.worker.run(request, signal);
		signal.throwIfAborted();
		const encoded = this.codec.encodeResult(lane, result, request.snapshot, base);
		this.results?.stage(lane, Object.freeze({ requestId: request.requestId, snapshot: request.snapshot, result }));
		this.results?.settle(request.requestId, true);
		return encoded;
	}
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
	readonly kind: "request";
	readonly requestId: number;
	readonly lane: string;
	readonly resultBaseRequestId?: number;
	readonly snapshot: FullSnapshotWireDto | ReferencedSnapshotWireDto;
	readonly payload: unknown;
}

interface SyncWireMessage {
	readonly kind: "sync";
	readonly previousVersion: number;
	readonly modelVersion: number;
	readonly eol: '\n' | '\r\n';
	readonly changes: readonly ContentChangeWireDto[];
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

function encodeRequestMessage<TLane extends string, TPayload, TResult>(request: LanguageWorkerRequest<TLane, TPayload>, codec: WorkerTextModelCodec<TLane, TPayload, TResult>, mirroredVersion: number | undefined, resultBaseRequestId: number | undefined): EncodedRequestWireMessage {
	if (resultBaseRequestId !== undefined) assertPositiveSafeInteger(resultBaseRequestId, "Result base request ID");
	const snapshot = mirroredVersion === request.snapshot.version
		? encodeReferencedSnapshot(request.snapshot)
		: encodeFullSnapshot(request.snapshot);
	return Object.freeze({
		message: Object.freeze<RequestWireMessage>({
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
