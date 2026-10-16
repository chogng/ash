import assert from "node:assert/strict";
import { test } from "mocha";
import { CancellationError } from "../../../../base/common/errors.js";
import { invokeExtensionHost, normalizeExtensionHostPayload, normalizeExtensionHostSnapshot } from '../../browser/extensionHostProtocol.js';
import { type ExtensionHostInvocationRequest, type JsonValue } from '../../common/extensionHostApi.js';

const DIGEST = `sha256:${"a".repeat(64)}`;

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

test("polls a fenced invocation until one strict terminal result", async () => {
	const requests: ExtensionHostInvocationRequest[] = [];
	let reads = 0;
	let cancels = 0;
	const result = await invokeExtensionHost({
		start: async request => { requests.push(request); return { invocationId: "invoke-1" }; },
		read: async invocationId => { assert.equal(invocationId, "invoke-1"); return ++reads === 1 ? { state: "pending" } : { state: "succeeded", payload: { ok: true } }; },
		cancel: async () => { cancels += 1; return { disposition: "alreadyTerminal" }; },
	}, invocation(), new AbortController().signal, { now: () => 100, wait: async () => undefined });

	assert.equal(typeof result === "object" && result !== null && !Array.isArray(result) ? (result as { readonly ok?: JsonValue; }).ok : undefined, true);
	assert.equal(requests[0]?.activationGeneration, 4);
	assert.equal(requests[0]?.incarnation, 5);
	assert.equal(reads, 2);
	assert.equal(cancels, 0);
});

test("cancels a pending connection-owned invocation when the caller aborts", async () => {
	const controller = new AbortController();
	const cancelled: string[] = [];
	await assert.rejects(invokeExtensionHost({
		start: async () => ({ invocationId: "invoke-2" }),
		read: async () => cancelled.length ? { state: 'cancelled', reason: 'caller' } : { state: "pending" },
		cancel: async invocationId => { cancelled.push(invocationId); return { disposition: "requested" }; },
	}, invocation(), controller.signal, {
		now: () => 100,
		wait: async () => { controller.abort("test"); throw new CancellationError("cancelled", "test"); },
	}), CancellationError);
	assert.deepEqual(cancelled, ["invoke-2"]);
});

test('discarded editor invocations consume cancellation results before exhausting the connection quota', async () => {
	const sessions = new Map<string, { cancelled: boolean; reads: number; }>();
	let sequence = 0, terminalReads = 0;
	for (let index = 0; index < 64; index++) {
		const controller = new AbortController();
		await assert.rejects(invokeExtensionHost({
			start: async () => {
				if (sessions.size >= 32) throw new Error('Connection invocation quota exceeded');
				const invocationId = `edit-${++sequence}`;
				sessions.set(invocationId, { cancelled: false, reads: 0 });
				return { invocationId };
			},
			read: async invocationId => {
				const session = sessions.get(invocationId)!;
				if (!session.cancelled || session.reads++ === 0) return { state: 'pending' };
				sessions.delete(invocationId);
				terminalReads++;
				return { state: 'cancelled', reason: 'caller' };
			},
			cancel: async invocationId => { sessions.get(invocationId)!.cancelled = true; return { disposition: 'requested' }; },
		}, invocation(), controller.signal, {
			now: () => 100,
			wait: async (_milliseconds, signal) => {
				if (signal === controller.signal) { controller.abort('superseded'); throw new CancellationError('superseded'); }
			},
		}), CancellationError);
	}
	assert.equal(terminalReads, 64);
	assert.equal(sessions.size, 0);
});

test('cancellation also consumes an already completed result and preserves the original failure', async () => {
	const controller = new AbortController();
	let completed = false, consumed = false;
	await assert.rejects(invokeExtensionHost({
		start: async () => ({ invocationId: 'completed' }),
		read: async () => {
			if (!completed) return { state: 'pending' };
			consumed = true;
			return { state: 'succeeded', payload: { late: true } };
		},
		cancel: async () => ({ disposition: 'alreadyTerminal' }),
	}, invocation(), controller.signal, {
		now: () => 100,
		wait: async () => { completed = true; controller.abort(); throw new CancellationError('original'); },
	}), error => error instanceof CancellationError && error.message === 'original');
	assert.equal(consumed, true);
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
	const registration = { registrationId: 'speech', kind: 'speechProvider', identifier: 'example.recognition' };
	const normalized = normalizeExtensionHostSnapshot(fleet(registration));
	assert.deepEqual(normalized.extensions[0]!.registrations, [registration]);
	assert.equal(Object.isFrozen(normalized.extensions[0]!.registrations[0]), true);
	for (const value of [{ ...registration, identifier: '' }, { ...registration, identifier: 'space inside' }, { ...registration, identifier: 'x'.repeat(257) }, { ...registration, backendToken: 'private' }]) assert.throws(() => normalizeExtensionHostSnapshot(fleet(value)));
});

test('cancelled decoration invocations consume their terminal sessions before reusing quota', async () => {
	const sessions = new Map<string, 'pending' | 'cancelled'>();
	let sequence = 0;
	for (let index = 0; index < 80; index++) {
		const controller = new AbortController();
		await assert.rejects(invokeExtensionHost({
			start: async () => {
				assert.ok(sessions.size < 32, 'Abandoned sessions exhausted the real connection quota');
				const invocationId = `decoration-${sequence++}`;
				sessions.set(invocationId, 'pending');
				return { invocationId };
			},
			read: async invocationId => {
				if (sessions.get(invocationId) === 'pending') return { state: 'pending' };
				sessions.delete(invocationId);
				return { state: 'cancelled', reason: 'caller' };
			},
			cancel: async invocationId => {
				sessions.set(invocationId, 'cancelled');
				return { disposition: 'requested' };
			},
		}, invocation(), controller.signal, {
			now: () => 100,
			wait: async () => { controller.abort(); throw new CancellationError(); },
		}), CancellationError);
		assert.equal(sessions.size, 0);
	}
	assert.equal(sequence, 80);
});

test('abandoned invocation consumes a successful result when completion wins cancellation', async () => {
	const controller = new AbortController();
	let reads = 0;
	let consumed = false;
	await assert.rejects(invokeExtensionHost({
		start: async () => ({ invocationId: 'completion-race' }),
		read: async () => {
			if (++reads === 1) { controller.abort(); return { state: 'pending' }; }
			consumed = true;
			return { state: 'succeeded', payload: 'completed before cancellation' };
		},
		cancel: async () => ({ disposition: 'alreadyTerminal' }),
	}, invocation(), controller.signal, {
		now: () => 100,
		wait: async () => { throw new CancellationError(); },
	}), CancellationError);
	assert.equal(consumed, true);
	assert.equal(reads, 2);
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
