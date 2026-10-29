import { DeferredPromise, raceCancellationError } from '../../../base/common/async.js';
import { throwIfCancelled } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { type Event } from '../../../base/common/event.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { validateRemoteConnectionResolverPrefix } from '../../remote/common/remoteConnectionService.js';
import { parseLinkPresentation } from '../../dataChannel/common/dataChannel.js';
import { ExtensionHostInvocationError } from '../common/extensionHostApi.js';
import type {
	ExtensionHostActivation,
	ExtensionHostCancellationReason,
	ExtensionHostFailureCode,
	ExtensionHostRuntimeFailure,
} from '../common/extensionHostApi.js';
import type {
	ExtensionHostFleetSnapshot,
	ExtensionHostInvocationRequest,
	ExtensionHostRuntime,
	ExtensionHostRegistration,
	ExtensionHostOutputEvent,
} from '../common/extensionHostApi.js';
import type { ExtensionStatusBarEntry, JsonValue } from '../common/extensionHostApi.js';

export interface ExtensionHostInvokeTransport {
	readonly onDidComplete: Event<string>;
	readonly onDidDisconnect: Event<Error>;
	start(request: ExtensionHostInvocationRequest): Promise<unknown>;
	read(invocationId: string): Promise<unknown>;
	cancel(invocationId: string, resultRetention: 'retain' | 'discard'): Promise<unknown>;
}

export interface ExtensionHostInvokeOptions {
	readonly now?: () => number;
}

const FAILURE_CODES = [
	'authorityDenied',
	'staleSnapshot',
	'isolationUnavailable',
	'launchFailed',
	'handshakeFailed',
	'activationFailed',
	'registrationNotFound',
	'operationNotSupported',
	'cancelled',
	'deadlineExceeded',
	'quotaExceeded',
	'hostExited',
	'hostRestarted',
	'outcomeIndeterminate',
	'crashLoop',
	'invalidProtocol',
	'internal',
] as const;
const LIFECYCLES = [
	'dormant',
	'stopped',
	'starting',
	'handshaking',
	'ready',
	'recovering',
	'crashLoop',
	'failed',
] as const;
const LANGUAGE_OPERATIONS = [
	'diagnostics',
	'selectionRanges',
	'documentHighlights',
	'workspaceSymbols',
	'completion',
	'definition',
	'hover',
	'references',
	'rename',
	'formatting',
	'codeAction',
	'codeLens',
	'documentSymbols',
	'foldingRanges',
	'documentLinks',
	'documentColors',
	'semanticTokens',
	'inlayHints',
	'linkedEditing',
	'parameterHints',
] as const;
const CANCELLATION_REASONS = ['caller', 'deadline', 'authorityRevoked', 'shutdown'] as const;
const OUTPUT_SEVERITIES = ['trace', 'debug', 'information', 'warning', 'error', 'log'] as const;
// Renderer envelopes carry both a document snapshot and a provider's render tree.
// Keep this above their combined bounded sizes; each process still enforces its
// own admitted Host RPC quota (512 KiB by default, larger for product providers).
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_EVENT_BYTES = 1024 * 1024;
const MAX_PAYLOAD_NODES = 1_000_000;
const MAX_PAYLOAD_DEPTH = 160;
const MAX_COLLECTION_ENTRIES = 262_144;

export function normalizeExtensionHostSnapshot(value: unknown): ExtensionHostFleetSnapshot {
	const snapshot = exactRecord(value, 'Extension Host snapshot', ['extensions', 'generation']);
	const extensions = boundedArray(snapshot.extensions, 'Extension Host extensions', 128).map(normalizeRuntime);
	assertUnique(
		extensions.map(extension => extension.id),
		'Extension Host extension IDs',
	);
	return Object.freeze({
		generation: positiveSafeInteger(snapshot.generation, 'Extension Host fleet generation'),
		extensions: Object.freeze(extensions),
	});
}

export function normalizeExtensionHostChanged(value: unknown): number {
	const changed = exactRecord(value, 'Extension Host changed notification', ['generation']);
	return positiveSafeInteger(changed.generation, 'Extension Host changed generation');
}

// Only this boundary's own deeply frozen output can bypass another same-realm
// normalization. A structured clone from a Worker is a new, untrusted object.
const normalizedPayloads = new WeakSet<object>();

export function normalizeExtensionHostPayload(value: unknown): JsonValue {
	if (value !== null && typeof value === 'object' && normalizedPayloads.has(value)) return value as JsonValue;
	const budget = { bytes: 0, jsonBytes: 0, nodes: 0, seen: new Set<object>(), path: [] as (string | number)[] };
	const normalized = normalizeJsonValue(value, 0, budget);
	if (budget.jsonBytes > MAX_PAYLOAD_BYTES) throw new RangeError('Extension Host payload is too large');
	if (normalized !== null && typeof normalized === 'object') normalizedPayloads.add(normalized);
	return normalized;
}

