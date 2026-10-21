import { AppServerTerminalProcessService, decodeTerminalProcessReadResult } from '../../browser/appServerTerminalProcessService.js';
import type { IAppServerApi } from '../../../agentHost/common/appServerApi.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { GeneralShellType } from '../../common/terminal.js';
import assert from "node:assert/strict";
import { suite, test } from "mocha";
import { DeferredPromise } from '../../../../base/common/async.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { APP_SERVER_METHODS } from "../../../../../../.build/protocol/typescript/index.js";
import { toDisposable } from "../../../../base/common/lifecycle.js";
import { AppServerRemoteError } from "../../../agentHost/common/appServerError.js";
import type { AppServerConnectionState } from "../../../agentHost/common/appServerApi.js";
import type { AppServerProtocolClient } from "../../../agentHost/browser/appServerProtocolClient.js";
import { ReconnectableTerminalProcessService } from "../../../../platform/terminal/browser/reconnectableTerminalProcessService.js";
import type { ITerminalProcessService } from "../../common/terminal.js";

const FIRST_TOKEN = "a".repeat(64);
const SECOND_TOKEN = "b".repeat(64);
const THIRD_TOKEN = "c".repeat(64);

suite('terminal directory recovery readiness', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const operation of ['profiles', 'resolve', 'environment', 'create'] as const) {
		test(`${operation} waits for restored directory grants before using the ready protocol`, async () => {
			const supervisor = new TestSupervisor();
			const directories = new DeferredPromise<void>();
			using service = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient, { whenDirectoriesReady: () => directories.p });
			const pending = {
				profiles: () => service.listProfiles('workspace-folder'),
				resolve: () => service.resolveProfile({ type: 'default' }, 'workspace-folder'),
				environment: () => service.getEnvironment(undefined, 'workspace-folder'),
				create: () => service.create({ dirId: 'workspace-folder', rows: 24, cols: 80, profile: { type: 'default' } }),
			}[operation]();
			await Promise.resolve();
			assert.deepEqual(supervisor.requests, []);
			await directories.complete();
			await pending;
			assert.equal(supervisor.requests.length, 1);
		});
	}

	for (const retirement of ['dispose', 'replacement', 'generation'] as const) {
		test(`a create waiting for directories cannot cross ${retirement}`, async () => {
			const supervisor = new TestSupervisor();
			const directories = new DeferredPromise<void>();
			using service = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient, { whenDirectoriesReady: () => directories.p });
			const pending = service.create({ rows: 24, cols: 80, profile: { type: 'default' } });
			const rejected = assert.rejects(pending, isCancellationError);
			if (retirement === 'dispose') service.dispose();
			else if (retirement === 'replacement') service.prepareForServerReplacement();
			else supervisor.generation++;
			await directories.complete();
			await rejected;
			assert.deepEqual(supervisor.requests, []);
		});
	}

	test('reattachment waits for directories and never recreates or replays the command', async () => {
		const supervisor = new TestSupervisor();
		let directories = Promise.resolve();
		using service = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient, { whenDirectoriesReady: () => directories });
		await service.create({ dirId: 'workspace-folder', rows: 24, cols: 80, profile: { type: 'default' } });
		const restored = new DeferredPromise<void>();
		directories = restored.p;
		supervisor.emit('crashed');
		supervisor.generation++;
		supervisor.emit('ready');
		const read = service.read({ dirId: 'workspace-folder', terminalId: 'terminal-1', afterSequence: 0, afterCommandSequence: 0, maxChunks: 1 });
		await Promise.resolve();
		assert.deepEqual(supervisor.requests.map(request => request.method), ['terminal/create']);
		await restored.complete();
		await read;
		assert.deepEqual(supervisor.requests.map(request => request.method), ['terminal/create', 'terminal/attach', 'terminal/read']);
	});

	test('directory authorization failures remain visible without dispatching a terminal request', async () => {
		const supervisor = new TestSupervisor();
		const denied = new Error('directory permission denied');
		using service = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient, { whenDirectoriesReady: () => Promise.reject(denied) });
		await assert.rejects(service.listProfiles('workspace-folder'), error => error === denied);
		assert.deepEqual(supervisor.requests, []);
	});
});

