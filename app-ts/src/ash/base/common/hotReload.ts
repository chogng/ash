import type { IDisposable } from "./lifecycle.js";
import { toDisposable } from "./lifecycle.js";

export interface HotReloadConfig {
	readonly mode?: "patch-prototype";
}

export interface HotReloadRequest {
	readonly oldExports: Record<string, unknown>;
	readonly newSrc: string;
	readonly config: HotReloadConfig;
}

export type AcceptNewExportsHandler = (newExports: Record<string, unknown>) => boolean;
export type HotReloadHandler = (request: HotReloadRequest) => AcceptNewExportsHandler | undefined;

type HotReloadGlobal = typeof globalThis & {
	$hotReload_applyNewExports?: (request: Omit<HotReloadRequest, "config"> & { readonly config?: HotReloadConfig }) => AcceptNewExportsHandler | undefined;
};

let enabled = false;
const handlers = new Set<HotReloadHandler>();

/** Enables the development-only hot-reload handler boundary in this realm. */
export function enableHotReload(): void {
	if (enabled) return;
	enabled = true;
	handlers.add(createPrototypePatchHandler());
	(globalThis as HotReloadGlobal).$hotReload_applyNewExports = applyNewExports;
}

/** Returns whether hot reload has been enabled for the current realm. */
export function isHotReloadEnabled(): boolean {
	return enabled;
}

/** Registers a runtime strategy that may accept one Vite module replacement. */
export function registerHotReloadHandler(handler: HotReloadHandler): IDisposable {
	if (!enabled) return toDisposable(() => {});
	handlers.add(handler);
	return toDisposable(() => handlers.delete(handler));
}

function applyNewExports(request: Omit<HotReloadRequest, "config"> & { readonly config?: HotReloadConfig }): AcceptNewExportsHandler | undefined {
	const normalized: HotReloadRequest = { ...request, config: request.config ?? {} };
	const acceptors = [...handlers].map(handler => handler(normalized)).filter((handler): handler is AcceptNewExportsHandler => handler !== undefined);
	if (acceptors.length === 0) return undefined;
	return newExports => acceptors.reduce((accepted, accept) => accept(newExports) || accepted, false);
}

function createPrototypePatchHandler(): HotReloadHandler {
	return ({ oldExports, newSrc, config }) => {
		if (config.mode !== "patch-prototype") return undefined;
		return newExports => patchExportedPrototypes(oldExports, newExports, newSrc);
	};
}

function patchExportedPrototypes(oldExports: Record<string, unknown>, newExports: Record<string, unknown>, source: string): boolean {
	if (!sameKeys(oldExports, newExports)) return false;
	const replacements: Array<{ readonly current: object; readonly replacement: object; readonly name: string }> = [];
	for (const name of Object.keys(newExports)) {
		const current = oldExports[name];
		const replacement = newExports[name];
		if (!isClassLike(current) && !isClassLike(replacement)) continue;
		if (!isClassLike(current) || !isClassLike(replacement) || !canPatchPrototype(current.prototype, replacement.prototype)) return false;
		replacements.push({ current: current.prototype, replacement: replacement.prototype, name });
	}
	if (replacements.length === 0) return false;
	for (const replacement of replacements) {
		patchPrototype(replacement.current, replacement.replacement);
		newExports[replacement.name] = oldExports[replacement.name];
		console.debug(`[hot-reload] Patched '${replacement.name}' from ${source}`);
	}
	return true;
}

function sameKeys(first: Record<string, unknown>, second: Record<string, unknown>): boolean {
	const firstKeys = Object.keys(first).sort();
	const secondKeys = Object.keys(second).sort();
	return firstKeys.length === secondKeys.length && firstKeys.every((key, index) => key === secondKeys[index]);
}

function isClassLike(value: unknown): value is Function & { readonly prototype: object } {
	return typeof value === "function" && typeof value.prototype === "object" && value.prototype !== null;
}

function canPatchPrototype(current: object, replacement: object): boolean {
	if (Object.getPrototypeOf(current) !== Object.getPrototypeOf(replacement)) return false;
	const replacementKeys = new Set(Reflect.ownKeys(replacement));
	for (const key of Reflect.ownKeys(current)) {
		if (key === "constructor" || replacementKeys.has(key)) continue;
		if (Object.getOwnPropertyDescriptor(current, key)?.configurable === false) return false;
	}
	for (const key of replacementKeys) {
		if (key === "constructor") continue;
		if (Object.getOwnPropertyDescriptor(current, key)?.configurable === false) return false;
	}
	return true;
}

function patchPrototype(current: object, replacement: object): void {
	const replacementKeys = new Set(Reflect.ownKeys(replacement));
	for (const key of Reflect.ownKeys(current)) {
		if (key !== "constructor" && !replacementKeys.has(key)) Reflect.deleteProperty(current, key);
	}
	for (const key of replacementKeys) {
		if (key === "constructor") continue;
		const descriptor = Object.getOwnPropertyDescriptor(replacement, key);
		if (descriptor) Object.defineProperty(current, key, descriptor);
	}
}