export function normalizeExtensionHostInvocationRequest(
	value: ExtensionHostInvocationRequest,
): ExtensionHostInvocationRequest {
	const request = exactRecord(
		value,
		'Extension Host invocation',
		[
			'activationGeneration',
			'deadlineUnixMillis',
			'extensionId',
			'incarnation',
			'operation',
			'payload',
			'registrationId',
		],
		['registrationGeneration'],
	);
	return Object.freeze({
		extensionId: boundedText(request.extensionId, 'Extension Host extension ID', 256),
		registrationId: boundedText(request.registrationId, 'Extension Host registration ID', 256),
		...(request.registrationGeneration === undefined
			? {}
			: {
					registrationGeneration: positiveSafeInteger(
						request.registrationGeneration,
						'Speech registration generation',
					),
				}),
		activationGeneration: positiveSafeInteger(request.activationGeneration, 'Extension Host activation generation'),
		incarnation: positiveSafeInteger(request.incarnation, 'Extension Host incarnation'),
		operation: boundedText(request.operation, 'Extension Host operation', 128),
		payload: normalizeExtensionHostPayload(request.payload),
		deadlineUnixMillis: positiveSafeInteger(request.deadlineUnixMillis, 'Extension Host invocation deadline'),
	});
}

/** Reads a connection-owned result when notified and cancels on local abandonment. */
export async function invokeExtensionHost(
	transport: ExtensionHostInvokeTransport,
	request: ExtensionHostInvocationRequest,
	signal: AbortSignal,
	options: ExtensionHostInvokeOptions = {},
): Promise<JsonValue> {
	const normalized = normalizeExtensionHostInvocationRequest(request);
	throwIfCancelled(signal, 'Extension Host invocation cancelled');
	const now = options.now ?? Date.now;
	let invocationId: string | undefined;
	let completionBeforeStart = false;
	let terminal = false;
	let abandoned = false;
	const deadline = new AbortController();
	const disconnected = new AbortController();
	const pendingSignal = AbortSignal.any([signal, deadline.signal, disconnected.signal]);
	const completed = new DeferredPromise<void>();
	const subscriptions = new DisposableStore();
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	const scheduleDeadline = () => {
		const remaining = normalized.deadlineUnixMillis - now();
		if (remaining <= 0) deadline.abort();
		else deadlineTimer = setTimeout(scheduleDeadline, Math.min(remaining, 0x7fffffff));
	};
	const discard = async (id: string) => {
		try {
			// Backend completion can outlive this caller's cleanup budget. Tell the
			// session owner to discard its result, so it releases quota on completion.
			normalizeCancelResult(
				await raceCancellationError(transport.cancel(id, 'discard'), AbortSignal.timeout(1000)),
			);
		} catch {
			/* Preserve the original failure if the connection or cancellation grace expires. */
		}
	};
	try {
		// Before the start response supplies our ID, any completion could be ours.
		// Only that race needs an initial read; otherwise wait and read the result once.
		subscriptions.add(
			transport.onDidComplete(id => {
				if (invocationId === undefined) completionBeforeStart = true;
				else if (id === invocationId) void completed.complete();
			}),
		);
		subscriptions.add(transport.onDidDisconnect(error => disconnected.abort(error)));
		scheduleDeadline();
		throwIfCancelled(pendingSignal, 'Extension Host invocation cancelled');
		const started = transport.start(normalized).then(value => {
			const result = exactRecord(value, 'Extension Host invocation start result', ['invocationId']);
			const id = boundedText(result.invocationId, 'Extension Host invocation ID', 256);
			invocationId = id;
			// Start can allocate a session after its caller has already left. The late
			// continuation still owns that identity and must retire it exactly once.
			if (abandoned) void discard(id);
			return id;
		});
		invocationId = await raceCancellationError(started, pendingSignal);
		if (!completionBeforeStart) await raceCancellationError(completed.p, pendingSignal);
		while (true) {
			throwIfCancelled(pendingSignal, 'Extension Host invocation cancelled');
			if (now() >= normalized.deadlineUnixMillis)
				throw new ExtensionHostInvocationError(
					'deadlineExceeded',
					'Extension Host invocation deadline elapsed',
				);
			const notified = completed.isSettled;
			const result = normalizeReadResult(
				await raceCancellationError(transport.read(invocationId), pendingSignal),
			);
			if (result.state === 'pending') {
				if (notified)
					throw new ExtensionHostInvocationError(
						'invalidProtocol',
						'Extension Host completion has no terminal result',
					);
				await raceCancellationError(completed.p, pendingSignal);
				continue;
			}
			terminal = true;
			if (result.state === 'succeeded') return result.payload;
			if (result.state === 'failed') throw new ExtensionHostInvocationError(result.code, result.message);
			throw new CancellationError(`Extension Host invocation cancelled: ${result.reason}`, result.reason);
		}
	} catch (error) {
		if (deadline.signal.aborted && !signal.aborted)
			throw new ExtensionHostInvocationError('deadlineExceeded', 'Extension Host invocation deadline elapsed');
		if (disconnected.signal.aborted && !signal.aborted) throw disconnected.signal.reason;
		throw error;
	} finally {
		abandoned = true;
		clearTimeout(deadlineTimer);
		subscriptions.dispose();
		if (invocationId !== undefined && !terminal) {
			await discard(invocationId);
		}
	}
}

