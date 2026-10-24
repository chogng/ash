import assert from "node:assert/strict";
import { test } from "mocha";
import { CancellationError } from "../../../../base/common/errors.js";
import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ExtensionHostInvocationError } from '../../common/extensionHostApi.js';
import { invokeExtensionHost, normalizeExtensionHostPayload, normalizeExtensionHostSnapshot } from '../../browser/extensionHostProtocol.js';
import { type ExtensionHostInvocationRequest, type JsonValue } from '../../common/extensionHostApi.js';

const DIGEST = `sha256:${"a".repeat(64)}`;
ensureNoDisposablesAreLeakedInTestSuite();

test("normalizes one exact isolated Extension Host fleet snapshot", () => {
	const snapshot = normalizeExtensionHostSnapshot({
		generation: 7,
		extensions: [{
			id: "acme.demo",
			version: "1.0.0",
			packageDigest: DIGEST,
			runtimeApiVersion: 1,
			activationGeneration: 3,
			incarnation: 2,
			lifecycle: "ready",
			failure: null,
			stderr: "extension diagnostic\n",
			outputEvents: [
				{ sequence: 4, incarnation: 2, activationGeneration: 3, operation: "create", channelId: "review", label: "Review", kind: "log" },
				{ sequence: 5, incarnation: 2, activationGeneration: 3, operation: "append", channelId: "review", text: "ready\n", severity: "information", category: "lifecycle" },
			],
			registrations: [
				{ registrationId: "commands", kind: "command", command: "acme.run", title: "Run" },
				{ registrationId: "language", kind: "languageProvider", languageIds: ["typescript"], operations: ["completion", "hover"], completionTriggerCharacters: ['.', '😀'] },
				{ registrationId: "tests", kind: "testProfileProvider", providerId: "acme.tests", label: "Acme Tests" },
				{ registrationId: 'documents', kind: 'textDocumentEvents' },
				{ registrationId: 'debugConfigurations', kind: 'debugConfigurationProvider', debuggerType: 'example', triggerKind: 2 },
				{ registrationId: 'window', kind: 'workspaceEvents' },
				{ registrationId: 'remote:team', kind: 'remoteConnectionResolver', authorityPrefix: 'team' },
				{ registrationId: 'terminalLinks', kind: 'terminalLinkProvider' },
				{ registrationId: 'issued.1', kind: 'terminalPty' },
			],
		}],
	});

	assert.equal(snapshot.generation, 7);
	assert.equal(snapshot.extensions[0]?.activationGeneration, 3);
	assert.equal(snapshot.extensions[0]?.registrations[2]?.kind, "testProfileProvider");
	assert.equal(snapshot.extensions[0]?.stderr, "extension diagnostic\n");
	assert.equal(snapshot.extensions[0]?.outputEvents[1]?.operation.operation, "append");
	assert.equal(Object.isFrozen(snapshot.extensions[0]?.registrations), true);
	assert.deepEqual(snapshot.extensions[0]?.registrations[3], { registrationId: 'documents', kind: 'textDocumentEvents' });
	assert.deepEqual(snapshot.extensions[0]?.registrations[4], { registrationId: 'debugConfigurations', kind: 'debugConfigurationProvider', debuggerType: 'example', triggerKind: 2 });
	assert.deepEqual(snapshot.extensions[0]?.registrations[5], { registrationId: 'window', kind: 'workspaceEvents' });
	assert.deepEqual(snapshot.extensions[0]?.registrations[6], { registrationId: 'remote:team', kind: 'remoteConnectionResolver', authorityPrefix: 'team' });
	assert.deepEqual(snapshot.extensions[0]?.registrations[7], { registrationId: 'terminalLinks', kind: 'terminalLinkProvider' });
	assert.deepEqual(snapshot.extensions[0]?.registrations[8], { registrationId: 'issued.1', kind: 'terminalPty' });
	assert.throws(() => normalizeExtensionHostSnapshot({
		generation: 8,
		extensions: [{ ...snapshot.extensions[0], outputEvents: [], registrations: [{ registrationId: 'issued.1', kind: 'terminalPty', profileId: 'forged' }] }],
	}), TypeError);
	const language = snapshot.extensions[0]!.registrations[1]!;
	assert.ok(language.kind === 'languageProvider');
	assert.deepEqual(language.completionTriggerCharacters, ['.', '😀']);
	assert.equal(Object.isFrozen(language.completionTriggerCharacters), true);
});