suite('reconnectable terminal creation lifetime', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const retirement of ['dispose', 'replacement'] as const) {
		test(`a create reply after ${retirement} closes its original process without publishing a lease`, async () => {
			const supervisor = new TestSupervisor();
			const reply = new DeferredPromise<void>();
			supervisor.createReply = reply.p;
			using service = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient);
			const creation = service.create({ dirId: 'original-folder', rows: 24, cols: 80, profile: { type: 'default' } });
			const rejected = assert.rejects(creation, isCancellationError);
			if (retirement === 'dispose') service.dispose();
			else service.prepareForServerReplacement();
			await reply.complete();
			await rejected;
			assert.deepEqual(supervisor.requests.map(request => request.method), ['terminal/create', 'terminal/close']);
			assert.deepEqual(supervisor.requests.at(-1)?.params, { dirId: 'original-folder', terminalId: 'terminal-1' });
			assert.equal(await service.getReconnectLease('terminal-1'), undefined);
		});
	}

	test('a retired connection create reply cannot close or register a process on the replacement connection', async () => {
		const supervisor = new TestSupervisor();
		const reply = new DeferredPromise<void>();
		supervisor.createReply = reply.p;
		using service = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient);
		const creation = service.create({ rows: 24, cols: 80, profile: { type: 'default' } });
		const rejected = assert.rejects(creation, isCancellationError);
		supervisor.emit('crashed');
		supervisor.generation++;
		supervisor.emit('ready');
		await reply.complete();
		await rejected;
		assert.deepEqual(supervisor.requests.map(request => request.method), ['terminal/create']);
		assert.equal(await service.getReconnectLease('terminal-1'), undefined);
	});

	test('a disposed service rejects creation before contacting the execution host', async () => {
		const supervisor = new TestSupervisor();
		using service = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient);
		service.dispose();
		await assert.rejects(service.create({ rows: 24, cols: 80, profile: { type: 'default' } }), isCancellationError);
		assert.deepEqual(supervisor.requests, []);
	});
});

suite('reconnectable terminal operations after retirement', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const retirement of ['dispose', 'replacement'] as const) {
		test(`a late close after ${retirement} cannot address a process on the replacement connection`, async () => {
			const supervisor = new TestSupervisor();
			using service = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient);
			await service.create({ rows: 24, cols: 80, profile: { type: 'default' } });
			if (retirement === 'dispose') service.dispose();
			else service.prepareForServerReplacement();
			const before = [...supervisor.requests];
			supervisor.generation++;
			await service.close({ terminalId: 'terminal-1' });
			assert.deepEqual(supervisor.requests, before);
		});
	}

	test('closing an unknown or already closed terminal never dispatches another close', async () => {
		const supervisor = new TestSupervisor();
		using service = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient);
		await service.close({ terminalId: 'unknown' });
		assert.equal(supervisor.requests.length, 0);
		await service.create({ rows: 24, cols: 80, profile: { type: 'default' } });
		await service.close({ terminalId: 'terminal-1' });
		await service.close({ terminalId: 'terminal-1' });
		assert.deepEqual(supervisor.requests.map(request => request.method), ['terminal/create', 'terminal/close']);
	});

	for (const retirement of ['close', 'dispose', 'replacement'] as const) {
		for (const operation of ['write', 'read', 'resize', 'signal', 'autoReplies', 'processInfo', 'lease'] as const) {
			test(`${operation} waiting for recovery cannot dispatch after ${retirement}`, async () => {
				const supervisor = new TestSupervisor();
				const reply = new DeferredPromise<void>();
				supervisor.attachReply = reply.p;
				const failures: unknown[] = [];
				using service = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient, { reportError: (_message, error) => failures.push(error) });
				await service.create({ dirId: 'original-folder', rows: 24, cols: 80, profile: { type: 'default' } });
				supervisor.emit('crashed');
				supervisor.generation++;
				supervisor.emit('ready');
				const identity = { dirId: 'original-folder', terminalId: 'terminal-1' };
				const operations = {
					write: () => service.write({ ...identity, data: 'retired input' }),
					read: () => service.read({ ...identity, afterSequence: 0, afterCommandSequence: 0, maxChunks: 1 }),
					resize: () => service.resize({ ...identity, rows: 30, cols: 100 }),
					signal: () => service.sendSignal({ ...identity, signal: 'interrupt' }),
					autoReplies: () => service.setAutoReplies({ ...identity, rules: [{ matchText: 'Confirm?', reply: 'yes\r' }] }),
					processInfo: () => service.getProcessInfo(identity),
					lease: () => service.getReconnectLease(identity.terminalId),
				};
				const request = operations[operation]();
				const rejected = operation === 'lease' ? request.then(value => assert.equal(value, undefined)) : assert.rejects(request, isCancellationError);
				const closing = retirement === 'close' ? service.close(identity) : undefined;
				if (retirement === 'dispose') service.dispose();
				else if (retirement === 'replacement') service.prepareForServerReplacement();
				await reply.complete();
				await rejected;
				await closing;
				assert.equal(supervisor.requests.some(request => !['terminal/create', 'terminal/attach', 'terminal/close'].includes(request.method)), false);
				assert.ok(supervisor.requests.some(request => request.method === 'terminal/close'));
				assert.deepEqual(failures, []);
			});
		}
	}

	test('restore attachment cannot publish process information returned after close', async () => {
		const supervisor = new TestSupervisor();
		const reply = new DeferredPromise<void>();
		supervisor.processInfoReply = reply.p;
		using service = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient);
		const restoring = service.attach({ terminalId: 'terminal-1', dirId: 'original-folder', reconnectToken: FIRST_TOKEN, reconnectGracePeriodMillis: 30000 }, { rows: 24, cols: 80 }, { profileId: 'shell', title: 'Shell', isDefault: true });
		const rejected = assert.rejects(restoring, isCancellationError);
		await waitFor(() => supervisor.requests.some(request => request.method === 'terminal/processInfo'));
		await service.close({ terminalId: 'terminal-1', dirId: 'original-folder' });
		await reply.complete();
		await rejected;
		assert.equal(await service.getReconnectLease('terminal-1'), undefined);
	});
});

