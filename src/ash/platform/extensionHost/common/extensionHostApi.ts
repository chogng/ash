import { VSBuffer } from "../../../base/common/buffer.js";
import { throwIfCancelled } from "../../../base/common/cancellation.js";
import { CancellationError } from "../../../base/common/errors.js";
import type { AppServerConnectionState } from "../../agentHost/common/appServerApi.js";
import type { DisposableHandle } from "../../ipc/common/ipc.js";
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";
import { parseLinkPresentation, type LinkPresentationKind } from '../../dataChannel/common/dataChannel.js';

export type ExtensionHostReconcileMode = "refresh" | "restartFailed";
export type ExtensionHostRuntimeLifecycle = "dormant" | "stopped" | "starting" | "handshaking" | "ready" | "recovering" | "crashLoop" | "failed";
export type ExtensionHostFailureCode = "authorityDenied" | "staleSnapshot" | "isolationUnavailable" | "launchFailed" | "handshakeFailed" | "activationFailed" | "registrationNotFound" | "operationNotSupported" | "cancelled" | "deadlineExceeded" | "quotaExceeded" | "hostExited" | "hostRestarted" | "outcomeIndeterminate" | "crashLoop" | "invalidProtocol" | "internal";
export type ExtensionHostLanguageProviderOperation = "diagnostics" | "selectionRanges" | "documentHighlights" | "workspaceSymbols" | "completion" | "definition" | "hover" | "references" | "rename" | "formatting" | "codeAction" | "codeLens" | "documentSymbols" | "foldingRanges" | "documentLinks" | "documentColors" | "semanticTokens" | "inlayHints" | "linkedEditing" | "parameterHints";
export type ExtensionHostCancellationReason = "caller" | "deadline" | "authorityRevoked" | "shutdown";
export type ExtensionHostOutputSeverity = "trace" | "debug" | "information" | "warning" | "error" | "log";
export type ExtensionHostOutputOperation =
	| { readonly operation: "create"; readonly channelId: string; readonly label: string; readonly kind: "output" | "log"; }
	| { readonly operation: "append" | "replace"; readonly channelId: string; readonly text: string; readonly severity: ExtensionHostOutputSeverity; readonly category: string | undefined; }
	| { readonly operation: "clear" | "dispose"; readonly channelId: string; }
	| { readonly operation: "show"; readonly channelId: string; readonly preserveFocus: boolean; };
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue; };

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
	readonly icon?: string;
	readonly menus?: readonly { readonly menu: string; readonly when?: string; readonly group?: string; readonly alt?: string; }[];
}

/** Browser custom text providers render a shared document, without owning its persistence. */
export interface ExtensionHostCustomEditorRegistration extends ExtensionHostRegistrationBase {
	readonly kind: 'customTextEditor';
	readonly viewType: string;
	readonly displayName: string;
	readonly selectors: readonly string[];
	readonly languageIds?: readonly string[];
	readonly priority: 'default' | 'option';
}

export interface ExtensionHostLanguageRegistration extends ExtensionHostRegistrationBase {
	readonly kind: "languageProvider";
	readonly languageIds: readonly string[];
	readonly operations: readonly ExtensionHostLanguageProviderOperation[];
	readonly completionTriggerCharacters?: readonly string[];
}

export interface ExtensionHostDocumentEventsRegistration extends ExtensionHostRegistrationBase {
	readonly kind: 'textDocumentEvents';
}

export interface ExtensionStatusBarEntry {
	readonly id: string;
	readonly text: string;
	readonly tooltip: string | null;
	readonly ariaLabel: string | null;
	readonly alignment: 'left' | 'right';
	readonly priority: number;
	readonly command: { readonly command: string; readonly arguments: readonly JsonValue[]; } | null;
}