test("rejects malformed fleet authority and oversized JSON payloads", () => {
	assert.throws(() => normalizeExtensionHostSnapshot({ generation: 1, extensions: [{ id: "bad", version: "1", packageDigest: DIGEST, runtimeApiVersion: 1, activationGeneration: 0, incarnation: 1, lifecycle: "ready", failure: null, stderr: "", outputEvents: [], registrations: [] }] }), /activation generation/);
	assert.throws(() => normalizeExtensionHostSnapshot({ generation: 1, extensions: [{ id: "bad", version: "1", packageDigest: DIGEST, runtimeApiVersion: 1, activationGeneration: 1, incarnation: null, lifecycle: "ready", failure: null, stderr: "", outputEvents: [], registrations: [] }] }), /must have an incarnation/);
	const maximum = normalizeExtensionHostPayload("x".repeat(64 * 1024 * 1024 - 2));
	assert.equal(typeof maximum === "string" ? maximum.length : -1, 64 * 1024 * 1024 - 2);
	assert.throws(() => normalizeExtensionHostPayload("x".repeat(64 * 1024 * 1024 - 1)), /too large/);
});

test('large document envelopes retain bounded wide/deep trees, Unicode and JSON validation', () => {
	const text = '\uFEFF中文😀\r\n'.repeat(100000);
	let nested: unknown = { text };
	for (let depth = 0; depth < 96; depth++) nested = { children: [nested] };
	// A depth above 160 remains invalid; rendering trees legitimately exceed the old 64.
	assert.throws(() => normalizeExtensionHostPayload(nested), /too complex/);
	nested = { text };
	for (let depth = 0; depth < 40; depth++) nested = { children: [nested] };
	const tree = Array.from({ length: 10000 }, (_, index) => ({ start: index, content: { kind: 'text', value: '中文😀' } }));
	const value = normalizeExtensionHostPayload({ document: { text }, tree, nested }) as { document: { text: string; }; tree: readonly unknown[]; };
	assert.equal(value.document.text, text);
	assert.equal(value.tree.length, 10000);
	assert.equal(Object.isFrozen(value.tree), true);
	assert.throws(() => normalizeExtensionHostPayload(Array(262145).fill(null)), /array is too large/);
	assert.throws(() => normalizeExtensionHostPayload({ value: NaN }), /non-finite/);
	const cycle: { self?: unknown; } = {}; cycle.self = cycle;
	assert.throws(() => normalizeExtensionHostPayload(cycle), /cycles/);
});

test("completion during a pending read wakes a fenced invocation without polling", async () => {
	using completed = new Emitter<string>();
	const requests: ExtensionHostInvocationRequest[] = [];
	let reads = 0;
	let cancels = 0;
	const result = await invokeExtensionHost({
		onDidComplete: completed.event,
		onDidDisconnect: Event.None,
		start: async request => { completed.fire('another-call'); requests.push(request); return { invocationId: "invoke-1" }; },
		read: async invocationId => {
			assert.equal(invocationId, "invoke-1");
			if (++reads === 1) { completed.fire(invocationId); return { state: "pending" }; }
			return { state: "succeeded", payload: { ok: true } };
		},
		cancel: async () => { cancels += 1; return { disposition: "alreadyTerminal" }; },
	}, invocation(), new AbortController().signal, { now: () => 100 });

	assert.equal(typeof result === "object" && result !== null && !Array.isArray(result) ? (result as { readonly ok?: JsonValue; }).ok : undefined, true);
	assert.equal(requests[0]?.activationGeneration, 4);
	assert.equal(requests[0]?.incarnation, 5);
	assert.equal(reads, 2);
	assert.equal(cancels, 0);
});