test('a replacement renderer attaches the original process and rotates its handoff credential', async () => {
	const supervisor = new TestSupervisor();
	supervisor.shellType = 'pwsh';
	const original = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient);
	const created = await original.create({ dirId: 'folder', rows: 24, cols: 80, profile: { type: 'default' } });
	assert.equal(created.ready.shellType, GeneralShellType.PowerShell);
	const credential = await original.getReconnectLease(created.terminalId);
	assert.ok(credential);
	original.prepareForReload();
	await original.close({ terminalId: created.terminalId, dirId: 'folder' });
	assert.equal(supervisor.requests.some(request => request.method === 'terminal/close'), false);
	original.dispose();
	using replacement = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient);
	const dimensions = { cols: 120, rows: 40, dirId: 'unrelated-ui-state', vt: 'not process state' };
	const attached = await replacement.attach(credential, dimensions, created.profile);
	assert.deepEqual(attached.ready, created.ready);
	assert.equal(supervisor.requests.filter(request => request.method === 'terminal/create').length, 1);
	assert.deepEqual(supervisor.requests.find(request => request.method === 'terminal/attach')?.params, { terminalId: created.terminalId, dirId: 'folder', reconnectToken: FIRST_TOKEN, cols: 120, rows: 40 });
	assert.deepEqual(supervisor.requests.at(-1), { method: 'terminal/processInfo', params: { terminalId: created.terminalId, dirId: 'folder' } });
	assert.equal((await replacement.getReconnectLease(created.terminalId))!.reconnectToken, SECOND_TOKEN);
	await replacement.close({ terminalId: created.terminalId, dirId: 'folder' });
});

test('explicit handoff retires source access and cancellation can reattach the same process', async () => {
	const supervisor = new TestSupervisor();
	using source = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient);
	const created = await source.create({ dirId: 'folder', rows: 24, cols: 80, profile: { type: 'default' } });
	const lease = await source.detach(created.terminalId);
	assert.equal(lease.reconnectToken, THIRD_TOKEN);
	assert.deepEqual(supervisor.requests.find(request => request.method === 'terminal/detach')?.params, { terminalId: created.terminalId, dirId: 'folder' });
	const count = supervisor.requests.length;
	await assert.rejects(source.write({ terminalId: created.terminalId, data: 'forbidden' }), /no longer recoverable/);
	await source.close({ terminalId: created.terminalId });
	assert.equal(supervisor.requests.length, count);
	const restored = await source.attach(lease, { rows: 24, cols: 80 }, created.profile);
	assert.equal(restored.ready.pid, created.ready.pid);
	await source.close({ terminalId: created.terminalId, dirId: 'folder' });
	assert.equal(supervisor.requests.at(-1)?.method, 'terminal/close');
});

