import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { decodeBase64 } from '../../../../../base/common/buffer.js';
import { Emitter } from '../../../../../base/common/event.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createAppServerAgentThreadService, createAppServerAgentTurnService } from '../../../../../platform/agentHost/browser/appServerAgentService.js';
import { registerAgentHostResourceHost } from '../../../../../platform/agentHost/browser/agentHostResourceHost.js';
import type { AppServerProtocolClient } from '../../../../../platform/agentHost/browser/appServerProtocolClient.js';
import type { AgentInput } from '../../../../../platform/agentHost/common/agent.js';
import { AgentHostResourceService } from '../../common/agentHostResourceService.js';

ensureNoDisposablesAreLeakedInTestSuite();

test('Renderer snapshots preserve captured UTF-8 bytes, reject replay and remain connection-local', async () => {
	using snapshots = new AgentHostResourceService();
	using other = new AgentHostResourceService();
	const content = 'captured 中文😀\n';
	using lease = await snapshots.createSnapshot(content);
	assert.ok(lease);
	assert.equal(lease.object.byteLength, new TextEncoder().encode(content).byteLength);
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
	assert.equal(lease.object.sha256, `sha256:${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')}`);
	assert.throws(() => other.read(lease.object.handle, 0, 10));
	assert.throws(() => snapshots.read(lease.object.handle, 1, 10));
	assert.throws(() => snapshots.read(lease.object.handle, 0, 262145));
	const bytes = new Uint8Array(lease.object.byteLength);
	let offset = 0;
	while (offset < bytes.byteLength) {
		const chunk = snapshots.read(lease.object.handle, offset, 3);
		bytes.set(chunk.bytes, offset);
		offset += chunk.bytes.byteLength;
		assert.equal(chunk.eof, offset === bytes.byteLength);
	}
	assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(bytes), content);
	assert.throws(() => snapshots.read(lease.object.handle, 0, 10));
	lease.dispose();
	assert.throws(() => snapshots.read(lease.object.handle, offset, 10));
});

test('Renderer snapshots bound lifetime, allocation concurrency and connection retirement', async () => {
	let now = 0;
	using snapshots = new AgentHostResourceService(() => now);
	using expired = await snapshots.createSnapshot('old');
	assert.ok(expired);
	now = 120_000;
	assert.throws(() => snapshots.read(expired.object.handle, 0, 3));
	assert.equal(await snapshots.createSnapshot(''), undefined);
	assert.equal(await snapshots.createSnapshot('x'.repeat(8 * 1024 * 1024 + 1)), undefined);
	using leases = new DisposableStore();
	const allocated = await Promise.all(Array.from({ length: 65 }, () => snapshots.createSnapshot('captured')));
	for (const lease of allocated) { if (lease) { leases.add(lease); } }
	assert.equal(allocated.filter(Boolean).length, 64, 'concurrent hashes must obey the same allocation quota');
	const live = allocated.find(lease => lease)!;
	snapshots.connectionClosed();
	assert.throws(() => snapshots.read(live.object.handle, 0, 8));
	const pending = snapshots.createSnapshot('hashing at disconnect');
	snapshots.connectionClosed();
	await assert.rejects(pending, isCancellationError);
	using replacement = await snapshots.createSnapshot('new connection');
	assert.ok(replacement);
	assert.equal(new TextDecoder().decode(snapshots.read(replacement.object.handle, 0, 100).bytes), 'new connection');
});

test('Renderer resource snapshots bound fragmented reads as well as transferred bytes', async () => {
	using snapshots = new AgentHostResourceService();
	using lease = await snapshots.createSnapshot('x'.repeat(100));
	assert.ok(lease);
	for (let offset = 0; offset < 64; offset++) { assert.equal(snapshots.read(lease.object.handle, offset, 1).bytes.byteLength, 1); }
	assert.throws(() => snapshots.read(lease.object.handle, 64, 1));
});

interface WireInput { type: string; name?: string; content?: string; resource?: { handle: string; byteLength: number; sha256: string; }; }
interface WireParams { input?: WireInput[]; request?: { type: string; input: WireInput[]; }; }
interface ReadParams { handle: string; offset: number; maxBytes: number; }
interface Chunk { handle: string; offset: number; dataBase64: string; decodedLength: number; eof: boolean; }