test("cancels a pending connection-owned invocation when the caller aborts", async () => {
	const controller = new AbortController();
	const cancelled: string[] = [];
	const started = new DeferredPromise<void>();
	const pending = invokeExtensionHost({
		onDidComplete: Event.None,
		onDidDisconnect: Event.None,
		start: async () => { void started.complete(); return { invocationId: "invoke-2" }; },
		read: async () => assert.fail('Pending notification waits need no read'),
		cancel: async invocationId => { cancelled.push(invocationId); return { disposition: "requested" }; },
	}, invocation(), controller.signal, { now: () => 100 });
	await started.p;
	controller.abort('test');
	await assert.rejects(pending, CancellationError);
	assert.deepEqual(cancelled, ["invoke-2"]);
});

test('completion before the start response is covered by the initial read', async () => {
	using completed = new Emitter<string>();
	let reads = 0;
	assert.equal(await invokeExtensionHost({
		onDidComplete: completed.event,
		onDidDisconnect: Event.None,
		start: async () => { completed.fire('early'); return { invocationId: 'early' }; },
		read: async () => { reads++; return { state: 'succeeded', payload: 'ready' }; },
		cancel: async () => assert.fail('A consumed terminal result must not be cancelled'),
	}, invocation(), new AbortController().signal, { now: () => 100 }), 'ready');
	assert.equal(reads, 1);
	assert.equal(completed.hasListeners(), false);
});

test('pending invocations ignore unrelated notifications and make no periodic reads', async () => {
	using completed = new Emitter<string>();
	const started = new DeferredPromise<void>();
	let reads = 0;
	const pending = invokeExtensionHost({
		onDidComplete: completed.event,
		onDidDisconnect: Event.None,
		start: async () => { void started.complete(); return { invocationId: 'waiting' }; },
		read: async () => {
			reads++;
			return { state: 'succeeded', payload: null };
		},
		cancel: async () => assert.fail('A completed result must not be cancelled'),
	}, invocation(), new AbortController().signal, { now: () => 100 });
	await started.p;
	completed.fire('another-call');
	await new Promise(resolve => setTimeout(resolve, 45));
	assert.equal(reads, 0);
	completed.fire('waiting');
	assert.equal(await pending, null);
	assert.equal(reads, 1);
	assert.equal(completed.hasListeners(), false);
});

test('notification waits preserve terminal failure and cancellation states', async () => {
	for (const state of ['failed', 'cancelled'] as const) {
		using completed = new Emitter<string>();
		let reads = 0;
		await assert.rejects(invokeExtensionHost({
			onDidComplete: completed.event,
			onDidDisconnect: Event.None,
			start: async () => { completed.fire('another-call'); return { invocationId: state }; },
			read: async () => {
				if (++reads === 1) { completed.fire(state); return { state: 'pending' }; }
				return state === 'failed' ? { state, code: 'hostRestarted', message: 'restarted' } : { state, reason: 'authorityRevoked' };
			},
			cancel: async () => assert.fail('A terminal result has already released the session'),
		}, invocation(), new AbortController().signal, { now: () => 100 }), error => state === 'failed'
			? error instanceof ExtensionHostInvocationError && error.code === 'hostRestarted'
			: error instanceof CancellationError && error.reason === 'authorityRevoked');
		assert.equal(reads, 2);
		assert.equal(completed.hasListeners(), false);
	}
});