test('display metadata preserves output ordering, nullable env values and per-process command identity', () => {
	const result = decodeTerminalProcessReadResult({
		terminalId: 'process-1', nextSequence: 3, outputGap: false,
		commandEvents: [], nextCommandSequence: 0, commandEventGap: false, exited: false, exitCode: null,
		chunks: [
			{ sequence: 1, dataBase64: '', shellIntegration: { type: 'environment', values: { CURRENT: '中文🙂', UNSET: null }, isTrusted: true } },
			{ sequence: 2, dataBase64: 'b3V0cHV0' },
			{ sequence: 3, dataBase64: '', shellIntegration: { type: 'commandExecuted', commandId: 'command-1', command: null, cwd: null, isTrusted: false, commandStorageDisabled: true, timestampMillis: 123 } },
		],
	});
	assert.deepEqual(result.chunks.map(chunk => [chunk.sequence, chunk.shellIntegration?.type]), [[1, 'environment'], [2, undefined], [3, 'commandExecuted']]);
	assert.deepEqual(result.chunks[0]!.shellIntegration, { type: 'environment', values: { CURRENT: '中文🙂', UNSET: undefined }, isTrusted: true });
	assert.deepEqual(result.chunks[2]!.shellIntegration, { type: 'commandExecuted', commandId: 'process-1:command-1', command: undefined, cwd: undefined, isTrusted: false, commandStorageDisabled: true, timestampMillis: 123 });
	assert.equal(new TextDecoder().decode(result.chunks[1]!.data), 'output');
});

test('the execution host shell type is decoded into the domain without deriving it from titles', () => {
	const result = decodeTerminalProcessReadResult({
		terminalId: 'process-1', nextSequence: 1, outputGap: false,
		commandEvents: [], nextCommandSequence: 0, commandEventGap: false, exited: false, exitCode: null,
		chunks: [{ sequence: 1, dataBase64: '', shellIntegration: { type: 'processReady', isWindowsPty: true, shellType: 'pwsh' } }],
	});
	assert.deepEqual(result.chunks[0]!.shellIntegration, { type: 'processReady', isWindowsPty: true, shellType: GeneralShellType.PowerShell });
});

test("Remote terminal leases stay in the renderer and rotate across connection generations", async () => {
	const supervisor = new TestSupervisor();
	const failures: unknown[] = [];
	using service = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient, {
		wait: async () => { },
		reportError: (_message, error) => failures.push(error),
	});

	const created = await service.create({
		rows: 24,
		cols: 80,
		profile: { type: "default" },
	});

	assert.deepEqual(created, {
		ready: { pid: 1234, cwd: '/backend/workspace' },
		terminalId: "terminal-1",
		profile: { profileId: "shell", title: "Shell", isDefault: true },
		connectionPersistence: "reconnectable",
	});
	assert.equal(JSON.stringify(created).includes(FIRST_TOKEN), false);
	assert.deepEqual(supervisor.requests[0], {
		method: "terminal/create",
		params: {
			rows: 24,
			cols: 80,
			profile: { type: "default" },
			lifecycle: { type: "reconnectable" },
		},
	});

	supervisor.attachFailures = 1;
	supervisor.emit("crashed");
	supervisor.generation = 2;
	supervisor.emit("ready");
	await waitFor(() => supervisor.successfulAttachments === 1);
	await service.resize({ terminalId: "terminal-1", rows: 40, cols: 120 });
	await service.read({ terminalId: "terminal-1", afterSequence: 0, afterCommandSequence: 0, maxChunks: 10 });
	const info = await service.getProcessInfo({ terminalId: 'terminal-1' });
	assert.deepEqual(info, { ready: { pid: 1234, cwd: '/backend/workspace' }, cwd: '/backend/current', rows: 40, cols: 120 });
	assert.deepEqual(supervisor.requests.at(-1), { method: 'terminal/processInfo', params: { terminalId: 'terminal-1' } });

	await service.write({ terminalId: 'terminal-1', data: new Uint8Array([0, 0x80, 0xff]) });
	assert.deepEqual(supervisor.requests.at(-1), { method: 'terminal/writeBinary', params: { terminalId: 'terminal-1', dataBase64: 'AID/' } });
	const firstGenerationAttachments = supervisor.requests.filter(request => request.method === "terminal/attach");
	assert.equal(firstGenerationAttachments.length, 2);
	assert.deepEqual(firstGenerationAttachments[0]?.params, {
		terminalId: "terminal-1",
		reconnectToken: FIRST_TOKEN,
		rows: 24,
		cols: 80,
	});
	assert.deepEqual(failures, []);

	supervisor.emit("crashed");
	supervisor.generation = 3;
	supervisor.emit("ready");
	await waitFor(() => supervisor.successfulAttachments === 2);
	const attachments = supervisor.requests.filter(request => request.method === "terminal/attach");
	assert.deepEqual(attachments.at(-1)?.params, {
		terminalId: "terminal-1",
		reconnectToken: SECOND_TOKEN,
		rows: 40,
		cols: 120,
	});

	await service.close({ terminalId: "terminal-1" });
	assert.equal(supervisor.requests.at(-1)?.method, "terminal/close");
});