/** Transport fixture: callbacks are installed by the production host adapter, not a second broker. */
class SnapshotClient extends Disposable {
	readonly changed = this._register(new Emitter<'ready' | 'closed'>());
	readonly onStateChange = this.changed.event;
	readonly capabilities = { contracts: { hostResources: { version: 1 } } };
	generation = 1;
	state = 'ready';
	readonly handlers = new Map<string, (params: ReadParams | { handle: string; }, context: { signal: AbortSignal; }) => unknown>();
	onRequest: (method: string, params: WireParams) => Promise<unknown> = async () => { throw new Error('unexpected request'); };
	readonly client = this as unknown as AppServerProtocolClient;
	request(definition: { method: string; }, params: WireParams): Promise<unknown> { return this.onRequest(definition.method, params); }
	registerRequestHandler(definition: { method: string; }, handler: (params: ReadParams | { handle: string; }, context: { signal: AbortSignal; }) => unknown) {
		this.handlers.set(definition.method, handler);
		return toDisposable(() => this.handlers.delete(definition.method));
	}
	async read(params: ReadParams, signal = new AbortController().signal): Promise<Chunk> {
		return await this.handlers.get('hostResource/read')!(params, { signal }) as Chunk;
	}
	async release(handle: string): Promise<void> { await this.handlers.get('hostResource/release')!({ handle }, { signal: new AbortController().signal }); }
}

for (const operation of ['start', 'steer', 'enqueue', 'rewrite'] as const) {
	test(`Renderer ${operation} uses negotiated immutable resources and releases transfer leases`, async () => {
		using owner = new SnapshotClient();
		using snapshots = new AgentHostResourceService();
		using host = registerAgentHostResourceHost(owner.client, snapshots);
		const content = 'selection snapshot 中文😀\n'.repeat(20_000);
		const input: AgentInput[] = [{ type: 'context', name: 'selected.ts', content }, { type: 'text', text: 'Review this' }];
		let handle = '';
		owner.onRequest = async (method, params) => {
			assert.equal(method, operation === 'enqueue' ? 'queue/enqueue' : 'session/request');
			const wire = (params.input ?? params.request!.input)[0]!;
			assert.equal(wire.type, 'hostResource');
			assert.equal(wire.content, undefined);
			assert.equal(wire.name, 'selected.ts');
			handle = wire.resource!.handle;
			const bytes = new Uint8Array(wire.resource!.byteLength);
			let offset = 0;
			while (offset < bytes.byteLength) {
				const chunk = await owner.read({ handle, offset, maxBytes: 256 * 1024 });
				assert.equal(chunk.handle, handle);
				assert.equal(chunk.offset, offset);
				const decoded = decodeBase64(chunk.dataBase64).buffer;
				assert.equal(decoded.byteLength, chunk.decodedLength);
				bytes.set(decoded, offset);
				offset += decoded.byteLength;
				assert.equal(chunk.eof, offset === bytes.byteLength);
			}
			assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(bytes), content);
			await owner.release(handle);
			if (operation === 'enqueue') { return { status: 'pending' }; }
			if (operation === 'rewrite') { return { type: 'rewrite', value: { session: { sessionId: 'session' }, threadId: 'replacement' } }; }
			return { type: operation === 'steer' ? 'turnSteer' : 'turn', value: { turnId: 'turn', sequence: 1 } };
		};
		const base = { sessionId: 'session', commandId: operation, threadId: 'thread', expectedSequence: 0, mode: 'agent' as const, input };
		const turns = createAppServerAgentTurnService(owner.client, snapshots);
		if (operation === 'start') { await turns.start(base); }
		else if (operation === 'steer') { await turns.steer({ ...base, turnId: 'turn' }); }
		else if (operation === 'enqueue') { await turns.enqueue({ ...base, approvalMode: 'manual' }); }
		else { await createAppServerAgentThreadService(owner.client, undefined, snapshots).rewrite({ ...base, beforeTurnId: 'before', title: 'Revised' }); }
		assert.throws(() => snapshots.read(handle, 0, 100));
		assert.deepEqual(input[0], { type: 'context', name: 'selected.ts', content }, 'transport must leave the captured domain input unchanged');
	});
}

