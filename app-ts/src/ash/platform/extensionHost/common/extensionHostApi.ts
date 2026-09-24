import { VSBuffer } from "../../../base/common/buffer.js";
import { throwIfCancelled } from "../../../base/common/cancellation.js";
import { CancellationError } from "../../../base/common/errors.js";
import type { AppServerConnectionState } from "../../app-server/common/appServerApi.js";
import type { DisposableHandle } from "../../ipc/common/ipc.js";
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

export type ExtensionHostReconcileMode = "refresh" | "restartFailed";
export type ExtensionHostRuntimeLifecycle = "stopped" | "starting" | "handshaking" | "ready" | "recovering" | "crashLoop" | "failed";
export type ExtensionHostFailureCode = "authorityDenied" | "staleSnapshot" | "isolationUnavailable" | "launchFailed" | "handshakeFailed" | "activationFailed" | "registrationNotFound" | "operationNotSupported" | "cancelled" | "deadlineExceeded" | "quotaExceeded" | "hostExited" | "hostRestarted" | "outcomeIndeterminate" | "crashLoop" | "invalidProtocol" | "internal";
export type ExtensionHostLanguageProviderOperation = "completion" | "definition" | "hover" | "references" | "rename" | "formatting" | "codeAction" | "codeLens" | "documentSymbols" | "foldingRanges" | "documentLinks" | "documentColors" | "semanticTokens" | "inlayHints" | "linkedEditing" | "parameterHints";
export type ExtensionHostCancellationReason = "caller" | "deadline" | "authorityRevoked" | "shutdown";
export type ExtensionHostOutputSeverity = "trace" | "debug" | "information" | "warning" | "error" | "log";
export type ExtensionHostOutputOperation =
	| { readonly operation: "create"; readonly channelId: string; readonly label: string; readonly kind: "output" | "log" }
	| { readonly operation: "append" | "replace"; readonly channelId: string; readonly text: string; readonly severity: ExtensionHostOutputSeverity; readonly category: string | undefined }
	| { readonly operation: "clear" | "dispose"; readonly channelId: string }
	| { readonly operation: "show"; readonly channelId: string; readonly preserveFocus: boolean };
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface ExtensionHostRuntimeFailure {
	readonly code: ExtensionHostFailureCode;
	readonly message: string;
	readonly incarnation: number | undefined;
}

export interface ExtensionHostOutputEvent {
	readonly sequence: number;
	readonly incarnation: number;
	readonly activationGeneration: number;
	readonly operation: ExtensionHostOutputOperation;
}

interface ExtensionHostRegistrationBase {
	readonly registrationId: string;
}

export interface ExtensionHostCommandRegistration extends ExtensionHostRegistrationBase {
	readonly kind: "command";
	readonly command: string;
	readonly title: string;
}

export interface ExtensionHostLanguageRegistration extends ExtensionHostRegistrationBase {
	readonly kind: "languageProvider";
	readonly languageIds: readonly string[];
	readonly operations: readonly ExtensionHostLanguageProviderOperation[];
}

export interface ExtensionHostDebugAdapterRegistration extends ExtensionHostRegistrationBase {
	readonly kind: "debugAdapter";
	readonly debuggerType: string;
}

export interface ExtensionHostTaskProviderRegistration extends ExtensionHostRegistrationBase {
	readonly kind: "taskProvider";
	readonly taskType: string;
}

export interface ExtensionHostTestProfileProviderRegistration extends ExtensionHostRegistrationBase {
	readonly kind: "testProfileProvider";
	readonly providerId: string;
	readonly label: string;
}

export type ExtensionHostRegistration = ExtensionHostCommandRegistration | ExtensionHostLanguageRegistration | ExtensionHostDebugAdapterRegistration | ExtensionHostTaskProviderRegistration | ExtensionHostTestProfileProviderRegistration;

export interface ExtensionHostRuntime {
	readonly id: string;
	readonly version: string;
	readonly packageDigest: string;
	readonly runtimeApiVersion: number;
	readonly activationGeneration: number;
	readonly incarnation: number | undefined;
	readonly lifecycle: ExtensionHostRuntimeLifecycle;
	readonly failure: ExtensionHostRuntimeFailure | undefined;
	readonly stderr: string;
	readonly outputEvents: readonly ExtensionHostOutputEvent[];
	readonly registrations: readonly ExtensionHostRegistration[];
}

