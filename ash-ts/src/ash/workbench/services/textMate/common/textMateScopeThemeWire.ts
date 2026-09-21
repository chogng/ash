import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { normalizeTextMateScopeTheme, TextMateScopeThemeModel, type TextMateScopeTheme } from "./textMateScopeTheme.js";
import { type WebWorkerClientPort, type WebWorkerPort } from '../../../../base/common/worker/webWorker.js';

interface TextMateScopeThemeRequest {
	readonly protocol: typeof PROTOCOL;
	readonly version: typeof VERSION;
	readonly kind: "replaceTheme";
	readonly requestId: number;
	readonly theme: TextMateScopeTheme;
}

interface TextMateScopeThemeResponse {
	readonly protocol: typeof PROTOCOL;
	readonly version: typeof VERSION;
	readonly kind: "replaceThemeResult";
	readonly requestId: number;
	readonly error?: { readonly name: string; readonly message: string };
}

interface PendingRequest {
	readonly resolve: () => void;
	readonly reject: (error: unknown) => void;
}

/** Renderer-side scope-theme transport sharing an Syntax Worker port. */
export class TextMateScopeThemeWireClient extends Disposable {
	private readonly pending = new Map<number, PendingRequest>();
	private nextRequestId = 1;
	private closed = false;

	constructor(private readonly port: WebWorkerClientPort, private readonly invalidateWorker: (error: Error) => void) {
		super();
		if (!port || typeof port.send !== "function" || typeof port.onMessage !== "function" || typeof port.onFailure !== "function") {
			throw new TypeError("TextMate scope theme client requires a Worker client port");
		}
		if (typeof invalidateWorker !== "function") throw new TypeError("TextMate scope theme client requires a Worker invalidation callback");
		this._register(port.onMessage(message => this.acceptMessage(message)));
		this._register(port.onFailure(error => this.invalidate(toError(error, "TextMate scope theme Worker failed"))));
		this._register(toDisposable(() => this.close(new ReferenceError("TextMateScopeThemeWireClient is already disposed"), false)));
	}

	replaceTheme(theme: TextMateScopeTheme): Promise<void> {
		this.assertOpen();
		const normalized = normalizeTextMateScopeTheme(theme);
		if (normalized.revision === 0) return Promise.resolve();
		const requestId = this.nextRequestId++;
		return new Promise<void>((resolve, reject) => {
			this.pending.set(requestId, { resolve, reject });
			try {
				this.port.send(Object.freeze({ protocol: PROTOCOL, version: VERSION, kind: "replaceTheme", requestId, theme: normalized } satisfies TextMateScopeThemeRequest));
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
		if (!invalidateWorker) return;
		try { this.invalidateWorker(error); } catch { /* Transport failure remains authoritative. */ }
	}

	private assertOpen(): void {
		this.assertNotDisposed();
		if (this.closed) throw new ReferenceError("TextMateScopeThemeWireClient is already disposed");
	}

	private acceptMessage(value: unknown): void {
		if (!isWireRecord(value) || value.protocol !== PROTOCOL) return;
		try {
			const response = decodeResponse(value);
			const pending = this.pending.get(response.requestId);
			if (!pending) throw new Error(`Unknown TextMate scope theme request '${response.requestId}'`);
			this.pending.delete(response.requestId);
			if (!response.error) {
				pending.resolve();
				return;
			}
			const error = remoteError(response.error);
			pending.reject(error);
			this.invalidate(error);
		} catch (error) {
			this.invalidate(toError(error, "Invalid TextMate scope theme response"));
		}
	}

}

/** Worker-side atomic scope-theme receiver sharing an Syntax Worker port. */
export class TextMateScopeThemeWireServer extends Disposable {
	constructor(private readonly port: WebWorkerPort, private readonly themes: TextMateScopeThemeModel, private readonly onDidReplace?: () => void) {
		super();
		if (!port || typeof port.send !== "function" || typeof port.onMessage !== "function") {
			throw new TypeError("TextMate scope theme server requires a Worker port");
		}
		if (!(themes instanceof TextMateScopeThemeModel)) throw new TypeError("TextMate scope theme server requires a theme model");
		if (onDidReplace !== undefined && typeof onDidReplace !== "function") throw new TypeError("TextMate scope theme replacement hook must be a function");
		this._register(port.onMessage(message => this.acceptMessage(message)));
	}

	private acceptMessage(value: unknown): void {
		if (!isWireRecord(value) || value.protocol !== PROTOCOL) return;
		let requestId = 0;
		try {
			const request = decodeRequest(value);
			requestId = request.requestId;
			this.themes.replace(request.theme);
			this.onDidReplace?.();
			this.sendResult(requestId);
		} catch (error) {
			if (requestId === 0 && Number.isSafeInteger(value.requestId) && (value.requestId as number) > 0) requestId = value.requestId as number;
			if (requestId > 0) this.sendResult(requestId, toError(error, "Unable to replace TextMate scope theme"));
		}
	}

	private sendResult(requestId: number, error?: Error): void {
		this.port.send(Object.freeze({
			protocol: PROTOCOL,
			version: VERSION,
			kind: "replaceThemeResult",
			requestId,
			...(error === undefined ? {} : { error: Object.freeze({ name: error.name, message: error.message }) }),
		} satisfies TextMateScopeThemeResponse));
	}
}

const PROTOCOL = "ash.textmate.scope-theme";
const VERSION = 1;

function decodeRequest(value: Record<string, unknown>): TextMateScopeThemeRequest {
	if (value.version !== VERSION || value.kind !== "replaceTheme") throw new TypeError("Unsupported TextMate scope theme request");
	assertRequestId(value.requestId);
	return { protocol: PROTOCOL, version: VERSION, kind: "replaceTheme", requestId: value.requestId, theme: normalizeTextMateScopeTheme(value.theme as TextMateScopeTheme) };
}

function decodeResponse(value: Record<string, unknown>): TextMateScopeThemeResponse {
	if (value.version !== VERSION || value.kind !== "replaceThemeResult") throw new TypeError("Unsupported TextMate scope theme response");
	assertRequestId(value.requestId);
	if (value.error === undefined) return { protocol: PROTOCOL, version: VERSION, kind: "replaceThemeResult", requestId: value.requestId };
	if (!isWireRecord(value.error) || typeof value.error.name !== "string" || typeof value.error.message !== "string") {
		throw new TypeError("Invalid TextMate scope theme remote error");
	}
	return { protocol: PROTOCOL, version: VERSION, kind: "replaceThemeResult", requestId: value.requestId, error: { name: value.error.name, message: value.error.message } };
}

function assertRequestId(value: unknown): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new RangeError("TextMate scope theme request ID must be a positive safe integer");
}

function remoteError(value: NonNullable<TextMateScopeThemeResponse["error"]>): Error {
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