test('Renderer resource transfer retains inline compatibility and retires failed/closed requests', async () => {
	using owner = new SnapshotClient();
	using snapshots = new AgentHostResourceService();
	using host = registerAgentHostResourceHost(owner.client, snapshots);
	const params = { sessionId: 'session', commandId: 'start', threadId: 'thread', expectedSequence: 0, mode: 'agent' as const, input: [{ type: 'context' as const, name: 'selected', content: 'snapshot' }] };
	const turns = createAppServerAgentTurnService(owner.client, snapshots);
	owner.capabilities.contracts.hostResources.version = 0;
	owner.onRequest = async (_method, wire) => {
		assert.deepEqual(wire.request!.input, params.input);
		return { type: 'turn', value: { turnId: 'turn', sequence: 1 } };
	};
	await turns.start(params);
	owner.capabilities.contracts.hostResources.version = 1;
	let handle = '';
	owner.onRequest = async (_method, wire) => {
		handle = wire.request!.input[0]!.resource!.handle;
		throw new Error('request rejected before consumption');
	};
	await assert.rejects(turns.start(params), /request rejected/);
	assert.throws(() => snapshots.read(handle, 0, 100));
	using lease = await snapshots.createSnapshot('before close');
	assert.ok(lease);
	const cancellation = new AbortController();
	cancellation.abort();
	await assert.rejects(owner.read({ handle: lease.object.handle, offset: 0, maxBytes: 100 }, cancellation.signal), isCancellationError);
	owner.state = 'closed';
	owner.changed.fire('closed');
	await assert.rejects(owner.read({ handle: lease.object.handle, offset: 0, maxBytes: 100 }));
	host.dispose();
	assert.equal(owner.handlers.size, 0);
});


class DeferredSnapshots extends AgentHostResourceService {
	readonly entered = new DeferredPromise<void>();
	readonly gate = new DeferredPromise<void>();
	handle: string | undefined;
	override async createSnapshot(content: string) {
		const lease = await super.createSnapshot(content);
		this.handle = lease?.object.handle;
		this.entered.complete();
		await this.gate.p;
		return lease;
	}
}

for (const operation of ['start', 'steer', 'enqueue', 'rewrite'] as const) {
	test(`canceling ${operation} during snapshot creation releases its late lease without dispatching`, async () => {
		using owner = new SnapshotClient();
		using snapshots = new DeferredSnapshots();
		let calls = 0;
		owner.onRequest = async () => { calls++; assert.fail('a retired submission must not reach the backend'); };
		const controller = new AbortController();
		const params = { sessionId: 'session', commandId: operation, threadId: 'thread', expectedSequence: 0, mode: 'agent' as const, input: [{ type: 'context' as const, name: 'selected.ts', content: 'captured content' }] };
		const turns = createAppServerAgentTurnService(owner.client, snapshots);
		const pending = operation === 'start' ? turns.start(params, controller.signal)
			: operation === 'steer' ? turns.steer({ ...params, turnId: 'turn' }, controller.signal)
				: operation === 'enqueue' ? turns.enqueue({ ...params, approvalMode: 'manual' }, controller.signal)
					: createAppServerAgentThreadService(owner.client, undefined, snapshots).rewrite({ ...params, beforeTurnId: 'before', title: 'Revised' }, controller.signal);
		const rejected = assert.rejects(pending, isCancellationError);
		await snapshots.entered.p;
		controller.abort();
		await snapshots.gate.complete();
		await rejected;
		assert.equal(calls, 0);
		assert.ok(snapshots.handle);
		assert.throws(() => snapshots.read(snapshots.handle!, 0, 100), 'the late lease must be released');
	});
}

test('pre-canceled context submissions cannot dispatch through the inline compatibility path', async () => {
	using owner = new SnapshotClient();
	owner.capabilities.contracts.hostResources.version = 0;
	let calls = 0;
	owner.onRequest = async () => { calls++; assert.fail('canceled inline submission'); };
	const controller = new AbortController();
	controller.abort();
	const turns = createAppServerAgentTurnService(owner.client);
	await assert.rejects(turns.start({ sessionId: 'session', commandId: 'inline', threadId: 'thread', expectedSequence: 0, mode: 'agent', input: [{ type: 'context', name: 'selected.ts', content: 'captured content' }] }, controller.signal), isCancellationError);
	assert.equal(calls, 0);
});