export interface ExtensionHostFleetSnapshot {
	readonly generation: number;
	readonly extensions: readonly ExtensionHostRuntime[];
}

export interface ExtensionHostInvocationRequest {
	readonly extensionId: string;
	readonly registrationId: string;
	readonly activationGeneration: number;
	readonly incarnation: number;
	readonly operation: string;
	readonly payload: JsonValue;
	readonly deadlineUnixMillis: number;
}

/** Renderer-facing Extension Host authority and invocation capability. */
export interface IExtensionHostApi {
	isAvailable(): Promise<boolean>;
	list(): Promise<ExtensionHostFleetSnapshot>;
	reconcile(mode: ExtensionHostReconcileMode): Promise<ExtensionHostFleetSnapshot>;
	invoke(request: ExtensionHostInvocationRequest, signal: AbortSignal): Promise<JsonValue>;
	getConnectionState(): Promise<AppServerConnectionState>;
	onDidChange(listener: (generation: number) => void): DisposableHandle;
	onConnectionState(listener: (state: AppServerConnectionState) => void): DisposableHandle;
}

export const IExtensionHostApi = createServiceIdentifier<IExtensionHostApi>("extensionHostApi");

export interface ExtensionHostInvokeTransport {
	start(request: ExtensionHostInvocationRequest): Promise<unknown>;
	read(invocationId: string): Promise<unknown>;
	cancel(invocationId: string): Promise<unknown>;
}