test("Remote terminal creation rejects malformed leases before exposing a terminal", async () => {
	const supervisor = new TestSupervisor();
	supervisor.invalidCreateLease = true;
	using service = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient);

	await assert.rejects(() => service.create({
		rows: 24,
		cols: 80,
		profile: { type: "default" },
	}), /invalid terminal reconnect lease/);
	assert.equal(supervisor.requests.at(-1)?.method, "terminal/close");
});

test('an expired terminal has no reload credential while a live disconnected terminal still reports recovery failure', async () => {
	const supervisor = new TestSupervisor();
	let now = 0;
	const failures: unknown[] = [];
	using service = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient, { now: () => now, reportError: (_message, error) => failures.push(error) });
	const invalidated: unknown[] = [];
	using subscription = service.onDidInvalidateProcess(event => invalidated.push(event));
	await service.create({ rows: 24, cols: 80, profile: { type: 'default' } });
	supervisor.emit('crashed');
	supervisor.generation++;
	await assert.rejects(service.getReconnectLease('terminal-1'), /waiting for App Server recovery/);
	assert.deepEqual(invalidated, []);
	now = 30001;
	supervisor.attachFailures = 1;
	supervisor.emit('ready');
	assert.equal(await service.getReconnectLease('terminal-1'), undefined);
	assert.equal(failures.length, 1);
	assert.match(String(failures[0]), /lease expired before attachment/);
	assert.deepEqual(invalidated, [{ terminalId: 'terminal-1', reason: 'expiry' }]);
	await assert.rejects(service.write({ terminalId: 'terminal-1', data: 'not delivered' }), /no longer recoverable/);
});

test('persistent processes recover after a day offline and transient attachment failures', async () => {
	const supervisor = new TestSupervisor();
	supervisor.reconnectGracePeriodMillis = 0;
	let now = 0;
	using service = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient, { now: () => now, wait: async milliseconds => { now += milliseconds; } });
	await service.create({ rows: 24, cols: 80, profile: { type: 'default' } });
	supervisor.emit('crashed');
	now = 86400_000;
	supervisor.generation++;
	supervisor.attachFailures = 3;
	supervisor.emit('ready');
	const lease = await service.getReconnectLease('terminal-1');
	assert.equal(lease?.reconnectGracePeriodMillis, 0);
	assert.equal(supervisor.successfulAttachments, 1);
	await service.write({ terminalId: 'terminal-1', data: 'same command' });
});

for (const errorName of ['TerminalNotFound', 'TerminalAttachRejected'] as const) test(`persistent recovery stops on authoritative ${errorName}`, async () => {
	const supervisor = new TestSupervisor();
	supervisor.reconnectGracePeriodMillis = 0;
	using service = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient, { wait: async () => { assert.fail('authoritative rejection must not retry'); }, reportError: () => { } });
	await service.create({ rows: 24, cols: 80, profile: { type: 'default' } });
	supervisor.emit('crashed');
	supervisor.generation++;
	supervisor.attachError = new AppServerRemoteError(-32065, errorName, { kind: errorName });
	supervisor.emit('ready');
	assert.equal(await service.getReconnectLease('terminal-1'), undefined);
	assert.equal(supervisor.successfulAttachments, 0);
});

test('a pane closed during backend loss keeps its cleanup credential until recovery acknowledges close', async () => {
	const supervisor = new TestSupervisor();
	supervisor.reconnectGracePeriodMillis = 0;
	using service = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient);
	const created = await service.create({ rows: 24, cols: 80, profile: { type: 'default' } });
	supervisor.emit('crashed');
	await service.close({ terminalId: created.terminalId });
	assert.equal(await service.getReconnectLease(created.terminalId), undefined);
	await assert.rejects(service.write({ terminalId: created.terminalId, data: 'late input' }), isCancellationError);
	supervisor.generation++;
	supervisor.emit('ready');
	await waitFor(() => supervisor.requests.some(request => request.method === 'terminal/close'));
	assert.equal(supervisor.successfulAttachments, 1);
	assert.equal(supervisor.requests.filter(request => request.method === 'terminal/close').length, 1);
});