export function normalizeExtensionHostRegistrations(value: unknown): readonly ExtensionHostRegistration[] {
	const registrations = boundedArray(value, 'Extension Host registrations', 2048).map(normalizeRegistration);
	assertUnique(
		registrations.map(registration => registration.registrationId),
		'Extension Host registration IDs',
	);
	return Object.freeze(registrations);
}

function normalizeRuntime(value: unknown): ExtensionHostRuntime {
	const runtime = exactRecord(
		value,
		'Extension Host runtime',
		[
			'activationGeneration',
			'failure',
			'id',
			'incarnation',
			'lifecycle',
			'outputEvents',
			'packageDigest',
			'registrations',
			'runtimeApiVersion',
			'stderr',
			'version',
		],
		['activation'],
	);
	const registrations = normalizeExtensionHostRegistrations(runtime.registrations);
	const outputEvents = boundedArray(runtime.outputEvents, 'Extension Host Output events', 4096).map(
		normalizeOutputEvent,
	);
	if (utf8Length(JSON.stringify(outputEvents)) > MAX_OUTPUT_EVENT_BYTES)
		throw new RangeError('Extension Host Output event history is too large');
	assertStrictlyIncreasing(
		outputEvents.map(event => event.sequence),
		'Extension Host Output event sequences',
	);
	const lifecycle = stringEnum(runtime.lifecycle, 'Extension Host lifecycle', LIFECYCLES);
	const incarnation = optionalPositiveSafeInteger(runtime.incarnation, 'Extension Host incarnation');
	let activation: ExtensionHostActivation | undefined;
	if (runtime.activation !== undefined) {
		const facts = exactRecord(runtime.activation, 'Extension activation', ['events', 'commands']);
		const events = boundedArray(facts.events, 'Activation events', 128).map(value =>
			boundedText(value, 'Activation event', 256),
		);
		const commands = boundedArray(facts.commands, 'Declared commands', 2048).map(value => {
			const command = exactRecord(value, 'Declared command', ['command', 'title']);
			return Object.freeze({
				command: boundedText(command.command, 'Declared command ID', 256),
				title: boundedText(command.title, 'Declared command title', 512),
			});
		});
		assertUnique(
			commands.map(command => command.command),
			'Declared command IDs',
		);
		activation = Object.freeze({ events: Object.freeze(events), commands: Object.freeze(commands) });
	}
	if (
		lifecycle === 'dormant' &&
		(!activation ||
			incarnation !== undefined ||
			registrations.length ||
			outputEvents.length ||
			runtime.stderr !== '' ||
			runtime.failure !== null)
	) {
		throw new TypeError('Dormant extension requires manifest facts and no process registration');
	}
	if (lifecycle !== 'dormant' && activation) {
		throw new TypeError('Activation facts require a dormant extension');
	}
	if (lifecycle === 'ready' && incarnation === undefined)
		throw new TypeError('Ready Extension Host runtime must have an incarnation');
	return Object.freeze({
		id: boundedText(runtime.id, 'Extension Host extension ID', 256),
		version: boundedText(runtime.version, 'Extension Host extension version', 128),
		packageDigest: sha256Digest(runtime.packageDigest, 'Extension Host package digest'),
		runtimeApiVersion: boundedPositiveSafeInteger(
			runtime.runtimeApiVersion,
			'Extension Host runtime API version',
			65_535,
		),
		activationGeneration: positiveSafeInteger(runtime.activationGeneration, 'Extension Host activation generation'),
		incarnation,
		lifecycle,
		...(activation ? { activation } : {}),
		failure: runtime.failure === null ? undefined : normalizeFailure(runtime.failure),
		stderr: boundedOptionalText(runtime.stderr, 'Extension Host stderr', 262_144),
		outputEvents: Object.freeze(outputEvents),
		registrations: Object.freeze(registrations),
	});
}

function normalizeOutputEvent(value: unknown): ExtensionHostOutputEvent {
	const input = record(value, 'Extension Host Output event');
	const operation = input.operation;
	const sequence = positiveSafeInteger(input.sequence, 'Extension Host Output event sequence');
	const incarnation = positiveSafeInteger(input.incarnation, 'Extension Host Output event incarnation');
	const activationGeneration = positiveSafeInteger(
		input.activationGeneration,
		'Extension Host Output event activation generation',
	);
	const channelId = outputChannelId(input.channelId);
	if (operation === 'create') {
		exactKeys(input, 'Extension Host Output create event', [
			'activationGeneration',
			'channelId',
			'incarnation',
			'kind',
			'label',
			'operation',
			'sequence',
		]);
		return Object.freeze({
			sequence,
			incarnation,
			activationGeneration,
			operation: Object.freeze({
				operation,
				channelId,
				label: boundedText(input.label, 'Extension Host Output channel label', 512),
				kind: stringEnum(input.kind, 'Extension Host Output channel kind', ['output', 'log'] as const),
			}),
		});
	}
	if (operation === 'append' || operation === 'replace') {
		exactKeys(input, `Extension Host Output ${operation} event`, [
			'activationGeneration',
			'category',
			'channelId',
			'incarnation',
			'operation',
			'sequence',
			'severity',
			'text',
		]);
		const category =
			input.category === null ? undefined : boundedText(input.category, 'Extension Host Output category', 128);
		return Object.freeze({
			sequence,
			incarnation,
			activationGeneration,
			operation: Object.freeze({
				operation,
				channelId,
				text: boundedOptionalText(input.text, 'Extension Host Output text', 524_288),
				severity: stringEnum(input.severity, 'Extension Host Output severity', OUTPUT_SEVERITIES),
				category,
			}),
		});
	}
	if (operation === 'clear' || operation === 'dispose') {
		exactKeys(input, `Extension Host Output ${operation} event`, [
			'activationGeneration',
			'channelId',
			'incarnation',
			'operation',
			'sequence',
		]);
		return Object.freeze({
			sequence,
			incarnation,
			activationGeneration,
			operation: Object.freeze({ operation, channelId }),
		});
	}
	if (operation === 'show') {
		exactKeys(input, 'Extension Host Output show event', [
			'activationGeneration',
			'channelId',
			'incarnation',
			'operation',
			'preserveFocus',
			'sequence',
		]);
		if (typeof input.preserveFocus !== 'boolean')
			throw new TypeError('Extension Host Output preserve-focus flag is invalid');
		return Object.freeze({
			sequence,
			incarnation,
			activationGeneration,
			operation: Object.freeze({ operation, channelId, preserveFocus: input.preserveFocus }),
		});
	}
	throw new TypeError('Extension Host Output operation is invalid');
}