export interface ExtensionHostInvokeOptions {
	readonly pollIntervalMillis?: number;
	readonly now?: () => number;
	readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export class ExtensionHostInvocationError extends Error {
	constructor(readonly code: ExtensionHostFailureCode, message: string) {
		super(message);
		this.name = "ExtensionHostInvocationError";
	}
}

const FAILURE_CODES = ["authorityDenied", "staleSnapshot", "isolationUnavailable", "launchFailed", "handshakeFailed", "activationFailed", "registrationNotFound", "operationNotSupported", "cancelled", "deadlineExceeded", "quotaExceeded", "hostExited", "hostRestarted", "outcomeIndeterminate", "crashLoop", "invalidProtocol", "internal"] as const;
const LIFECYCLES = ["stopped", "starting", "handshaking", "ready", "recovering", "crashLoop", "failed"] as const;
const LANGUAGE_OPERATIONS = ["completion", "definition", "hover", "references", "rename", "formatting", "codeAction", "codeLens", "documentSymbols", "foldingRanges", "documentLinks", "documentColors", "semanticTokens", "inlayHints", "linkedEditing", "parameterHints"] as const;
const CANCELLATION_REASONS = ["caller", "deadline", "authorityRevoked", "shutdown"] as const;
const OUTPUT_SEVERITIES = ["trace", "debug", "information", "warning", "error", "log"] as const;
const MAX_PAYLOAD_BYTES = 512 * 1024;
const MAX_OUTPUT_EVENT_BYTES = 1024 * 1024;
const MAX_PAYLOAD_NODES = 65_536;
const MAX_PAYLOAD_DEPTH = 64;

export function normalizeExtensionHostSnapshot(value: unknown): ExtensionHostFleetSnapshot {
	const snapshot = exactRecord(value, "Extension Host snapshot", ["extensions", "generation"]);
	const extensions = boundedArray(snapshot.extensions, "Extension Host extensions", 128).map(normalizeRuntime);
	assertUnique(extensions.map(extension => extension.id), "Extension Host extension IDs");
	return Object.freeze({ generation: positiveSafeInteger(snapshot.generation, "Extension Host fleet generation"), extensions: Object.freeze(extensions) });
}

export function normalizeExtensionHostChanged(value: unknown): number {
	const changed = exactRecord(value, "Extension Host changed notification", ["generation"]);
	return positiveSafeInteger(changed.generation, "Extension Host changed generation");
}

export function normalizeExtensionHostPayload(value: unknown): JsonValue {
	const budget = { bytes: 0, nodes: 0, seen: new Set<object>() };
	const normalized = normalizeJsonValue(value, "Extension Host payload", 0, budget);
	if (utf8Length(JSON.stringify(normalized)) > MAX_PAYLOAD_BYTES) throw new RangeError("Extension Host payload is too large");
	return normalized;
}

export function normalizeExtensionHostInvocationRequest(value: ExtensionHostInvocationRequest): ExtensionHostInvocationRequest {
	const request = exactRecord(value, "Extension Host invocation", ["activationGeneration", "deadlineUnixMillis", "extensionId", "incarnation", "operation", "payload", "registrationId"]);
	return Object.freeze({
		extensionId: boundedText(request.extensionId, "Extension Host extension ID", 256),
		registrationId: boundedText(request.registrationId, "Extension Host registration ID", 256),
		activationGeneration: positiveSafeInteger(request.activationGeneration, "Extension Host activation generation"),
		incarnation: positiveSafeInteger(request.incarnation, "Extension Host incarnation"),
		operation: boundedText(request.operation, "Extension Host operation", 128),
		payload: normalizeExtensionHostPayload(request.payload),
		deadlineUnixMillis: positiveSafeInteger(request.deadlineUnixMillis, "Extension Host invocation deadline"),
	});
}

/** Polls one connection-owned invocation and always requests cancellation on local abandonment. */
export async function invokeExtensionHost(transport: ExtensionHostInvokeTransport, request: ExtensionHostInvocationRequest, signal: AbortSignal, options: ExtensionHostInvokeOptions = {}): Promise<JsonValue> {
	const normalized = normalizeExtensionHostInvocationRequest(request);
	throwIfCancelled(signal, "Extension Host invocation cancelled");
	const pollIntervalMillis = boundedPollInterval(options.pollIntervalMillis ?? 20);
	const now = options.now ?? Date.now;
	const wait = options.wait ?? waitForPoll;
	let invocationId: string | undefined;
	let terminal = false;
	try {
		const started = exactRecord(await transport.start(normalized), "Extension Host invocation start result", ["invocationId"]);
		invocationId = boundedText(started.invocationId, "Extension Host invocation ID", 256);
		while (true) {
			throwIfCancelled(signal, "Extension Host invocation cancelled");
			if (now() >= normalized.deadlineUnixMillis) throw new ExtensionHostInvocationError("deadlineExceeded", "Extension Host invocation deadline elapsed");
			const result = normalizeReadResult(await transport.read(invocationId));
			if (result.state === "pending") {
				await wait(pollIntervalMillis, signal);
				continue;
			}
			terminal = true;
			if (result.state === "succeeded") return result.payload;
			if (result.state === "failed") throw new ExtensionHostInvocationError(result.code, result.message);
			throw new CancellationError(`Extension Host invocation cancelled: ${result.reason}`, result.reason);
		}
	} finally {
		if (invocationId !== undefined && !terminal) {
			try { normalizeCancelResult(await transport.cancel(invocationId)); }
			catch { /* Preserve the original cancellation, transport or validation failure. */ }
		}
	}
}

function normalizeRuntime(value: unknown): ExtensionHostRuntime {
	const runtime = exactRecord(value, "Extension Host runtime", ["activationGeneration", "failure", "id", "incarnation", "lifecycle", "outputEvents", "packageDigest", "registrations", "runtimeApiVersion", "stderr", "version"]);
	const registrations = boundedArray(runtime.registrations, "Extension Host registrations", 2048).map(normalizeRegistration);
	const outputEvents = boundedArray(runtime.outputEvents, "Extension Host Output events", 4096).map(normalizeOutputEvent);
	if (utf8Length(JSON.stringify(outputEvents)) > MAX_OUTPUT_EVENT_BYTES) throw new RangeError("Extension Host Output event history is too large");
	assertUnique(registrations.map(registration => registration.registrationId), "Extension Host registration IDs");
	assertStrictlyIncreasing(outputEvents.map(event => event.sequence), "Extension Host Output event sequences");
	const lifecycle = stringEnum(runtime.lifecycle, "Extension Host lifecycle", LIFECYCLES);
	const incarnation = optionalPositiveSafeInteger(runtime.incarnation, "Extension Host incarnation");
	if (lifecycle === "ready" && incarnation === undefined) throw new TypeError("Ready Extension Host runtime must have an incarnation");
	return Object.freeze({
		id: boundedText(runtime.id, "Extension Host extension ID", 256),
		version: boundedText(runtime.version, "Extension Host extension version", 128),
		packageDigest: sha256Digest(runtime.packageDigest, "Extension Host package digest"),
		runtimeApiVersion: boundedPositiveSafeInteger(runtime.runtimeApiVersion, "Extension Host runtime API version", 65_535),
		activationGeneration: positiveSafeInteger(runtime.activationGeneration, "Extension Host activation generation"),
		incarnation,
		lifecycle,
		failure: runtime.failure === null ? undefined : normalizeFailure(runtime.failure),
		stderr: boundedOptionalText(runtime.stderr, "Extension Host stderr", 262_144),
		outputEvents: Object.freeze(outputEvents),
		registrations: Object.freeze(registrations),
	});
}

function normalizeOutputEvent(value: unknown): ExtensionHostOutputEvent {
	const input = record(value, "Extension Host Output event");
	const operation = input.operation;
	const sequence = positiveSafeInteger(input.sequence, "Extension Host Output event sequence");
	const incarnation = positiveSafeInteger(input.incarnation, "Extension Host Output event incarnation");
	const activationGeneration = positiveSafeInteger(input.activationGeneration, "Extension Host Output event activation generation");
	const channelId = outputChannelId(input.channelId);
	if (operation === "create") {
		exactKeys(input, "Extension Host Output create event", ["activationGeneration", "channelId", "incarnation", "kind", "label", "operation", "sequence"]);
		return Object.freeze({ sequence, incarnation, activationGeneration, operation: Object.freeze({ operation, channelId, label: boundedText(input.label, "Extension Host Output channel label", 512), kind: stringEnum(input.kind, "Extension Host Output channel kind", ["output", "log"] as const) }) });
	}
	if (operation === "append" || operation === "replace") {
		exactKeys(input, `Extension Host Output ${operation} event`, ["activationGeneration", "category", "channelId", "incarnation", "operation", "sequence", "severity", "text"]);
		const category = input.category === null ? undefined : boundedText(input.category, "Extension Host Output category", 128);
		return Object.freeze({ sequence, incarnation, activationGeneration, operation: Object.freeze({ operation, channelId, text: boundedOptionalText(input.text, "Extension Host Output text", 524_288), severity: stringEnum(input.severity, "Extension Host Output severity", OUTPUT_SEVERITIES), category }) });
	}
	if (operation === "clear" || operation === "dispose") {
		exactKeys(input, `Extension Host Output ${operation} event`, ["activationGeneration", "channelId", "incarnation", "operation", "sequence"]);
		return Object.freeze({ sequence, incarnation, activationGeneration, operation: Object.freeze({ operation, channelId }) });
	}
	if (operation === "show") {
		exactKeys(input, "Extension Host Output show event", ["activationGeneration", "channelId", "incarnation", "operation", "preserveFocus", "sequence"]);
		if (typeof input.preserveFocus !== "boolean") throw new TypeError("Extension Host Output preserve-focus flag is invalid");
		return Object.freeze({ sequence, incarnation, activationGeneration, operation: Object.freeze({ operation, channelId, preserveFocus: input.preserveFocus }) });
	}
	throw new TypeError("Extension Host Output operation is invalid");
}

function boundedOptionalText(value: unknown, owner: string, maximumLength: number): string {
	if (typeof value !== "string") throw new TypeError(`${owner} must be a string`);
	if (value.length > maximumLength || value.includes("\0")) throw new RangeError(`${owner} is invalid`);
	return value;
}

function normalizeFailure(value: unknown): ExtensionHostRuntimeFailure {
	const failure = exactRecord(value, "Extension Host failure", ["code", "incarnation", "message"]);
	return Object.freeze({
		code: stringEnum(failure.code, "Extension Host failure code", FAILURE_CODES),
		message: boundedText(failure.message, "Extension Host failure message", 4096),
		incarnation: optionalPositiveSafeInteger(failure.incarnation, "Extension Host failure incarnation"),
	});
}

function normalizeRegistration(value: unknown): ExtensionHostRegistration {
	const input = record(value, "Extension Host registration");
	const kind = input.kind;
	const registrationId = boundedText(input.registrationId, "Extension Host registration ID", 256);
	if (kind === "command") {
		exactKeys(input, "Extension Host command registration", ["command", "kind", "registrationId", "title"]);
		return Object.freeze({ kind, registrationId, command: boundedText(input.command, "Extension Host command", 256), title: boundedText(input.title, "Extension Host command title", 512) });
	}
	if (kind === "languageProvider") {
		exactKeys(input, "Extension Host language registration", ["kind", "languageIds", "operations", "registrationId"]);
		const languageIds = boundedArray(input.languageIds, "Extension Host language IDs", 64).map((languageId, index) => boundedText(languageId, `Extension Host language ID ${index}`, 256));
		const operations = boundedArray(input.operations, "Extension Host language operations", 32).map(operation => stringEnum(operation, "Extension Host language operation", LANGUAGE_OPERATIONS));
		if (languageIds.length === 0 || operations.length === 0) throw new TypeError("Extension Host language registration must not be empty");
		assertUnique(languageIds, "Extension Host language IDs");
		assertUnique(operations, "Extension Host language operations");
		return Object.freeze({ kind, registrationId, languageIds: Object.freeze(languageIds), operations: Object.freeze(operations) });
	}
	if (kind === "debugAdapter") {
		exactKeys(input, "Extension Host Debug Adapter registration", ["debuggerType", "kind", "registrationId"]);
		return Object.freeze({ kind, registrationId, debuggerType: boundedText(input.debuggerType, "Extension Host Debug Adapter type", 256) });
	}
	if (kind === "taskProvider") {
		exactKeys(input, "Extension Host Task provider registration", ["kind", "registrationId", "taskType"]);
		return Object.freeze({ kind, registrationId, taskType: boundedText(input.taskType, "Extension Host Task type", 256) });
	}
	if (kind === "testProfileProvider") {
		exactKeys(input, "Extension Host Test Profile provider registration", ["kind", "label", "providerId", "registrationId"]);
		return Object.freeze({ kind, registrationId, providerId: boundedText(input.providerId, "Extension Host Test Profile provider ID", 256), label: boundedText(input.label, "Extension Host Test Profile provider label", 512) });
	}
	throw new TypeError("Extension Host registration kind is invalid");
}

type ReadResult = { readonly state: "pending" } | { readonly state: "succeeded"; readonly payload: JsonValue } | { readonly state: "failed"; readonly code: ExtensionHostFailureCode; readonly message: string } | { readonly state: "cancelled"; readonly reason: ExtensionHostCancellationReason };

function normalizeReadResult(value: unknown): ReadResult {
	const result = record(value, "Extension Host invocation read result");
	if (result.state === "pending") {
		exactKeys(result, "Extension Host pending invocation", ["state"]);
		return Object.freeze({ state: "pending" });
	}
	if (result.state === "succeeded") {
		exactKeys(result, "Extension Host succeeded invocation", ["payload", "state"]);
		return Object.freeze({ state: "succeeded", payload: normalizeExtensionHostPayload(result.payload) });
	}
	if (result.state === "failed") {
		exactKeys(result, "Extension Host failed invocation", ["code", "message", "state"]);
		return Object.freeze({ state: "failed", code: stringEnum(result.code, "Extension Host invocation failure code", FAILURE_CODES), message: boundedText(result.message, "Extension Host invocation failure message", 4096) });
	}
	if (result.state === "cancelled") {
		exactKeys(result, "Extension Host cancelled invocation", ["reason", "state"]);
		return Object.freeze({ state: "cancelled", reason: stringEnum(result.reason, "Extension Host cancellation reason", CANCELLATION_REASONS) });
	}
	throw new TypeError("Extension Host invocation state is invalid");
}

function normalizeCancelResult(value: unknown): void {
	const result = exactRecord(value, "Extension Host invocation cancel result", ["disposition"]);
	stringEnum(result.disposition, "Extension Host cancellation disposition", ["requested", "alreadyTerminal"] as const);
}

function normalizeJsonValue(value: unknown, owner: string, depth: number, budget: { bytes: number; nodes: number; readonly seen: Set<object> }): JsonValue {
	budget.nodes += 1;
	if (budget.nodes > MAX_PAYLOAD_NODES || depth > MAX_PAYLOAD_DEPTH) throw new RangeError(`${owner} is too complex`);
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError(`${owner} contains a non-finite number`);
		budget.bytes += 16;
		return value;
	}
	if (typeof value === "string") {
		budget.bytes += utf8Length(value);
		if (budget.bytes > MAX_PAYLOAD_BYTES) throw new RangeError(`${owner} is too large`);
		return value;
	}
	if (typeof value !== "object" || value === undefined) throw new TypeError(`${owner} must contain only JSON values`);
	if (budget.seen.has(value)) throw new TypeError(`${owner} must not contain cycles or shared object references`);
	budget.seen.add(value);
	try {
		if (Array.isArray(value)) {
			if (value.length > 8192) throw new RangeError(`${owner} array is too large`);
			return Object.freeze(value.map((entry, index) => normalizeJsonValue(entry, `${owner}[${index}]`, depth + 1, budget)));
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${owner} must contain only plain objects`);
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length > 8192) throw new RangeError(`${owner} object is too large`);
		const normalized: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
		for (const [key, entry] of entries) {
			if (key.length === 0 || key.length > 256 || key.includes("\0")) throw new TypeError(`${owner} contains an invalid key`);
			budget.bytes += utf8Length(key);
			normalized[key] = normalizeJsonValue(entry, `${owner}.${key}`, depth + 1, budget);
		}
		if (budget.bytes > MAX_PAYLOAD_BYTES) throw new RangeError(`${owner} is too large`);
		return Object.freeze(normalized);
	} finally {
		budget.seen.delete(value);
	}
}

function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
	throwIfCancelled(signal, "Extension Host invocation cancelled");
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(done, milliseconds);
		const cancel = (): void => {
			clearTimeout(timeout);
			signal.removeEventListener("abort", cancel);
			reject(new CancellationError("Extension Host invocation cancelled", signal.reason));
		};
		function done(): void {
			signal.removeEventListener("abort", cancel);
			resolve();
		}
		signal.addEventListener("abort", cancel, { once: true });
	});
}

function boundedPollInterval(value: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw new TypeError("Extension Host poll interval is invalid");
	return value;
}

function record(value: unknown, owner: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${owner} must be an object`);
	return value as Record<string, unknown>;
}

function exactRecord(value: unknown, owner: string, keys: readonly string[]): Record<string, unknown> {
	const result = record(value, owner);
	exactKeys(result, owner, keys);
	return result;
}

function exactKeys(value: Record<string, unknown>, owner: string, keys: readonly string[]): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(`${owner} has an invalid shape`);
}