test('window lifetime credentials accompany create and replacement attachments without entering reload leases', async () => {
	const supervisor = new TestSupervisor();
	let token = 'b'.repeat(64);
	using service = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient, { lifetimeToken: async () => token });
	const created = await service.create({ rows: 24, cols: 80, profile: { type: 'default' } });
	assert.equal((supervisor.requests.find(request => request.method === 'terminal/create')!.params as { lifetimeToken: string; }).lifetimeToken, token);
	assert.equal('lifetimeToken' in (await service.getReconnectLease(created.terminalId))!, false);
	token = 'c'.repeat(64);
	supervisor.emit('crashed');
	supervisor.generation++;
	supervisor.emit('ready');
	await service.getReconnectLease(created.terminalId);
	assert.equal((supervisor.requests.find(request => request.method === 'terminal/attach')!.params as { lifetimeToken: string; }).lifetimeToken, token);
});

test("intentional server replacement abandons old broker leases without recovery retries", async () => {
	const supervisor = new TestSupervisor();
	using service = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient);
	const invalidated: unknown[] = [];
	using subscription = service.onDidInvalidateProcess(event => invalidated.push(event));
	await service.create({
		rows: 24,
		cols: 80,
		profile: { type: "default" },
	});

	service.prepareForServerReplacement();
	assert.deepEqual(invalidated, [{ terminalId: 'terminal-1', reason: 'replacement' }]);
	service.prepareForServerReplacement();
	assert.equal(invalidated.length, 1);
	assert.equal(supervisor.requests.at(-1)?.method, "terminal/close");
	assert.equal(await service.getReconnectLease('terminal-1'), undefined);
	supervisor.emit("stopping");
	supervisor.generation = 2;
	supervisor.emit("ready");

	await assert.rejects(() => service.read({
		terminalId: "terminal-1",
		afterSequence: 0,
		afterCommandSequence: 0,
		maxChunks: 1,
	}), /no longer recoverable/);
	assert.equal(supervisor.requests.some(request => request.method === "terminal/attach"), false);
});

test("SSH terminal service supplies profiles, connection events and decoded output", async () => {
	const supervisor = new TestSupervisor();
	using adapter = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient);
	const service: ITerminalProcessService = adapter;
	assert.equal(service.operatingSystem, OperatingSystem.Linux);
	supervisor.operatingSystem = undefined;
	assert.equal(service.operatingSystem, undefined);
	supervisor.operatingSystem = OperatingSystem.Windows;
	assert.equal(service.operatingSystem, OperatingSystem.Windows);
	const states: string[] = [];
	using subscription = service.onConnectionState(state => states.push(state));
	assert.deepEqual(await service.listProfiles(), [{ profileId: "shell", title: "Shell", isDefault: true }]);
	assert.equal(await service.getConnectionState(), "ready");
	await service.create({ dirId: "remote-folder", rows: 24, cols: 80, profile: { type: "default" } });
	assert.deepEqual(supervisor.requests.at(-1)?.params, {
		dirId: "remote-folder",
		rows: 24,
		cols: 80,
		profile: { type: "default" },
		lifecycle: { type: "reconnectable" },
	});
	supervisor.output = Buffer.from([0xe4, 0xb8, 0xad, 0xff, 0x1b]);
	const result = await service.read({
		dirId: "remote-folder",
		terminalId: "terminal-1",
		afterSequence: 0,
		afterCommandSequence: 0,
		maxChunks: 128,
	});
	assert.deepEqual(result, {
		terminalId: "terminal-1",
		chunks: [{ sequence: 1, data: new Uint8Array(supervisor.output) }],
		nextSequence: 1,
		outputGap: false,
		commandEvents: [{
			sequence: 1,
			commandId: "command-1",
			status: "running",
			exitCode: undefined,
			afterOutputSequence: 1,
		}],
		nextCommandSequence: 1,
		commandEventGap: false,
		exited: false,
		exitCode: undefined,
	});
	supervisor.emit("crashed");
	assert.equal(await service.getConnectionState(), "crashed");
	assert.deepEqual(states, ["crashed"]);
	subscription.dispose();
	supervisor.emit("stopped");
	assert.deepEqual(states, ["crashed"]);
	await service.close({ dirId: "remote-folder", terminalId: "terminal-1" });
});

interface RecordedRequest {
	readonly method: string;
	readonly params: unknown;
}