function boundedOptionalText(value: unknown, owner: string, maximumLength: number): string {
	if (typeof value !== 'string') throw new TypeError(`${owner} must be a string`);
	if (value.length > maximumLength || value.includes('\0')) throw new RangeError(`${owner} is invalid`);
	return value;
}

function normalizeFailure(value: unknown): ExtensionHostRuntimeFailure {
	const failure = exactRecord(value, 'Extension Host failure', ['code', 'incarnation', 'message']);
	return Object.freeze({
		code: stringEnum(failure.code, 'Extension Host failure code', FAILURE_CODES),
		message: boundedText(failure.message, 'Extension Host failure message', 4096),
		incarnation: optionalPositiveSafeInteger(failure.incarnation, 'Extension Host failure incarnation'),
	});
}

export function normalizeExtensionStatusBarEntries(value: unknown): readonly ExtensionStatusBarEntry[] {
	const entries = boundedArray(normalizeExtensionHostPayload(value), 'Status bar entries', 128).map(value => {
		const entry = exactRecord(value, 'Status bar entry', [
			'id',
			'text',
			'tooltip',
			'ariaLabel',
			'alignment',
			'priority',
			'command',
		]);
		if (typeof entry.priority !== 'number' || !Number.isFinite(entry.priority))
			throw new TypeError('Invalid status bar priority');
		let command: ExtensionStatusBarEntry['command'] = null;
		if (entry.command !== null) {
			const input = exactRecord(entry.command, 'Status bar command', ['command', 'arguments']);
			command = Object.freeze({
				command: statusBarIdentifier(input.command),
				arguments: Object.freeze([
					...boundedArray(input.arguments, 'Status bar command arguments', 1024),
				]) as readonly JsonValue[],
			});
		}
		const result = {
			id: statusBarIdentifier(entry.id),
			text: boundedOptionalText(entry.text, 'Status bar text', 8192),
			tooltip: entry.tooltip === null ? null : boundedOptionalText(entry.tooltip, 'Status bar tooltip', 8192),
			ariaLabel:
				entry.ariaLabel === null
					? null
					: boundedOptionalText(entry.ariaLabel, 'Status bar accessible label', 8192),
			alignment: stringEnum(entry.alignment, 'Status bar alignment', ['left', 'right'] as const),
			priority: entry.priority,
			command,
		};
		if ([result.text, result.tooltip, result.ariaLabel].some(value => value !== null && utf8Length(value) > 8192))
			throw new TypeError('Status bar text exceeds its UTF-8 quota');
		return Object.freeze(result);
	});
	assertUnique(
		entries.map(entry => entry.id),
		'Status bar IDs',
	);
	return Object.freeze(entries);
}

export function normalizeExtensionStatusBarUpdate(value: unknown): {
	operation: 'setStatusBarEntries';
	registrationId: string;
	revision: number;
	entries: readonly ExtensionStatusBarEntry[];
} {
	const input = exactRecord(value, 'Status bar update', ['operation', 'registrationId', 'revision', 'entries']);
	if (input.operation !== 'setStatusBarEntries') throw new TypeError('Invalid status bar operation');
	return {
		operation: 'setStatusBarEntries',
		registrationId: statusBarIdentifier(input.registrationId),
		revision: positiveSafeInteger(input.revision, 'Status bar revision'),
		entries: normalizeExtensionStatusBarEntries(input.entries),
	};
}

function statusBarIdentifier(value: unknown): string {
	const id = boundedText(value, 'Status bar identifier', 256);
	if (utf8Length(id) > 256 || /[\s\p{Cc}]/u.test(id)) throw new TypeError('Invalid status bar identifier');
	return id;
}