function boundedArray(value: unknown, owner: string, maximum: number): readonly unknown[] {
	if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${owner} is invalid`);
	return value;
}

function boundedText(value: unknown, owner: string, maximum: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) throw new TypeError(`${owner} is invalid`);
	return value;
}

function sha256Digest(value: unknown, owner: string): string {
	const result = boundedText(value, owner, 71);
	if (!/^sha256:[0-9a-f]{64}$/u.test(result)) throw new TypeError(`${owner} is invalid`);
	return result;
}

function positiveSafeInteger(value: unknown, owner: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${owner} is invalid`);
	return value as number;
}

function boundedPositiveSafeInteger(value: unknown, owner: string, maximum: number): number {
	const result = positiveSafeInteger(value, owner);
	if (result > maximum) throw new TypeError(`${owner} is invalid`);
	return result;
}

function optionalPositiveSafeInteger(value: unknown, owner: string): number | undefined {
	return value === null ? undefined : positiveSafeInteger(value, owner);
}

function stringEnum<const T extends readonly string[]>(value: unknown, owner: string, values: T): T[number] {
	if (typeof value !== "string" || !values.includes(value)) throw new TypeError(`${owner} is invalid`);
	return value as T[number];
}

function assertUnique(values: readonly string[], owner: string): void {
	if (new Set(values).size !== values.length) throw new TypeError(`${owner} must be unique`);
}

function assertStrictlyIncreasing(values: readonly number[], owner: string): void {
	if (values.some((value, index) => index > 0 && value <= values[index - 1]!)) throw new TypeError(`${owner} must be strictly increasing`);
}

function outputChannelId(value: unknown): string {
	const result = boundedText(value, "Extension Host Output channel ID", 256);
	if (/\s/u.test(result)) throw new TypeError("Extension Host Output channel ID is invalid");
	return result;
}

function utf8Length(value: string): number {
	return VSBuffer.fromString(value).byteLength;
}
