// Minimal shared runtime APIs for the isolated common-layer check.
// Browser and Node compilations use their own platform declarations instead.
interface TimeoutHandle {
	readonly timeoutHandle: unique symbol;
}

declare function setTimeout(callback: () => void, delay?: number): TimeoutHandle;
declare function clearTimeout(handle: TimeoutHandle | undefined): void;
declare function setInterval(callback: () => void, delay?: number): TimeoutHandle;
declare function clearInterval(handle: TimeoutHandle | undefined): void;

interface AbortSignal {
	readonly aborted: boolean;
	readonly reason: unknown;
	throwIfAborted(): void;
	addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
	removeEventListener(type: 'abort', listener: () => void): void;
}

declare class AbortController {
	readonly signal: AbortSignal;
	abort(reason?: unknown): void;
}

declare function structuredClone<T>(value: T): T;
declare function queueMicrotask(callback: () => void): void;

interface Console {
	error(...values: unknown[]): void;
	log(...values: unknown[]): void;
	debug(...values: unknown[]): void;
	info(...values: unknown[]): void;
	warn(...values: unknown[]): void;
}

declare const console: Console;

declare var performance: { now(): number };

declare class TextEncoder {
	encode(input?: string): Uint8Array<ArrayBuffer>;
}

declare class TextDecoder {
	constructor(label?: string, options?: { ignoreBOM?: boolean; fatal?: boolean });
	decode(input?: ArrayBufferView | ArrayBuffer): string;
}

declare class URL {
	constructor(url: string, base?: string | URL);
	href: string;
	readonly origin: string;
	protocol: string;
	host: string;
	hostname: string;
	port: string;
	readonly searchParams: URLSearchParams;
	pathname: string;
	search: string;
	hash: string;
	username: string;
	password: string;
}

interface URLSearchParams {
	get(name: string): string | null;
	has(name: string): boolean;
	set(name: string, value: string): void;
}