test('a completion without a stored terminal result fails instead of spinning reads', async () => {
	using completed = new Emitter<string>();
	let reads = 0, cancellations = 0;
	await assert.rejects(invokeExtensionHost({
		onDidComplete: completed.event,
		onDidDisconnect: Event.None,
		start: async () => { completed.fire('another-call'); return { invocationId: 'invalid' }; },
		read: async () => { reads++; completed.fire('invalid'); return { state: 'pending' }; },
		cancel: async () => { cancellations++; return { disposition: 'requested' }; },
	}, invocation(), new AbortController().signal, { now: () => 100 }), error => error instanceof ExtensionHostInvocationError && error.code === 'invalidProtocol');
	assert.equal(reads, 2);
	assert.equal(cancellations, 1);
});

test('abort, deadline and disconnect interrupt notification waits and release subscriptions', async () => {
	for (const mode of ['abort', 'deadline', 'disconnect'] as const) {
		using completed = new Emitter<string>();
		using disconnected = new Emitter<Error>();
		const started = new DeferredPromise<void>();
		const controller = new AbortController();
		const closed = new Error('connection closed');
		let cancellations = 0;
		const pending = invokeExtensionHost({
			onDidComplete: completed.event,
			onDidDisconnect: disconnected.event,
			start: async () => { void started.complete(); return { invocationId: mode }; },
			read: async () => assert.fail('Pending notification waits need no read'),
			cancel: async (id, retention) => {
				assert.equal(id, mode); assert.equal(retention, 'discard'); cancellations++;
				return { disposition: 'requested' };
			},
		}, { ...invocation(), deadlineUnixMillis: Date.now() + (mode === 'deadline' ? 50 : 5000) }, controller.signal);
		await started.p;
		if (mode === 'abort') controller.abort();
		if (mode === 'disconnect') disconnected.fire(closed);
		await assert.rejects(pending, error => mode === 'disconnect' ? error === closed
			: mode === 'abort' ? error instanceof CancellationError
				: error instanceof ExtensionHostInvocationError && error.code === 'deadlineExceeded');
		assert.equal(cancellations, 1);
		assert.equal(completed.hasListeners(), false);
		assert.equal(disconnected.hasListeners(), false);
	}
});

test('discarded editor invocations delegate delayed result cleanup to the backend owner', async () => {
	const sessions = new Map<string, { discard: boolean; }>();
	let sequence = 0;
	for (let index = 0; index < 64; index++) {
		const controller = new AbortController();
		let id = '';
		let reads = 0;
		await assert.rejects(invokeExtensionHost({
			onDidComplete: Event.None,
			onDidDisconnect: Event.None,
			start: async () => { assert.ok(sessions.size < 32); id = `edit-${++sequence}`; sessions.set(id, { discard: false }); queueMicrotask(() => controller.abort('superseded')); return { invocationId: id }; },
			read: async () => { reads++; return { state: 'pending' }; },
			cancel: async (invocationId, retention) => { assert.equal(retention, 'discard'); sessions.get(invocationId)!.discard = true; return { disposition: 'requested' }; },
		}, invocation(), controller.signal, { now: () => 100 }), CancellationError);
		assert.equal(reads, 0, 'The abandoned caller must not wait for a delayed terminal result');
		assert.equal(sessions.get(id)?.discard, true);
		// Completion happens after the caller has left. The session owner can release quota
		// without another poll, even when cancellation grace outlives frontend cleanup.
		sessions.delete(id);
	}
	assert.equal(sessions.size, 0);
});

test('discarding an already completed result preserves the original failure', async () => {
	using notification = new Emitter<string>();
	const controller = new AbortController();
	let completed = false, discarded = false;
	await assert.rejects(invokeExtensionHost({
		onDidComplete: notification.event,
		onDidDisconnect: Event.None,
		start: async () => { notification.fire('completed'); return { invocationId: 'completed' }; },
		read: async () => { completed = true; throw new CancellationError('original'); },
		cancel: async (_id, retention) => { assert.equal(completed, true); assert.equal(retention, 'discard'); discarded = true; return { disposition: 'alreadyTerminal' }; },
	}, invocation(), controller.signal, { now: () => 100 }), error => error instanceof CancellationError && error.message === 'original');
	assert.equal(discarded, true);
});