export interface ExtensionHostStatusBarRegistration extends ExtensionHostRegistrationBase {
	readonly kind: 'statusBar';
	readonly revision: number;
	readonly entries: readonly ExtensionStatusBarEntry[];
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

export interface ExtensionHostDataChannelRegistration extends ExtensionHostRegistrationBase {
	readonly kind: 'dataChannel';
	readonly channelId: string;
}

export interface ExtensionHostLinkPresentationRegistration extends ExtensionHostRegistrationBase {
	readonly kind: 'linkPresentationProvider';
	readonly uriPattern: string;
	readonly presentationKind: LinkPresentationKind;
}

export interface ExtensionHostExternalUriOpenerRegistration extends ExtensionHostRegistrationBase {
	readonly kind: 'externalUriOpener';
	readonly schemes: readonly ('http' | 'https')[];
	readonly label: string;
}

export type ExtensionHostRegistration = ExtensionHostStatusBarRegistration | ExtensionHostDocumentEventsRegistration | ExtensionHostCustomEditorRegistration | ExtensionHostExternalUriOpenerRegistration | ExtensionHostCommandRegistration | ExtensionHostLanguageRegistration | ExtensionHostDebugAdapterRegistration | ExtensionHostTaskProviderRegistration | ExtensionHostTestProfileProviderRegistration | ExtensionHostDataChannelRegistration | ExtensionHostLinkPresentationRegistration;

export type ExtensionHostActivationEvent = { readonly type: 'command'; readonly command: string; } | { readonly type: 'language'; readonly languageId: string; } | { readonly type: 'startupFinished'; };
export interface ExtensionHostActivationRequest {
	readonly extensionId: string;
	readonly activationGeneration: number;
	readonly event: ExtensionHostActivationEvent;
}
/** Manifest facts available while waiting; these are not process registrations. */
export interface ExtensionHostActivation {
	readonly events: readonly string[];
	readonly commands: readonly { readonly command: string; readonly title: string; }[];
}

export interface ExtensionHostRuntime {
	readonly id: string;
	readonly version: string;
	readonly packageDigest: string;
	readonly runtimeApiVersion: number;
	readonly activationGeneration: number;
	readonly incarnation: number | undefined;
	readonly lifecycle: ExtensionHostRuntimeLifecycle;
	readonly activation?: ExtensionHostActivation;
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
	registerClientHandler(handler: ExtensionClientHandler): DisposableHandle;
	isAvailable(): Promise<boolean>;
	list(): Promise<ExtensionHostFleetSnapshot>;
	reconcile(mode: ExtensionHostReconcileMode): Promise<ExtensionHostFleetSnapshot>;
	/** Asks Rust to match editor intent against one exact authorized package generation. */
	activateByEvent(request: ExtensionHostActivationRequest): Promise<ExtensionHostFleetSnapshot>;
	invoke(request: ExtensionHostInvocationRequest, signal: AbortSignal): Promise<JsonValue>;
	getConnectionState(): Promise<AppServerConnectionState>;
	onDidChange(listener: (generation: number) => void): DisposableHandle;
	onConnectionState(listener: (state: AppServerConnectionState) => void): DisposableHandle;
}

export interface ExtensionDocumentSnapshot {
	readonly uri: string;
	readonly version: number;
	readonly languageId: string;
	readonly text: string;
}

export interface ExtensionDocumentEdit {
	readonly uri: string;
	readonly version: number;
	readonly edits: { start: { line: number; character: number; }; end: { line: number; character: number; }; text: string; }[];
}

/** Window services available during a connection-owned extension invocation. */
export type ExtensionClientOperation =
	| { operation: 'setStatusBarEntries'; registrationId: string; revision: number; entries: readonly ExtensionStatusBarEntry[]; }
	| { operation: 'setDiagnostics'; collection: string; entries: ExtensionDiagnosticEntry[]; }
	| { operation: 'executeCommand'; command: string; arguments: JsonValue[]; }
	| { operation: 'readDocument'; uri: string; }
	| { operation: 'listDocuments'; }
	| { operation: 'applyEdit'; documents: ExtensionDocumentEdit[]; }
	| { operation: 'readConfiguration'; section: string; resource: string | null; }
	| { operation: 'updateConfiguration'; section: string; value: JsonValue; target: 'user' | 'workspace'; }
	| { operation: 'showMessage'; message: string; severity: 'information' | 'warning' | 'error'; }
	| { operation: 'showQuickPick'; items: string[]; placeholder: string; };

export type ExtensionClientResult =
	| { result: 'command'; value: JsonValue; }
	| { result: 'document'; document: ExtensionDocumentSnapshot; }
	| { result: 'documents'; documents: ExtensionDocumentSnapshot[]; }
	| { result: 'applied'; applied: boolean; }
	| { result: 'configuration'; value: JsonValue; }
	| { result: 'selection'; index: number | null; }
	| { result: 'done'; };

export interface ExtensionClientSource {
	readonly extensionId: string;
	readonly activationGeneration: number;
	readonly incarnation: number;
}

export interface ExtensionDiagnosticEntry {
	readonly uri: string;
	readonly version: number | null;
	readonly diagnostics: readonly {
		readonly start: { readonly line: number; readonly character: number; };
		readonly end: { readonly line: number; readonly character: number; };
		readonly message: string;
		readonly severity: 'error' | 'warning' | 'information' | 'hint';
		readonly source: string | null;
		readonly code: string | null;
	}[];
}

export type ExtensionClientHandler = (operation: ExtensionClientOperation, signal: AbortSignal, source: ExtensionClientSource) => Promise<ExtensionClientResult>;

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
const LIFECYCLES = ["dormant", "stopped", "starting", "handshaking", "ready", "recovering", "crashLoop", "failed"] as const;
const LANGUAGE_OPERATIONS = ["diagnostics", "selectionRanges", "documentHighlights", "workspaceSymbols", "completion", "definition", "hover", "references", "rename", "formatting", "codeAction", "codeLens", "documentSymbols", "foldingRanges", "documentLinks", "documentColors", "semanticTokens", "inlayHints", "linkedEditing", "parameterHints"] as const;
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
	const runtime = exactRecord(value, "Extension Host runtime", ["activationGeneration", "failure", "id", "incarnation", "lifecycle", "outputEvents", "packageDigest", "registrations", "runtimeApiVersion", "stderr", "version"], ["activation"]);
	const registrations = boundedArray(runtime.registrations, "Extension Host registrations", 2048).map(normalizeRegistration);
	const outputEvents = boundedArray(runtime.outputEvents, "Extension Host Output events", 4096).map(normalizeOutputEvent);
	if (utf8Length(JSON.stringify(outputEvents)) > MAX_OUTPUT_EVENT_BYTES) throw new RangeError("Extension Host Output event history is too large");
	assertUnique(registrations.map(registration => registration.registrationId), "Extension Host registration IDs");
	assertStrictlyIncreasing(outputEvents.map(event => event.sequence), "Extension Host Output event sequences");
	const lifecycle = stringEnum(runtime.lifecycle, "Extension Host lifecycle", LIFECYCLES);
	const incarnation = optionalPositiveSafeInteger(runtime.incarnation, "Extension Host incarnation");
	let activation: ExtensionHostActivation | undefined;
	if (runtime.activation !== undefined) {
		const facts = exactRecord(runtime.activation, 'Extension activation', ['events', 'commands']);
		const events = boundedArray(facts.events, 'Activation events', 128).map(value => boundedText(value, 'Activation event', 256));
		const commands = boundedArray(facts.commands, 'Declared commands', 2048).map(value => {
			const command = exactRecord(value, 'Declared command', ['command', 'title']);
			return Object.freeze({ command: boundedText(command.command, 'Declared command ID', 256), title: boundedText(command.title, 'Declared command title', 512) });
		});
		assertUnique(commands.map(command => command.command), 'Declared command IDs');
		activation = Object.freeze({ events: Object.freeze(events), commands: Object.freeze(commands) });
	}
	if (lifecycle === 'dormant' && (!activation || incarnation !== undefined || registrations.length || outputEvents.length || runtime.stderr !== '' || runtime.failure !== null)) { throw new TypeError('Dormant extension requires manifest facts and no process registration'); }
	if (lifecycle !== 'dormant' && activation) { throw new TypeError('Activation facts require a dormant extension'); }
	if (lifecycle === "ready" && incarnation === undefined) throw new TypeError("Ready Extension Host runtime must have an incarnation");
	return Object.freeze({
		id: boundedText(runtime.id, "Extension Host extension ID", 256),
		version: boundedText(runtime.version, "Extension Host extension version", 128),
		packageDigest: sha256Digest(runtime.packageDigest, "Extension Host package digest"),
		runtimeApiVersion: boundedPositiveSafeInteger(runtime.runtimeApiVersion, "Extension Host runtime API version", 65_535),
		activationGeneration: positiveSafeInteger(runtime.activationGeneration, "Extension Host activation generation"),
		incarnation,
		lifecycle,
		...(activation ? { activation } : {}),
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

export function normalizeExtensionStatusBarEntries(value: unknown): readonly ExtensionStatusBarEntry[] {
	const entries = boundedArray(normalizeExtensionHostPayload(value), 'Status bar entries', 128).map(value => {
		const entry = exactRecord(value, 'Status bar entry', ['id', 'text', 'tooltip', 'ariaLabel', 'alignment', 'priority', 'command']);
		if (typeof entry.priority !== 'number' || !Number.isFinite(entry.priority)) throw new TypeError('Invalid status bar priority');
		let command: ExtensionStatusBarEntry['command'] = null;
		if (entry.command !== null) {
			const input = exactRecord(entry.command, 'Status bar command', ['command', 'arguments']);
			command = Object.freeze({ command: statusBarIdentifier(input.command), arguments: Object.freeze([...boundedArray(input.arguments, 'Status bar command arguments', 1024)]) as readonly JsonValue[] });
		}
		const result = {
			id: statusBarIdentifier(entry.id), text: boundedOptionalText(entry.text, 'Status bar text', 8192),
			tooltip: entry.tooltip === null ? null : boundedOptionalText(entry.tooltip, 'Status bar tooltip', 8192),
			ariaLabel: entry.ariaLabel === null ? null : boundedOptionalText(entry.ariaLabel, 'Status bar accessible label', 8192),
			alignment: stringEnum(entry.alignment, 'Status bar alignment', ['left', 'right'] as const), priority: entry.priority, command,
		};
		if ([result.text, result.tooltip, result.ariaLabel].some(value => value !== null && utf8Length(value) > 8192)) throw new TypeError('Status bar text exceeds its UTF-8 quota');
		return Object.freeze(result);
	});
	assertUnique(entries.map(entry => entry.id), 'Status bar IDs');
	return Object.freeze(entries);
}

export function normalizeExtensionStatusBarUpdate(value: unknown): Extract<ExtensionClientOperation, { operation: 'setStatusBarEntries'; }> {
	const input = exactRecord(value, 'Status bar update', ['operation', 'registrationId', 'revision', 'entries']);
	if (input.operation !== 'setStatusBarEntries') throw new TypeError('Invalid status bar operation');
	return { operation: 'setStatusBarEntries', registrationId: statusBarIdentifier(input.registrationId), revision: positiveSafeInteger(input.revision, 'Status bar revision'), entries: normalizeExtensionStatusBarEntries(input.entries) };
}

function statusBarIdentifier(value: unknown): string {
	const id = boundedText(value, 'Status bar identifier', 256);
	if (utf8Length(id) > 256 || /[\s\p{Cc}]/u.test(id)) throw new TypeError('Invalid status bar identifier');
	return id;
}

function normalizeRegistration(value: unknown): ExtensionHostRegistration {
	const input = record(value, "Extension Host registration");
	const kind = input.kind;
	const registrationId = boundedText(input.registrationId, "Extension Host registration ID", 256);
	if (kind === 'statusBar') {
		exactKeys(input, 'Extension status bar registration', ['kind', 'registrationId', 'revision', 'entries']);
		return Object.freeze({ kind, registrationId: statusBarIdentifier(registrationId), revision: positiveSafeInteger(input.revision, 'Status bar revision'), entries: normalizeExtensionStatusBarEntries(input.entries) });
	}
	if (kind === 'textDocumentEvents') {
		exactKeys(input, 'Extension document events registration', ['kind', 'registrationId']);
		return Object.freeze({ kind, registrationId });
	}
	if (kind === 'customTextEditor') {
		exactKeys(input, 'Custom text editor registration', ['kind', 'registrationId', 'viewType', 'displayName', 'selectors', 'priority'], ['languageIds']);
		const selectors = boundedArray(input.selectors, 'Custom editor selectors', 64).map(selector => boundedText(selector, 'Custom editor selector', 512));
		const languageIds = input.languageIds === undefined ? undefined : boundedArray(input.languageIds, 'Custom editor languages', 64).map(language => boundedText(language, 'Custom editor language', 256));
		if (selectors.length === 0) {
			throw new TypeError('Custom text editor requires resource selectors');
		}
		assertUnique(selectors, 'Custom editor selectors');
		if (languageIds) {
			assertUnique(languageIds, 'Custom editor languages');
		}
		return Object.freeze({
			kind, registrationId, viewType: boundedText(input.viewType, 'Custom editor view type', 128),
			displayName: boundedText(input.displayName, 'Custom editor display name', 512), selectors: Object.freeze(selectors),
			priority: stringEnum(input.priority, 'Custom editor priority', ['default', 'option'] as const), ...(languageIds ? { languageIds: Object.freeze(languageIds) } : {})
		});
	}
	if (kind === 'externalUriOpener') {
		exactKeys(input, 'Extension Host external URI opener registration', ['kind', 'label', 'registrationId', 'schemes']);
		const schemes = boundedArray(input.schemes, 'Extension Host opener schemes', 2).map(scheme => stringEnum(scheme, 'Extension Host opener scheme', ['http', 'https'] as const));
		if (schemes.length === 0) throw new TypeError('Extension Host opener schemes must not be empty');
		assertUnique(schemes, 'Extension Host opener schemes');
		return Object.freeze({ kind, registrationId, schemes: Object.freeze(schemes), label: boundedText(input.label, 'Extension Host opener label', 512) });
	}
	if (kind === "command") {
		exactKeys(input, "Extension Host command registration", ["command", "kind", "registrationId", "title"], ['icon', 'menus']);
		const menus = input.menus === undefined ? undefined : boundedArray(input.menus, 'Extension command menus', 64).map(value => {
			const menu = exactRecord(value, 'Extension command menu', ['menu'], ['when', 'group', 'alt']);
			return Object.freeze({
				menu: boundedText(menu.menu, 'Extension command menu ID', 128),
				...(menu.when === undefined ? {} : { when: boundedText(menu.when, 'Extension menu condition', 2048) }),
				...(menu.group === undefined ? {} : { group: boundedText(menu.group, 'Extension menu group', 256) }),
				...(menu.alt === undefined ? {} : { alt: boundedText(menu.alt, 'Extension menu alternate command', 256) })
			});
		});
		return Object.freeze({
			kind, registrationId, command: boundedText(input.command, "Extension Host command", 256), title: boundedText(input.title, "Extension Host command title", 512),
			...(input.icon === undefined ? {} : { icon: boundedText(input.icon, 'Extension command icon', 128) }), ...(menus === undefined ? {} : { menus: Object.freeze(menus) })
		});
	}
	if (kind === "languageProvider") {
		exactKeys(input, "Extension Host language registration", ["kind", "languageIds", "operations", "registrationId"], ["completionTriggerCharacters"]);
		const languageIds = boundedArray(input.languageIds, "Extension Host language IDs", 64).map((languageId, index) => boundedText(languageId, `Extension Host language ID ${index}`, 256));
		const operations = boundedArray(input.operations, "Extension Host language operations", 32).map(operation => stringEnum(operation, "Extension Host language operation", LANGUAGE_OPERATIONS));
		if (languageIds.length === 0 || operations.length === 0) throw new TypeError("Extension Host language registration must not be empty");
		assertUnique(languageIds, "Extension Host language IDs");
		assertUnique(operations, "Extension Host language operations");
		const triggers = input.completionTriggerCharacters === undefined ? [] : boundedArray(input.completionTriggerCharacters, 'Completion trigger characters', 64).map(value => {
			const character = boundedText(value, 'Completion trigger character', 8);
			if ([...character].length !== 1) throw new TypeError('Completion trigger must contain one character');
			return character;
		});
		assertUnique(triggers, 'Completion trigger characters');
		if (triggers.length && !operations.includes('completion')) throw new TypeError('Completion triggers require a completion provider');
		return Object.freeze({ kind, registrationId, ...(triggers.length ? { completionTriggerCharacters: Object.freeze(triggers) } : {}), languageIds: Object.freeze(languageIds), operations: Object.freeze(operations) });
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
	if (kind === 'dataChannel') {
		exactKeys(input, 'Extension Host data channel registration', ['channelId', 'kind', 'registrationId']);
		return Object.freeze({ kind, registrationId, channelId: outputChannelId(input.channelId) });
	}
	if (kind === 'linkPresentationProvider') {
		exactKeys(input, 'Extension Host link presentation registration', ['kind', 'presentationKind', 'registrationId', 'uriPattern']);
		const uriPattern = boundedText(input.uriPattern, 'Extension Host link URI pattern', 2048);
		new RegExp(uriPattern);
		const presentationKind = parseLinkPresentation({ kind: input.presentationKind }).kind;
		return Object.freeze({ kind, registrationId, uriPattern, presentationKind });
	}
	throw new TypeError("Extension Host registration kind is invalid");
}

type ReadResult = { readonly state: "pending"; } | { readonly state: "succeeded"; readonly payload: JsonValue; } | { readonly state: "failed"; readonly code: ExtensionHostFailureCode; readonly message: string; } | { readonly state: "cancelled"; readonly reason: ExtensionHostCancellationReason; };

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

function normalizeJsonValue(value: unknown, owner: string, depth: number, budget: { bytes: number; nodes: number; readonly seen: Set<object>; }): JsonValue {
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

function exactRecord(value: unknown, owner: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
	const result = record(value, owner);
	exactKeys(result, owner, keys, optional);
	return result;
}

function exactKeys(value: Record<string, unknown>, owner: string, keys: readonly string[], optional: readonly string[] = []): void {
	const actual = Object.keys(value).filter(key => !optional.includes(key)).sort();
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