function normalizeRegistration(value: unknown): ExtensionHostRegistration {
	const input = record(value, 'Extension Host registration');
	const kind = input.kind;
	const registrationId = boundedText(input.registrationId, 'Extension Host registration ID', 256);
	if (kind === 'remoteAuthorityResolver' || kind === 'remoteConnectionResolver') {
		exactKeys(input, 'Remote resolver registration', ['kind', 'registrationId', 'authorityPrefix']);
		const authorityPrefix = validateRemoteConnectionResolverPrefix(
			boundedText(input.authorityPrefix, 'Remote prefix', 64),
		);
		return Object.freeze({ kind, registrationId, authorityPrefix });
	}
	if (kind === 'sourceControl') {
		return Object.freeze({
			kind,
			registrationId,
			revision: positiveSafeInteger(input.revision, 'SCM revision'),
			providers: boundedArray(input.providers, 'SCM providers', 128).map(normalizeExtensionHostPayload),
		});
	}
	if (kind === 'statusBar') {
		exactKeys(input, 'Extension status bar registration', ['kind', 'registrationId', 'revision', 'entries']);
		return Object.freeze({
			kind,
			registrationId: statusBarIdentifier(registrationId),
			revision: positiveSafeInteger(input.revision, 'Status bar revision'),
			entries: normalizeExtensionStatusBarEntries(input.entries),
		});
	}
	if (
		kind === 'outputEvents' ||
		kind === 'workspaceEvents' ||
		kind === 'textDocumentEvents' ||
		kind === 'taskEvents' ||
		kind === 'debugEvents'
	) {
		exactKeys(input, 'Extension document events registration', ['kind', 'registrationId']);
		return Object.freeze({ kind, registrationId });
	}
	if (kind === 'customTextEditor') {
		exactKeys(
			input,
			'Custom text editor registration',
			['kind', 'registrationId', 'viewType', 'displayName', 'selectors', 'priority'],
			['languageIds'],
		);
		const selectors = boundedArray(input.selectors, 'Custom editor selectors', 64).map(selector =>
			boundedText(selector, 'Custom editor selector', 512),
		);
		const languageIds =
			input.languageIds === undefined
				? undefined
				: boundedArray(input.languageIds, 'Custom editor languages', 64).map(language =>
						boundedText(language, 'Custom editor language', 256),
					);
		if (selectors.length === 0) {
			throw new TypeError('Custom text editor requires resource selectors');
		}
		assertUnique(selectors, 'Custom editor selectors');
		if (languageIds) {
			assertUnique(languageIds, 'Custom editor languages');
		}
		return Object.freeze({
			kind,
			registrationId,
			viewType: boundedText(input.viewType, 'Custom editor view type', 128),
			displayName: boundedText(input.displayName, 'Custom editor display name', 512),
			selectors: Object.freeze(selectors),
			priority: stringEnum(input.priority, 'Custom editor priority', ['default', 'option'] as const),
			...(languageIds ? { languageIds: Object.freeze(languageIds) } : {}),
		});
	}
	if (kind === 'externalUriOpener') {
		exactKeys(input, 'Extension Host external URI opener registration', [
			'kind',
			'label',
			'registrationId',
			'schemes',
		]);
		const schemes = boundedArray(input.schemes, 'Extension Host opener schemes', 2).map(scheme =>
			stringEnum(scheme, 'Extension Host opener scheme', ['http', 'https'] as const),
		);
		if (schemes.length === 0) throw new TypeError('Extension Host opener schemes must not be empty');
		assertUnique(schemes, 'Extension Host opener schemes');
		return Object.freeze({
			kind,
			registrationId,
			schemes: Object.freeze(schemes),
			label: boundedText(input.label, 'Extension Host opener label', 512),
		});
	}
	if (kind === 'command') {
		exactKeys(
			input,
			'Extension Host command registration',
			['command', 'kind', 'registrationId', 'title'],
			['category', 'enablement', 'icon', 'menus'],
		);
		const menus =
			input.menus === undefined
				? undefined
				: boundedArray(input.menus, 'Extension command menus', 64).map(value => {
						const menu = exactRecord(value, 'Extension command menu', ['menu'], ['when', 'group', 'alt']);
						return Object.freeze({
							menu: boundedText(menu.menu, 'Extension command menu ID', 128),
							...(menu.when === undefined
								? {}
								: { when: boundedText(menu.when, 'Extension menu condition', 2048) }),
							...(menu.group === undefined
								? {}
								: { group: boundedText(menu.group, 'Extension menu group', 256) }),
							...(menu.alt === undefined
								? {}
								: { alt: boundedText(menu.alt, 'Extension menu alternate command', 256) }),
						});
					});
		return Object.freeze({
			kind,
			registrationId,
			command: boundedText(input.command, 'Extension Host command', 256),
			title: boundedText(input.title, 'Extension Host command title', 512),
			...(input.category === undefined
				? {}
				: { category: boundedText(input.category, 'Extension command category', 512) }),
			...(input.enablement === undefined
				? {}
				: { enablement: boundedText(input.enablement, 'Extension command enablement', 2048) }),
			...(input.icon === undefined ? {} : { icon: boundedText(input.icon, 'Extension command icon', 128) }),
			...(menus === undefined ? {} : { menus: Object.freeze(menus) }),
		});
	}
	if (kind === 'languageProvider') {
		exactKeys(
			input,
			'Extension Host language registration',
			['kind', 'languageIds', 'operations', 'registrationId'],
			['completionTriggerCharacters'],
		);
		const languageIds = boundedArray(input.languageIds, 'Extension Host language IDs', 64).map(
			(languageId, index) => boundedText(languageId, `Extension Host language ID ${index}`, 256),
		);
		const operations = boundedArray(input.operations, 'Extension Host language operations', 32).map(operation =>
			stringEnum(operation, 'Extension Host language operation', LANGUAGE_OPERATIONS),
		);
		if (languageIds.length === 0 || operations.length === 0)
			throw new TypeError('Extension Host language registration must not be empty');
		assertUnique(languageIds, 'Extension Host language IDs');
		assertUnique(operations, 'Extension Host language operations');
		const triggers =
			input.completionTriggerCharacters === undefined
				? []
				: boundedArray(input.completionTriggerCharacters, 'Completion trigger characters', 64).map(value => {
						const character = boundedText(value, 'Completion trigger character', 8);
						if ([...character].length !== 1)
							throw new TypeError('Completion trigger must contain one character');
						return character;
					});
		assertUnique(triggers, 'Completion trigger characters');
		if (triggers.length && !operations.includes('completion'))
			throw new TypeError('Completion triggers require a completion provider');
		return Object.freeze({
			kind,
			registrationId,
			...(triggers.length ? { completionTriggerCharacters: Object.freeze(triggers) } : {}),
			languageIds: Object.freeze(languageIds),
			operations: Object.freeze(operations),
		});
	}
	if (kind === 'debugAdapter') {
		exactKeys(input, 'Extension Host Debug Adapter registration', ['debuggerType', 'kind', 'registrationId']);
		return Object.freeze({
			kind,
			registrationId,
			debuggerType: boundedText(input.debuggerType, 'Extension Host Debug Adapter type', 256),
		});
	}
	if (kind === 'debugAdapterTracker') {
		exactKeys(input, 'Extension Host Debug Adapter tracker', ['debuggerType', 'kind', 'registrationId']);
		return Object.freeze({
			kind,
			registrationId,
			debuggerType: boundedText(input.debuggerType, 'Extension Host Debug Adapter tracker type', 256),
		});
	}
	if (kind === 'debugConfigurationProvider') {
		exactKeys(input, 'Extension Host Debug configuration provider', [
			'debuggerType',
			'kind',
			'registrationId',
			'triggerKind',
		]);
		if (input.triggerKind !== 1 && input.triggerKind !== 2)
			throw new TypeError('Invalid Debug configuration trigger kind');
		return Object.freeze({
			kind,
			registrationId,
			debuggerType: boundedText(input.debuggerType, 'Extension Host Debug configuration type', 256),
			triggerKind: input.triggerKind,
		});
	}
	if (kind === 'terminalProfileProvider') {
		exactKeys(input, 'Extension Host terminal profile registration', [
			'kind',
			'registrationId',
			'profileId',
			'title',
		]);
		return Object.freeze({
			kind,
			registrationId,
			profileId: boundedText(input.profileId, 'Terminal profile ID', 256),
			title: boundedText(input.title, 'Terminal profile title', 512),
		});
	}
	if (kind === 'terminalPty') {
		exactKeys(input, 'Extension Host terminal PTY resource', ['kind', 'registrationId']);
		return Object.freeze({ kind, registrationId });
	}
	if (kind === 'terminalCompletionProvider') {
		exactKeys(input, 'Extension Host terminal completion registration', [
			'kind',
			'registrationId',
			'triggerCharacters',
		]);
		const triggerCharacters = boundedArray(input.triggerCharacters, 'Terminal completion triggers', 64).map(
			value => {
				const character = boundedText(value, 'Terminal completion trigger', 8);
				if ([...character].length !== 1 || /[\x00-\x1f\x7f]/.test(character))
					throw new TypeError('Invalid terminal completion trigger');
				return character;
			},
		);
		assertUnique(triggerCharacters, 'Terminal completion triggers');
		return Object.freeze({ kind, registrationId, triggerCharacters: Object.freeze(triggerCharacters) });
	}
	if (kind === 'terminalQuickFixProvider') {
		exactKeys(input, 'Extension Host terminal quick fix registration', ['kind', 'registrationId', 'providerId']);
		return Object.freeze({
			kind,
			registrationId,
			providerId: boundedText(input.providerId, 'Terminal quick fix provider ID', 256),
		});
	}
	if (kind === 'terminalLinkProvider') {
		exactKeys(input, 'Extension Host terminal link registration', ['kind', 'registrationId']);
		return Object.freeze({ kind, registrationId });
	}
	if (kind === 'terminalEnvironment') {
		exactKeys(input, 'Extension Host terminal environment registration', ['kind', 'registrationId']);
		return Object.freeze({ kind, registrationId });
	}
	if (kind === 'taskProvider') {
		exactKeys(input, 'Extension Host Task provider registration', ['kind', 'registrationId', 'taskType']);
		return Object.freeze({
			kind,
			registrationId,
			taskType: boundedText(input.taskType, 'Extension Host Task type', 256),
		});
	}
	if (kind === 'testProfileProvider') {
		exactKeys(input, 'Extension Host Test Profile provider registration', [
			'kind',
			'label',
			'providerId',
			'registrationId',
		]);
		return Object.freeze({
			kind,
			registrationId,
			providerId: boundedText(input.providerId, 'Extension Host Test Profile provider ID', 256),
			label: boundedText(input.label, 'Extension Host Test Profile provider label', 512),
		});
	}
	if (kind === 'treeDataProvider') {
		exactKeys(
			input,
			'Extension Host tree registration',
			['kind', 'registrationId', 'viewId', 'title'],
			['containerId'],
		);
		const viewId = boundedText(input.viewId, 'Tree view ID', 128);
		const containerId =
			input.containerId === undefined ? undefined : boundedText(input.containerId, 'Tree container ID', 128);
		if (![viewId, containerId].every(value => value === undefined || /^[A-Za-z][A-Za-z0-9._-]*$/u.test(value))) {
			throw new TypeError('Invalid tree view or container ID');
		}
		return Object.freeze({
			kind,
			registrationId,
			viewId,
			title: boundedText(input.title, 'Tree title', 512),
			...(containerId === undefined ? {} : { containerId }),
		});
	}
	if (kind === 'speechProvider') {
		exactKeys(input, 'Extension Host speech registration', [
			'kind',
			'registrationId',
			'identifier',
			'registrationGeneration',
		]);
		const identifier = boundedText(input.identifier, 'Speech provider identifier', 256);
		if (/\s/u.test(identifier)) throw new TypeError('Invalid Speech provider identifier');
		return Object.freeze({
			kind,
			registrationId,
			identifier,
			registrationGeneration: positiveSafeInteger(input.registrationGeneration, 'Speech registration generation'),
		});
	}
	if (kind === 'dataChannel') {
		exactKeys(input, 'Extension Host data channel registration', ['channelId', 'kind', 'registrationId']);
		return Object.freeze({ kind, registrationId, channelId: outputChannelId(input.channelId) });
	}
	if (kind === 'linkPresentationProvider') {
		exactKeys(input, 'Extension Host link presentation registration', [
			'kind',
			'presentationKind',
			'registrationId',
			'uriPattern',
		]);
		const uriPattern = boundedText(input.uriPattern, 'Extension Host link URI pattern', 2048);
		new RegExp(uriPattern);
		const presentationKind = parseLinkPresentation({ kind: input.presentationKind }).kind;
		return Object.freeze({ kind, registrationId, uriPattern, presentationKind });
	}
	throw new TypeError('Extension Host registration kind is invalid');
}