class TestSupervisor {
	shellType: 'pwsh' | undefined;
	operatingSystem: OperatingSystem | undefined = OperatingSystem.Linux;
	state: AppServerConnectionState = "ready";
	generation = 1;
	attachFailures = 0;
	reconnectGracePeriodMillis = 30_000;
	attachError: Error | undefined;
	successfulAttachments = 0;
	invalidCreateLease = false;
	createReply: Promise<void> | undefined;
	attachReply: Promise<void> | undefined;
	processInfoReply: Promise<void> | undefined;
	output: Buffer | undefined;
	cwd: { value: string; afterOutputSequence: number; isTrusted?: boolean; } | undefined;
	readonly requests: RecordedRequest[] = [];
	private readonly listeners = new Set<(state: AppServerConnectionState) => void>();

	onStateChange(listener: (state: AppServerConnectionState) => void) {
		this.listeners.add(listener);
		return toDisposable(() => this.listeners.delete(listener));
	}

	emit(state: AppServerConnectionState): void {
		this.state = state;
		for (const listener of this.listeners) listener(state);
	}

	async request(definition: { method: string; }, params: unknown): Promise<any> {
		// Requests cross JSON-RPC in production, which omits absent optional fields.
		this.requests.push({ method: definition.method, params: JSON.parse(JSON.stringify(params)) });
		switch (definition.method) {
			case APP_SERVER_METHODS["terminal/profile/list"].method:
				return { profiles: [{ profileId: "shell", title: "Shell", isDefault: true }] };
			case APP_SERVER_METHODS['terminal/environment/read'].method:
				return { values: { PATH: '/host/bin' } };
			case APP_SERVER_METHODS["terminal/profile/resolve"].method: {
				const { profile } = params as { profile: { args: string | string[]; }; };
				return { profile: { profileId: 'custom:Raw', title: 'Raw', isDefault: false }, executable: 'cmd.exe', args: profile.args };
			}
			case APP_SERVER_METHODS["terminal/create"].method:
				await this.createReply;
				return {
					terminalId: "terminal-1",
					ready: { pid: 1234, cwd: '/backend/workspace', shellType: this.shellType },
					profile: { profileId: "shell", title: "Shell", isDefault: true },
					reconnect: this.invalidCreateLease
						? { reconnectToken: "secret", reconnectGracePeriodMillis: this.reconnectGracePeriodMillis }
						: { reconnectToken: FIRST_TOKEN, reconnectGracePeriodMillis: this.reconnectGracePeriodMillis },
				};
			case APP_SERVER_METHODS["terminal/writeBinary"].method:
				return null;
			case APP_SERVER_METHODS['terminal/processInfo'].method:
				await this.processInfoReply;
				return { ready: { pid: 1234, cwd: '/backend/workspace', shellType: this.shellType }, cwd: '/backend/current', rows: 40, cols: 120 };
			case APP_SERVER_METHODS['terminal/detach'].method:
				return { reconnectToken: THIRD_TOKEN, reconnectGracePeriodMillis: this.reconnectGracePeriodMillis };
			case APP_SERVER_METHODS["terminal/attach"].method:
				if (this.attachError) throw this.attachError;
				await this.attachReply;
				if (this.attachFailures > 0) {
					this.attachFailures -= 1;
					throw new Error("terminal is still detaching");
				}
				this.successfulAttachments += 1;
				return {
					terminalId: "terminal-1",
					ready: { pid: 1234, cwd: '/backend/workspace', shellType: this.shellType },
					reconnect: {
						reconnectToken: this.successfulAttachments === 1 ? SECOND_TOKEN : THIRD_TOKEN,
						reconnectGracePeriodMillis: this.reconnectGracePeriodMillis,
					},
				};
			case APP_SERVER_METHODS["terminal/read"].method:
				return {
					terminalId: "terminal-1",
					chunks: this.output ? [{ sequence: 1, dataBase64: this.output.toString("base64") }] : [],
					nextSequence: this.output ? 1 : 0,
					outputGap: false,
					...(this.cwd ? {
						cwd: this.cwd, shellIntegration: {
							commandDetection: true, cwdDetection: true, hasRichCommandDetection: true, commandStorageDisabled: false, promptType: 'starship',
							commands: [{ sequence: 2, commandId: 'command-1', status: 'failed', exitCode: 7, afterOutputSequence: 2, cwd: '/invocation', command: 'echo 中文; "quoted"', isTrusted: false }], afterOutputSequence: 2,
						}
					} : {}),
					commandEvents: this.output ? [{
						sequence: 1,
						commandId: "command-1",
						status: "running",
						exitCode: null,
						afterOutputSequence: 1,
						...(this.cwd ? { cwd: '/invocation', command: 'echo 中文; \"quoted\"', isTrusted: false } : {}),
					}] : [],
					nextCommandSequence: this.output ? 1 : 0,
					commandEventGap: false,
					exited: false,
					exitCode: null,
				};
			default:
				return undefined;
		}
	}
}

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for Remote terminal recovery");
		await new Promise(resolve => setTimeout(resolve, 1));
	}
}