test('abort returns before a delayed start and discards its late session exactly once', async () => {
	const started = new DeferredPromise<unknown>();
	const discarded = new DeferredPromise<void>();
	const controller = new AbortController();
	let cancellations = 0;
	const pending = invokeExtensionHost({
		onDidComplete: Event.None,
		onDidDisconnect: Event.None,
		start: () => started.p,
		read: async () => { assert.fail('Abandoned start must not begin polling'); },
		cancel: async (id, retention) => {
			assert.equal(id, 'late-session'); assert.equal(retention, 'discard');
			cancellations++; void discarded.complete(); return { disposition: 'requested' };
		},
	}, invocation(), controller.signal, { now: () => 100 });
	controller.abort();
	try {
		await assert.rejects(Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('abort waited for start')), 500))]), CancellationError);
	} finally {
		await started.complete({ invocationId: 'late-session' });
		await pending.catch(() => undefined);
	}
	await discarded.p;
	assert.equal(cancellations, 1);
});

test('abort and deadline interrupt a stalled read and discard its backend session', async () => {
	for (const mode of ['abort', 'deadline'] as const) {
		using completed = new Emitter<string>();
		const reading = new DeferredPromise<void>();
		const response = new DeferredPromise<unknown>();
		const controller = new AbortController();
		let cancellations = 0;
		const pending = invokeExtensionHost({
			onDidComplete: completed.event,
			onDidDisconnect: Event.None,
			start: async () => { completed.fire(mode); return { invocationId: mode }; },
			read: () => { void reading.complete(); return response.p; },
			cancel: async (id, retention) => {
				assert.equal(id, mode); assert.equal(retention, 'discard'); cancellations++;
				return { disposition: 'requested' };
			},
		}, { ...invocation(), deadlineUnixMillis: Date.now() + (mode === 'deadline' ? 50 : 5000) }, controller.signal);
		await reading.p;
		if (mode === 'abort') controller.abort();
		try {
			await assert.rejects(Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('caller waited for stalled read')), 500))]), error => mode === 'abort' ? error instanceof CancellationError : error instanceof ExtensionHostInvocationError && error.code === 'deadlineExceeded');
		} finally {
			await response.complete({ state: 'pending' });
			controller.abort();
			await pending.catch(() => undefined);
		}
		assert.equal(cancellations, 1);
	}
});

function invocation(): ExtensionHostInvocationRequest {
	return {
		extensionId: "acme.demo",
		registrationId: "command",
		activationGeneration: 4,
		incarnation: 5,
		operation: "execute",
		payload: Object.freeze({ arguments: Object.freeze([]) }),
		deadlineUnixMillis: 1_000,
	};
}


test('dormant manifests contain declarations without process registrations or authority', () => {
	const extension = {
		id: 'acme.lazy', version: '1', packageDigest: DIGEST, runtimeApiVersion: 1,
		activationGeneration: 4, incarnation: null, lifecycle: 'dormant', failure: null, stderr: '', outputEvents: [], registrations: [],
		activation: { events: ['onCommand:acme.run'], commands: [{ command: 'acme.run', title: 'Run' }] }
	};
	const normalize = (override: object) => normalizeExtensionHostSnapshot({ generation: 1, extensions: [{ ...extension, ...override }] });
	const runtime = normalize({}).extensions[0]!;
	assert.equal(runtime.incarnation, undefined);
	assert.deepEqual(runtime.registrations, []);
	assert.ok(Object.isFrozen(runtime.activation!.commands));
	for (const invalid of [
		{ incarnation: 1 }, { stderr: 'not running' }, { activation: undefined }, { lifecycle: 'ready', incarnation: 1 },
		{ registrations: [{ kind: 'command', registrationId: 'cmd', command: 'acme.run', title: 'Run' }] },
		{ activation: { ...extension.activation, unknown: true } },
		{ activation: { events: [], commands: [...extension.activation.commands, ...extension.activation.commands] } },
	]) { assert.throws(() => normalize(invalid)); }
});

