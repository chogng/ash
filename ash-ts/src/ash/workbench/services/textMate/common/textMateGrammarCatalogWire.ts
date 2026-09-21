import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { normalizeTextMateGrammarCatalog, type TextMateGrammarCatalog } from "./textMateGrammarCatalog.js";
import { TextMateGrammarCatalogStore } from "./textMateGrammarCatalogStore.js";
import { type WebWorkerClientPort, type WebWorkerPort } from '../../../../base/common/worker/webWorker.js';

interface TextMateGrammarCatalogRequest {
	readonly protocol: typeof PROTOCOL;
	readonly version: typeof VERSION;
	readonly kind: "replaceCatalog";
	readonly requestId: number;
	readonly catalog: TextMateGrammarCatalog;
}

interface TextMateGrammarCatalogResponse {
	readonly protocol: typeof PROTOCOL;
	readonly version: typeof VERSION;
	readonly kind: "replaceCatalogResult";
	readonly requestId: number;
	readonly error?: {
		readonly name: string;
		readonly message: string;
	};
}

interface PendingRequest {
	readonly resolve: () => void;
	readonly reject: (error: unknown) => void;
}

/** Renderer-side grammar catalog transport sharing an Syntax Worker port. */
export class TextMateGrammarCatalogWireClient extends Disposable {
	private readonly pending = new Map<number, PendingRequest>();
	private nextRequestId = 1;
	private closed = false;

	constructor(
		private readonly port: WebWorkerClientPort,
		private readonly invalidateWorker: (error: Error) => void,
	) {
		super();
		if (!port || typeof port.send !== "function" || typeof port.onMessage !== "function" || typeof port.onFailure !== "function") {
			throw new TypeError("TextMate grammar catalog client requires a Worker client port");
		}
		if (typeof invalidateWorker !== "function") {
			throw new TypeError("TextMate grammar catalog client requires a Worker invalidation callback");
		}
		this._register(port.onMessage(message => this.acceptMessage(message)));
		this._register(port.onFailure(error => this.invalidate(toError(error, "TextMate grammar catalog Worker failed"))));
		this._register(toDisposable(() => this.close(new ReferenceError("TextMateGrammarCatalogWireClient is already disposed"), false)));
	}

	replaceCatalog(catalog: TextMateGrammarCatalog): Promise<void> {
		this.assertOpen();
		const normalized = normalizeTextMateGrammarCatalog(catalog);
		if (normalized.revision === 0) return Promise.resolve();
		const requestId = this.nextRequestId++;
		return new Promise<void>((resolve, reject) => {
			this.pending.set(requestId, { resolve, reject });
			try {
				this.port.send(Object.freeze({
					protocol: PROTOCOL,
					version: VERSION,
					kind: "replaceCatalog",
					requestId,
					catalog: normalized,
				} satisfies TextMateGrammarCatalogRequest));
			} catch (error) {
				this.pending.delete(requestId);
				reject(error);
			}
		});
	}

	invalidate(error: Error): void {
		this.close(error, true);
	}

	private close(error: Error, invalidateWorker: boolean): void {
		if (this.closed) return;
		this.closed = true;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
		if (invalidateWorker) {
			try {
				this.invalidateWorker(error);
			} catch {
				// The transport error remains authoritative.
			}
		}
	}

	private assertOpen(): void {
		this.assertNotDisposed();
		if (this.closed) throw new ReferenceError("TextMateGrammarCatalogWireClient is already disposed");
	}

	private acceptMessage(value: unknown): void {
		if (!isWireRecord(value) || value.protocol !== PROTOCOL) return;
		try {
			const response = decodeResponse(value);
			const pending = this.pending.get(response.requestId);
			if (!pending) throw new Error(`Unknown TextMate grammar catalog request '${response.requestId}'`);
			this.pending.delete(response.requestId);
			if (response.error) {
				const error = remoteError(response.error);
				pending.reject(error);
				this.invalidate(error);
			} else {
				pending.resolve();
			}
		} catch (error) {
			this.invalidate(toError(error, "Invalid TextMate grammar catalog response"));
		}
	}

}

/** Worker-side atomic catalog receiver sharing the Syntax Worker port. */
export class TextMateGrammarCatalogWireServer extends Disposable {
	constructor(
		private readonly port: WebWorkerPort,
		private readonly store: TextMateGrammarCatalogStore,
	) {
		super();
		if (!port || typeof port.send !== "function" || typeof port.onMessage !== "function") {
			throw new TypeError("TextMate grammar catalog server requires a Worker port");
		}
		if (!(store instanceof TextMateGrammarCatalogStore)) {
			throw new TypeError("TextMate grammar catalog server requires a catalog store");
		}
		this._register(port.onMessage(message => this.acceptMessage(message)));
	}

	private acceptMessage(value: unknown): void {
		if (!isWireRecord(value) || value.protocol !== PROTOCOL) return;
		let requestId = 0;
		try {
			const request = decodeRequest(value);
			requestId = request.requestId;
			this.store.replace(request.catalog);
			this.sendResult(requestId);
		} catch (error) {
			if (requestId === 0 && Number.isSafeInteger(value.requestId) && (value.requestId as number) > 0) {
				requestId = value.requestId as number;
			}
			if (requestId > 0) this.sendResult(requestId, toError(error, "Unable to replace TextMate grammar catalog"));
		}
	}

	private sendResult(requestId: number, error?: Error): void {
		this.port.send(Object.freeze({
			protocol: PROTOCOL,
			version: VERSION,
			kind: "replaceCatalogResult",
			requestId,
			...(error === undefined ? {} : { error: Object.freeze({ name: error.name, message: error.message }) }),
		} satisfies TextMateGrammarCatalogResponse));
	}
}

const PROTOCOL = "ash.textmate.grammar-catalog";
const VERSION = 1;

function decodeRequest(value: Record<string, unknown>): TextMateGrammarCatalogRequest {
	if (value.version !== VERSION || value.kind !== "replaceCatalog") {
		throw new TypeError("Unsupported TextMate grammar catalog request");
	}
	assertRequestId(value.requestId);
	const catalog = normalizeTextMateGrammarCatalog(value.catalog as TextMateGrammarCatalog);
	return { protocol: PROTOCOL, version: VERSION, kind: "replaceCatalog", requestId: value.requestId, catalog };
}

function decodeResponse(value: Record<string, unknown>): TextMateGrammarCatalogResponse {
	if (value.version !== VERSION || value.kind !== "replaceCatalogResult") {
		throw new TypeError("Unsupported TextMate grammar catalog response");
	}
	assertRequestId(value.requestId);
	if (value.error === undefined) {
		return { protocol: PROTOCOL, version: VERSION, kind: "replaceCatalogResult", requestId: value.requestId };
	}
	if (!isWireRecord(value.error) || typeof value.error.name !== "string" || typeof value.error.message !== "string") {
		throw new TypeError("Invalid TextMate grammar catalog remote error");
	}
	return {
		protocol: PROTOCOL,
		version: VERSION,
		kind: "replaceCatalogResult",
		requestId: value.requestId,
		error: { name: value.error.name, message: value.error.message },
	};
}

function assertRequestId(value: unknown): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw new RangeError("TextMate grammar catalog request ID must be a positive safe integer");
	}
}

function remoteError(value: NonNullable<TextMateGrammarCatalogResponse["error"]>): Error {
	const error = new Error(value.message);
	error.name = value.name;
	return error;
}

function toError(value: unknown, fallback: string): Error {
	return value instanceof Error ? value : new Error(fallback, { cause: value });
}

function isWireRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