for (const remote of [false, true]) test(`${remote ? 'SSH' : 'local'} terminal adapter preserves raw and argv representations across resolution and creation`, async () => {
	const supervisor = new TestSupervisor();
	supervisor.operatingSystem = OperatingSystem.Windows;
	using adapter = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient);
	const service: ITerminalProcessService = remote ? adapter : new AppServerTerminalProcessService(supervisor as unknown as AppServerProtocolClient, {} as IAppServerApi);
	for (const args of ['/d /s /c "echo two words & literal;$HOME"', '', ['', 'two words', 'literal;$HOME']]) {
		const profile = { type: 'custom' as const, name: 'Raw', path: ['cmd.exe'], args };
		assert.deepEqual((await service.resolveProfile(profile)).args, args);
		await service.create({ rows: 24, cols: 80, profile, execution: { type: 'process', program: 'cmd.exe', args } });
		const create = supervisor.requests.at(-1)!;
		assert.deepEqual(create, { method: 'terminal/create', params: { rows: 24, cols: 80, profile, execution: { type: 'process', program: 'cmd.exe', args }, lifecycle: { type: remote ? 'reconnectable' : 'connectionOwned' } } });
		if (Array.isArray(args)) {
			args.push('later mutation');
			assert.deepEqual((create.params as { execution: { args: string[]; }; }).execution.args, ['', 'two words', 'literal;$HOME']);
		}
		await service.close({ terminalId: 'terminal-1' });
	}
	if (remote) {
		const args = '/d /s /c "echo once"';
		await service.create({ rows: 24, cols: 80, profile: { type: 'default' }, execution: { type: 'process', program: 'cmd.exe', args } });
		const before = supervisor.requests.filter(request => request.method === 'terminal/create').length;
		supervisor.generation++;
		await service.write({ terminalId: 'terminal-1', data: 'after reconnect' });
		assert.equal(supervisor.requests.filter(request => request.method === 'terminal/create').length, before);
		assert.equal(supervisor.successfulAttachments, 1);
	}
});

for (const remote of [false, true]) test(`${remote ? 'SSH' : 'local'} shell read adapter preserves cwd ordering and invocation directory`, async () => {
	const supervisor = new TestSupervisor();
	supervisor.cwd = { value: 'C:\\work; with spaces', isTrusted: true, afterOutputSequence: 2 };
	supervisor.output = Buffer.from('command output');
	using adapter = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient);
	const service: ITerminalProcessService = remote ? adapter : new AppServerTerminalProcessService(supervisor as unknown as AppServerProtocolClient, {} as IAppServerApi);
	await service.create({ rows: 24, cols: 80, profile: { type: 'default' }, strictEnv: true, env: { ONLY: 'literal' } });
	assert.equal((supervisor.requests.find(request => request.method === 'terminal/create')!.params as { strictEnv?: boolean; }).strictEnv, true);
	const result = await service.read({ terminalId: 'terminal-1', afterSequence: 0, afterCommandSequence: 0, maxChunks: 128 });
	assert.deepEqual(result.cwd, { value: 'C:\\work; with spaces', isTrusted: true, afterOutputSequence: 2 });
	assert.equal(result.commandEvents[0].cwd, '/invocation');
	assert.equal(result.commandEvents[0].exitCode, undefined);
	assert.equal(result.commandEvents[0].afterOutputSequence, 1);
	assert.equal(result.commandEvents[0].command, 'echo 中文; \"quoted\"');
	assert.equal(result.commandEvents[0].isTrusted, false);
	assert.equal(result.shellIntegration?.hasRichCommandDetection, true);
	assert.equal(result.shellIntegration?.promptType, 'starship');
	assert.deepEqual(result.shellIntegration?.commands[0], { sequence: 2, commandId: 'command-1', status: 'failed', exitCode: 7, afterOutputSequence: 2, cwd: '/invocation', command: 'echo 中文; \"quoted\"', isTrusted: false });
	await service.close({ terminalId: 'terminal-1' });
});