type ReadResult =
	| { readonly state: 'pending' }
	| { readonly state: 'succeeded'; readonly payload: JsonValue }
	| { readonly state: 'failed'; readonly code: ExtensionHostFailureCode; readonly message: string }
	| { readonly state: 'cancelled'; readonly reason: ExtensionHostCancellationReason };

function normalizeReadResult(value: unknown): ReadResult {
	const result = record(value, 'Extension Host invocation read result');
	if (result.state === 'pending') {
		exactKeys(result, 'Extension Host pending invocation', ['state']);
		return Object.freeze({ state: 'pending' });
	}
	if (result.state === 'succeeded') {
		exactKeys(result, 'Extension Host succeeded invocation', ['payload', 'state']);
		return Object.freeze({ state: 'succeeded', payload: normalizeExtensionHostPayload(result.payload) });
	}
	if (result.state === 'failed') {
		exactKeys(result, 'Extension Host failed invocation', ['code', 'message', 'state']);
		return Object.freeze({
			state: 'failed',
			code: stringEnum(result.code, 'Extension Host invocation failure code', FAILURE_CODES),
			message: boundedText(result.message, 'Extension Host invocation failure message', 4096),
		});
	}
	if (result.state === 'cancelled') {
		exactKeys(result, 'Extension Host cancelled invocation', ['reason', 'state']);
		return Object.freeze({
			state: 'cancelled',
			reason: stringEnum(result.reason, 'Extension Host cancellation reason', CANCELLATION_REASONS),
		});
	}
	throw new TypeError('Extension Host invocation state is invalid');
}