test('Speech registration accepts only bounded immutable metadata on the original fleet boundary', () => {
	const fleet = (registration: unknown) => ({ generation: 1, extensions: [{ id: 'example.speech', version: '1', packageDigest: DIGEST, runtimeApiVersion: 1, activationGeneration: 1, incarnation: 1, lifecycle: 'ready', failure: null, stderr: '', outputEvents: [], registrations: [registration] }] });
	const registration = { registrationId: 'speech', kind: 'speechProvider', registrationGeneration: 1, identifier: 'example.recognition' };
	const normalized = normalizeExtensionHostSnapshot(fleet(registration));
	assert.deepEqual(normalized.extensions[0]!.registrations, [registration]);
	assert.equal(Object.isFrozen(normalized.extensions[0]!.registrations[0]), true);
	const { registrationGeneration: _generation, ...legacy } = registration;
	for (const value of [legacy, { ...registration, registrationGeneration: 0 }, { ...registration, identifier: '' }, { ...registration, identifier: 'space inside' }, { ...registration, identifier: 'x'.repeat(257) }, { ...registration, backendToken: 'private' }]) assert.throws(() => normalizeExtensionHostSnapshot(fleet(value)));
});

test('abandoned invocation discards a successful result when completion wins cancellation', async () => {
	using completed = new Emitter<string>();
	const controller = new AbortController();
	let reads = 0, discarded = false;
	await assert.rejects(invokeExtensionHost({
		onDidComplete: completed.event,
		onDidDisconnect: Event.None,
		start: async () => { completed.fire('another-call'); return { invocationId: 'completion-race' }; },
		read: async () => { reads++; controller.abort(); return { state: 'pending' }; },
		cancel: async (_id, retention) => { assert.equal(retention, 'discard'); discarded = true; return { disposition: 'alreadyTerminal' }; },
	}, invocation(), controller.signal, { now: () => 100 }), CancellationError);
	assert.equal(discarded, true);
	assert.equal(reads, 1);
});

test('payload byte limits count JSON escaping, Unicode and numeric wire representation exactly', () => {
	const limit = 64 * 1024 * 1024;
	const values = [null, true, false, 0, -0, 1.2e30, 1e-9, '中文😀\ud800x\udfff\u0000\b\t\n\f\r"\\'];
	const envelope = { values, ['quoted"\\\n中文😀\ud800']: { sparse: new Array(3) }, padding: '' };
	const overhead = Buffer.byteLength(JSON.stringify(envelope));
	const padding = 'x'.repeat(limit - overhead);
	const normalized = normalizeExtensionHostPayload({ ...envelope, padding });
	assert.equal(Buffer.byteLength(JSON.stringify(normalized)), limit);
	assert.throws(() => normalizeExtensionHostPayload({ ...envelope, padding: padding + 'x' }), /too large/);
});

test('only boundary-normalized immutable payloads are reused; caller data and Worker clones remain untrusted', () => {
	const source = { tree: [{ text: '中文😀' }] };
	const normalized = normalizeExtensionHostPayload(source);
	assert.equal(normalizeExtensionHostPayload(normalized), normalized);
	source.tree[0]!.text = 'changed';
	assert.deepEqual(normalized, Object.assign(Object.create(null), { tree: [Object.assign(Object.create(null), { text: '中文😀' })] }));
	assert.notEqual(normalizeExtensionHostPayload(source), normalized);
	const clone = structuredClone(normalized) as { tree: unknown[]; };
	clone.tree.push(NaN);
	assert.throws(() => normalizeExtensionHostPayload(clone), /Extension Host payload\.tree\[1\] contains a non-finite number/);
	assert.throws(() => normalizeExtensionHostPayload(Object.freeze({ invalid: undefined })), /JSON values/);
});