function normalizeCancelResult(value: unknown): void {
	const result = exactRecord(value, 'Extension Host invocation cancel result', ['disposition']);
	stringEnum(result.disposition, 'Extension Host cancellation disposition', [
		'requested',
		'alreadyTerminal',
	] as const);
}

function normalizeJsonValue(
	value: unknown,
	depth: number,
	budget: {
		bytes: number;
		jsonBytes: number;
		nodes: number;
		readonly seen: Set<object>;
		readonly path: (string | number)[];
	},
): JsonValue {
	budget.nodes += 1;
	if (budget.nodes > MAX_PAYLOAD_NODES || depth > MAX_PAYLOAD_DEPTH)
		throw new RangeError(`${jsonValuePath(budget.path)} is too complex`);
	if (value === null || typeof value === 'boolean') {
		budget.jsonBytes += value === null || value === true ? 4 : 5;
		return value;
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new TypeError(`${jsonValuePath(budget.path)} contains a non-finite number`);
		budget.bytes += 16;
		budget.jsonBytes += String(value).length;
		return value;
	}
	if (typeof value === 'string') {
		budget.bytes += utf8Length(value);
		budget.jsonBytes += jsonStringLength(value);
		if (budget.bytes > MAX_PAYLOAD_BYTES) throw new RangeError(`${jsonValuePath(budget.path)} is too large`);
		return value;
	}
	if (typeof value !== 'object' || value === undefined)
		throw new TypeError(`${jsonValuePath(budget.path)} must contain only JSON values`);
	if (budget.seen.has(value))
		throw new TypeError(`${jsonValuePath(budget.path)} must not contain cycles or shared object references`);
	budget.seen.add(value);
	try {
		if (Array.isArray(value)) {
			if (value.length > MAX_COLLECTION_ENTRIES)
				throw new RangeError(`${jsonValuePath(budget.path)} array is too large`);
			budget.jsonBytes += 2 + Math.max(0, value.length - 1);
			for (let index = 0; index < value.length; index++) if (!(index in value)) budget.jsonBytes += 4;
			const normalized = Object.freeze(
				value.map((entry, index) => {
					budget.path.push(index);
					const normalized = normalizeJsonValue(entry, depth + 1, budget);
					budget.path.pop();
					return normalized;
				}),
			);
			return normalized;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null)
			throw new TypeError(`${jsonValuePath(budget.path)} must contain only plain objects`);
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length > MAX_COLLECTION_ENTRIES)
			throw new RangeError(`${jsonValuePath(budget.path)} object is too large`);
		budget.jsonBytes += 2 + Math.max(0, entries.length - 1);
		const normalized: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
		for (const [key, entry] of entries) {
			if (key.length === 0 || key.length > 256 || key.includes('\0'))
				throw new TypeError(`${jsonValuePath(budget.path)} contains an invalid key`);
			budget.bytes += utf8Length(key);
			budget.jsonBytes += jsonStringLength(key) + 1;
			budget.path.push(key);
			normalized[key] = normalizeJsonValue(entry, depth + 1, budget);
			budget.path.pop();
		}
		if (budget.bytes > MAX_PAYLOAD_BYTES) throw new RangeError(`${jsonValuePath(budget.path)} is too large`);
		Object.freeze(normalized);
		return normalized;
	} finally {
		budget.seen.delete(value);
	}
}

// Build diagnostic paths only for rejected input, rather than allocating one
// string per property in a large, valid document/render-tree envelope.
function jsonValuePath(path: readonly (string | number)[]): string {
	return 'Extension Host payload' + path.map(part => (typeof part === 'number' ? `[${part}]` : `.${part}`)).join('');
}

function record(value: unknown, owner: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new TypeError(`${owner} must be an object`);
	return value as Record<string, unknown>;
}

function exactRecord(
	value: unknown,
	owner: string,
	keys: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	const result = record(value, owner);
	exactKeys(result, owner, keys, optional);
	return result;
}

function exactKeys(
	value: Record<string, unknown>,
	owner: string,
	keys: readonly string[],
	optional: readonly string[] = [],
): void {
	const actual = Object.keys(value)
		.filter(key => !optional.includes(key))
		.sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
		throw new TypeError(`${owner} has an invalid shape`);
}

function boundedArray(value: unknown, owner: string, maximum: number): readonly unknown[] {
	if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${owner} is invalid`);
	return value;
}

function boundedText(value: unknown, owner: string, maximum: number): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0'))
		throw new TypeError(`${owner} is invalid`);
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
	if (typeof value !== 'string' || !values.includes(value)) throw new TypeError(`${owner} is invalid`);
	return value as T[number];
}

function assertUnique(values: readonly string[], owner: string): void {
	if (new Set(values).size !== values.length) throw new TypeError(`${owner} must be unique`);
}

function assertStrictlyIncreasing(values: readonly number[], owner: string): void {
	if (values.some((value, index) => index > 0 && value <= values[index - 1]!))
		throw new TypeError(`${owner} must be strictly increasing`);
}

function outputChannelId(value: unknown): string {
	const result = boundedText(value, 'Extension Host Output channel ID', 256);
	if (/\s/u.test(result)) throw new TypeError('Extension Host Output channel ID is invalid');
	return result;
}

function utf8Length(value: string): number {
	let length = value.length;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0x80) continue;
		if (code < 0x800) length++;
		else if (
			code >= 0xd800 &&
			code <= 0xdbff &&
			index + 1 < value.length &&
			value.charCodeAt(index + 1) >= 0xdc00 &&
			value.charCodeAt(index + 1) <= 0xdfff
		) {
			length += 2;
			index++;
		} else length += 2;
	}
	return length;
}

/** UTF-8 bytes on the JSON wire, including escapes and lone-surrogate escaping.
 * Counting during normalization avoids a second full tree serialization and buffer.
 */
function jsonStringLength(value: string): number {
	let length = 2;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code === 0x22 || code === 0x5c) length += 2;
		else if (code < 0x20) length += code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
		else if (code < 0x80) length++;
		else if (code < 0x800) length += 2;
		else if (
			code >= 0xd800 &&
			code <= 0xdbff &&
			index + 1 < value.length &&
			value.charCodeAt(index + 1) >= 0xdc00 &&
			value.charCodeAt(index + 1) <= 0xdfff
		) {
			length += 4;
			index++;
		} else length += code >= 0xd800 && code <= 0xdfff ? 6 : 3;
	}
	return length;
}
