import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import assert from "node:assert/strict";
import { suite, test } from "mocha";
import { isCancellationError } from '../../../../../base/common/errors.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from "../../../../../base/common/uri.js";
import { ITerminalProcessService, type ITerminalProcessCreateOptions, type ITerminalProcessReadResult, type TerminalProcessConnectionState } from "../../../../../platform/terminal/common/terminal.js";
import { TerminalService } from "../../browser/terminalService.js";
import { ITerminalService, type ITerminalInstance } from "../../browser/terminal.js";
import { WorkspaceContextService } from "../../../../services/workspaces/browser/workspaceContextService.js";

const DEFAULT_PROFILE = {
	profileId: "command-prompt",
	title: "Command Prompt",
	isDefault: true,
} as const;

test("TerminalService keeps empty windows off the process API and enables a folder after transition", async () => {
	const processService = new TestTerminalProcessService([]);
	using workspace = new WorkspaceContextService({ id: "empty-window" });
	using services = terminalServices(processService, workspace);
	const service = services.get(ITerminalService);

	await assert.rejects(service.getProfiles(), /TerminalUnavailable/);
	await assert.rejects(service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: "default" } }), /TerminalUnavailable/);
	assert.equal(processService.profileListCalls, 0);
	assert.equal(processService.createCalls.length, 0);

	workspace.updateWorkspace({ id: "workspace", uri: URI.file("/workspace") });
	assert.deepEqual(await service.getProfiles(), [DEFAULT_PROFILE]);
	await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: "default" } });
	assert.equal(processService.profileListCalls, 1);
	assert.equal(processService.createCalls.length, 1);
});

test("TerminalService exposes event-driven instances over the process service", async () => {
	const processService = new TestTerminalProcessService([
		readResult({
			chunks: [{
				sequence: 1,
				data: new TextEncoder().encode("hello"),
			}],
			nextSequence: 1,
			commandEvents: [{
				sequence: 1,
				commandId: "command-1",
				status: "running",
				exitCode: undefined,
				afterOutputSequence: 0,
			}, {
				sequence: 2,
				commandId: "command-1",
				status: "succeeded",
				exitCode: 0,
				afterOutputSequence: 1,
			}],
			nextCommandSequence: 2,
		}),
		readResult({
			nextSequence: 1,
			nextCommandSequence: 2,
			exited: true,
			exitCode: 0,
		}),
	]);
	using services = terminalServices(processService, folderWorkspaceContext());
	const service = services.get(ITerminalService);
	const output: Uint8Array[] = [];
	const commandStatuses: string[] = [];
	let createdInstance: ITerminalInstance | undefined;
	service.onDidCreateInstance((instance) => {
		createdInstance = instance;
		instance.onDidWriteData((data) => output.push(data));
		instance.onDidChangeCommandStatus((event) => commandStatuses.push(event.status));
	});

	const instance = await service.createTerminal({
		dimensions: { rows: 24, cols: 80 },
		profile: { type: "default" },
	});
	await waitFor(() => instance.state === "exited");

	assert.equal(instance, createdInstance);
	assert.equal(service.activeInstance, instance);
	assert.equal(instance.title, "cmd");
	assert.equal(new TextDecoder().decode(output[0]), "hello");
	assert.deepEqual(commandStatuses, ["running", "succeeded"]);
	assert.equal(instance.exitCode, 0);
	assert.deepEqual(processService.createCalls, [{
		rows: 24,
		cols: 80,
		profile: { type: "default" },
	}]);
	assert.deepEqual(processService.readCursors, [0, 1]);
	assert.deepEqual(processService.commandReadCursors, [0, 2]);
});

test("TerminalService batches input, coalesces resize, and releases terminals", async () => {
	const processService = new TestTerminalProcessService([]);
	using services = terminalServices(processService, folderWorkspaceContext());
	const service = services.get(ITerminalService);
	const instance = await service.createTerminal({
		dimensions: { rows: 20, cols: 60 },
		profile: { type: "profile", profileId: "command-prompt" },
	});

	instance.write("a");
	instance.write("b");
	instance.resize({ rows: 30, cols: 100 });
	instance.resize({ rows: 31, cols: 101 });
	await waitFor(() => processService.writeCalls.length === 1 && processService.resizeCalls.length === 1);
	await service.closeTerminal(instance);

	assert.equal(processService.writeCalls[0].data, "ab");
	assert.deepEqual(processService.resizeCalls[0], {
		terminalId: "terminal-1",
		rows: 31,
		cols: 101,
	});
	assert.deepEqual(processService.closeCalls, ["terminal-1"]);
	assert.equal(service.instances.length, 0);
	assert.equal(service.activeInstance, undefined);
});

test("TerminalService keeps multiple instances and safely relaunches after a crash", async () => {
	const processService = new TestTerminalProcessService([]);
	using services = terminalServices(processService, folderWorkspaceContext());
	const service = services.get(ITerminalService);
	const first = await service.createTerminal({
		dimensions: { rows: 24, cols: 80 },
		profile: { type: "default" },
	});
	const second = await service.createTerminal({
		dimensions: { rows: 30, cols: 100 },
		profile: { type: "profile", profileId: "command-prompt" },
	});

	assert.equal(service.instances.length, 2);
	assert.equal(service.activeInstance, second);
	assert.equal(first.title, "cmd 1");
	assert.equal(second.title, "cmd 2");
	service.setActiveInstance(first);
	assert.equal(service.activeInstance, first);

	processService.emitConnectionState("crashed");
	await waitFor(() => first.state === "disconnected" && second.state === "disconnected");
	processService.emitConnectionState("ready");
	assert.equal(first.state, "disconnected");
	await service.relaunchTerminal(first, { rows: 25, cols: 90 });

	assert.equal(first.state, "running");
	assert.equal(first.id, "terminal-instance-1");
	assert.equal(processService.createCalls.length, 3);
	assert.deepEqual(processService.createCalls[2], {
		rows: 25,
		cols: 90,
		profile: { type: "profile", profileId: "command-prompt" },
	});
});

test("TerminalService resumes reconnectable terminals from their existing output cursors", async () => {
	const processService = new TestTerminalProcessService([
		readResult({ nextSequence: 4, nextCommandSequence: 2 }),
	], "reconnectable");
	using services = terminalServices(processService, folderWorkspaceContext());
	const service = services.get(ITerminalService);
	const instance = await service.createTerminal({
		dimensions: { rows: 24, cols: 80 },
		profile: { type: "default" },
	});
	const output: string[] = [];
	instance.onDidWriteData(data => output.push(new TextDecoder().decode(data)));
	await waitFor(() => processService.readCursors.length === 1);

	processService.emitConnectionState("crashed");
	await waitFor(() => instance.state === "reconnecting");
	const supersededRead = deferred<ITerminalProcessReadResult>();
	processService.queueRead(supersededRead.promise);
	processService.emitConnectionState("ready");
	await waitFor(() => processService.readCursors.length >= 2);
	assert.equal(instance.state, "reconnecting");
	assert.equal(output.some(value => value.includes("terminal reconnected")), false);

	processService.emitConnectionState("crashed");
	supersededRead.resolve(readResult({ nextSequence: 4, nextCommandSequence: 2 }));
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(instance.state, "reconnecting");

	processService.queueRead(readResult({ nextSequence: 4, nextCommandSequence: 2 }));
	processService.emitConnectionState("ready");
	await waitFor(() => instance.state === "running" && processService.readCursors.length >= 3);

	assert.equal(processService.createCalls.length, 1);
	assert.deepEqual(processService.readCursors.slice(0, 3), [0, 4, 4]);
	assert.deepEqual(processService.commandReadCursors.slice(0, 3), [0, 2, 2]);
	assert.ok(output.some(value => value.includes("terminal reconnecting")));
	assert.ok(output.some(value => value.includes("terminal reconnected")));
});

test("TerminalService exposes failed reconnectable recovery as a relaunchable error", async () => {
	const processService = new TestTerminalProcessService([
		readResult({ nextSequence: 1 }),
	], "reconnectable");
	using services = terminalServices(processService, folderWorkspaceContext());
	const service = services.get(ITerminalService);
	const instance = await service.createTerminal({
		dimensions: { rows: 24, cols: 80 },
		profile: { type: "default" },
	});
	const output: string[] = [];
	instance.onDidWriteData(data => output.push(new TextDecoder().decode(data)));
	await waitFor(() => processService.readCursors.length === 1);

	processService.emitConnectionState("stopping");
	await waitFor(() => instance.state === "reconnecting");
	processService.queueRead(Promise.reject(new Error("old broker lease was abandoned")));
	processService.emitConnectionState("ready");
	await waitFor(() => instance.state === "error");

	assert.ok(output.some(value => value.includes("terminal recovery failed; relaunch required")));
	await service.relaunchTerminal(instance, { rows: 30, cols: 100 });
	assert.equal(instance.state, "running");
	assert.equal(processService.createCalls.length, 2);
});

test("TerminalService renumbers only concurrently open terminals", async () => {
	const processService = new TestTerminalProcessService([]);
	using services = terminalServices(processService, folderWorkspaceContext());
	const service = services.get(ITerminalService);
	const first = await service.createTerminal({
		dimensions: { rows: 24, cols: 80 },
		profile: { type: "default" },
	});
	const second = await service.createTerminal({
		dimensions: { rows: 24, cols: 80 },
		profile: { type: "default" },
	});

	assert.equal(first.title, "cmd 1");
	assert.equal(second.title, "cmd 2");
	await service.closeTerminal(first);
	assert.equal(second.title, "cmd");

	const replacement = await service.createTerminal({
		dimensions: { rows: 24, cols: 80 },
		profile: { type: "default" },
	});
	assert.equal(second.title, "cmd 1");
	assert.equal(replacement.title, "cmd 2");
	await service.closeTerminal(replacement);
	assert.equal(second.title, "cmd");
});

suite('Terminal process identity and raw input', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('publishes backend identity and changes it only on relaunch', async () => {
		const processes = new TestTerminalProcessService([]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		const service = services.get(ITerminalService);
		const instance = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		assert.deepEqual({ pid: instance.processId, cwd: instance.initialCwd }, { pid: 1001, cwd: '/backend/workspace' });
		processes.emitConnectionState('crashed');
		processes.emitConnectionState('ready');
		await service.relaunchTerminal(instance, { rows: 25, cols: 90 });
		assert.deepEqual({ pid: instance.processId, cwd: instance.initialCwd }, { pid: 1002, cwd: '/backend/workspace' });
	});

	test('raw mouse bytes stay between preceding and following text, including split batches', async () => {
		const processes = new TestTerminalProcessService([]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		const service = services.get(ITerminalService);
		const instance = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		const text = '中'.repeat(25_000);
		instance.write(text);
		const bytes = instance.processBinary('\0\x80\xff');
		instance.write('after');
		await bytes;
		await waitFor(() => processes.writeCalls.length === 4);
		assert.deepEqual(processes.writeCalls.map(call => call.data), [text.slice(0, 20_480), text.slice(20_480), new Uint8Array([0, 0x80, 0xff]), 'after']);
	});

	test('raw input rejects after closure without reaching another process', async () => {
		const processes = new TestTerminalProcessService([]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		const service = services.get(ITerminalService);
		const instance = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		await service.closeTerminal(instance);
		await assert.rejects(instance.processBinary('\xff'), isCancellationError);
		assert.deepEqual(processes.writeCalls, []);
	});
});

class TestTerminalProcessService implements ITerminalProcessService {
	profileListCalls = 0;
	readonly createCalls: ITerminalProcessCreateOptions[] = [];
	readonly writeCalls: Array<{ terminalId: string; data: string | Uint8Array }> = [];
	readonly resizeCalls: Array<{ terminalId: string; rows: number; cols: number }> = [];
	readonly readCursors: number[] = [];
	readonly commandReadCursors: number[] = [];
	readonly closeCalls: string[] = [];
	public readonly creationGates: Promise<void>[] = [];
	public readonly closeGates: Promise<void>[] = [];
	public readonly closeOptions: Array<{ terminalId: string; dirId?: string }> = [];
	private readonly connectionListeners = new Set<(state: TerminalProcessConnectionState) => void>();
	private connectionState: TerminalProcessConnectionState = "ready";

	constructor(private readonly reads: Array<ITerminalProcessReadResult | Promise<ITerminalProcessReadResult>>, private readonly connectionPersistence: "connectionOwned" | "reconnectable" = "connectionOwned") {}

	async listProfiles() {
		this.profileListCalls += 1;
		return [DEFAULT_PROFILE];
	}

	async create(params: ITerminalProcessCreateOptions) {
		this.createCalls.push(params);
		const terminalId = `terminal-${this.createCalls.length}`;
		await this.creationGates.shift();
		return {
			terminalId,
			ready: { pid: this.createCalls.length + 1000, cwd: '/backend/workspace' },
			profile: DEFAULT_PROFILE,
			connectionPersistence: this.connectionPersistence,
		};
	}

	queueRead(result: ITerminalProcessReadResult | Promise<ITerminalProcessReadResult>): void {
		this.reads.push(result);
	}

	async write(params: { terminalId: string; data: string | Uint8Array }) {
		this.writeCalls.push(params);
	}

	async resize(params: { terminalId: string; rows: number; cols: number }) {
		this.resizeCalls.push(params);
	}

	async read(params: { terminalId: string; afterSequence: number; afterCommandSequence: number; maxChunks: number }) {
		this.readCursors.push(params.afterSequence);
		this.commandReadCursors.push(params.afterCommandSequence);
		return await (this.reads.shift() ?? readResult({ nextSequence: params.afterSequence, nextCommandSequence: params.afterCommandSequence }));
	}

	public async close(params: { terminalId: string; dirId?: string }): Promise<void> {
		this.closeCalls.push(params.terminalId);
		this.closeOptions.push(params);
		await this.closeGates.shift();
	}

	async getConnectionState(): Promise<TerminalProcessConnectionState> {
		return this.connectionState;
	}

	onConnectionState(listener: (state: TerminalProcessConnectionState) => void) {
		this.connectionListeners.add(listener);
		return toDisposable(() => this.connectionListeners.delete(listener));
	}

	emitConnectionState(state: TerminalProcessConnectionState): void {
		this.connectionState = state;
		for (const listener of this.connectionListeners) listener(state);
	}
}

function folderWorkspaceContext(): WorkspaceContextService {
	return new WorkspaceContextService({ id: "workspace", uri: URI.file("/workspace") });
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (error: Error) => void } {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((accept, fail) => {
		resolve = accept;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function readResult(overrides: Partial<ITerminalProcessReadResult>): ITerminalProcessReadResult {
	return {
		terminalId: "terminal-1",
		chunks: [],
		nextSequence: 0,
		outputGap: false,
		commandEvents: [],
		nextCommandSequence: 0,
		commandEventGap: false,
		exited: false,
		exitCode: undefined,
		...overrides,
	};
}

async function waitFor(condition: () => boolean, timeoutMillis = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMillis;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for terminal state");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

function terminalServices(processService: ITerminalProcessService, workspace: IWorkspaceContextService): InstantiationService {
	const services = new InstantiationService(new ServiceCollection([ITerminalProcessService, processService], [IWorkspaceContextService, workspace]));
	services.registerSingleton(ITerminalService, () => services.createInstance(TerminalService));
	return services;
}

test('TerminalService rejects missing process and workspace registrations before creating a PTY', () => {
	const processService = new TestTerminalProcessService([]);
	using missingProcess = new InstantiationService(new ServiceCollection([IWorkspaceContextService, folderWorkspaceContext()]));
	assert.throws(() => missingProcess.createInstance(TerminalService), /Unknown service: terminalProcessService/);
	using missingWorkspace = new InstantiationService(new ServiceCollection([ITerminalProcessService, processService]));
	assert.throws(() => missingWorkspace.createInstance(TerminalService), /Unknown service: workspaceContextService/);
	assert.deepEqual(processService.createCalls, []);
});

suite('TerminalService lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('list changes describe the final membership, order, titles and active instance', async () => {
		const processService = new TestTerminalProcessService([]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processService, workspace);
		const service = services.get(ITerminalService);
		const snapshots: Array<{ ids: string[]; titles: string[]; active: string | undefined }> = [];
		using listener = service.onDidChangeInstances(() => snapshots.push({
			ids: service.instances.map(instance => instance.id),
			titles: service.instances.map(instance => instance.title),
			active: service.activeInstance?.id,
		}));
		const first = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		const second = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		service.moveTerminal(first, 1);
		await service.closeTerminal(second);
		first.dispose();
		await first.close();
		assert.deepEqual(snapshots, [
			{ ids: [first.id], titles: ['cmd'], active: first.id },
			{ ids: [first.id, second.id], titles: ['cmd 1', 'cmd 2'], active: second.id },
			{ ids: [second.id, first.id], titles: ['cmd 1', 'cmd 2'], active: second.id },
			{ ids: [first.id], titles: ['cmd'], active: first.id },
			{ ids: [], titles: [], active: undefined },
		]);
	});

	for (const persistence of ['connectionOwned', 'reconnectable'] as const) {
		test(`${persistence} creation respects a connection loss before the backend result arrives`, async () => {
			const creation = deferred<void>();
			const processService = new TestTerminalProcessService([], persistence);
			processService.creationGates.push(creation.promise);
			using workspace = folderWorkspaceContext();
			using services = terminalServices(processService, workspace);
			const service = services.get(ITerminalService);
			const outputs: string[] = [];
			using listeners = new DisposableStore();
			listeners.add(service.onDidCreateInstance(instance => listeners.add(instance.onDidWriteData(data => outputs.push(new TextDecoder().decode(data))))));
			const pending = service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
			processService.emitConnectionState('crashed');
			creation.resolve();
			const instance = await pending;
			instance.write('unsent');
			instance.resize({ rows: 30, cols: 100 });
			await Promise.resolve();
			assert.deepEqual({
				state: instance.state,
				reads: processService.readCursors,
				writes: processService.writeCalls,
				resizes: processService.resizeCalls,
			}, {
				state: persistence === 'reconnectable' ? 'reconnecting' : 'disconnected',
				reads: [],
				writes: [],
				resizes: [],
			});
			assert.match(outputs.join(''), persistence === 'reconnectable' ? /terminal reconnecting/ : /terminal connection lost/);
			processService.emitConnectionState('ready');
			if (persistence === 'reconnectable') {
				await waitFor(() => instance.state === 'running');
				assert.deepEqual(processService.readCursors, [0]);
			} else {
				assert.equal(instance.state, 'disconnected');
				assert.deepEqual(processService.readCursors, []);
			}
			await instance.close();
		});

		test(`${persistence} relaunch respects a connection loss while replacement creation is pending`, async () => {
			const creation = deferred<void>();
			const processService = new TestTerminalProcessService([readResult({ exited: true })], persistence);
			using workspace = folderWorkspaceContext();
			using services = terminalServices(processService, workspace);
			const service = services.get(ITerminalService);
			const instance = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
			await waitFor(() => instance.state === 'exited');
			processService.creationGates.push(creation.promise);
			const pending = service.relaunchTerminal(instance, { rows: 30, cols: 100 });
			await waitFor(() => processService.createCalls.length === 2);
			processService.emitConnectionState('crashed');
			creation.resolve();
			await pending;
			assert.deepEqual({ state: instance.state, reads: processService.readCursors }, {
				state: persistence === 'reconnectable' ? 'reconnecting' : 'disconnected',
				reads: [0],
			});
			processService.emitConnectionState('ready');
			if (persistence === 'reconnectable') {
				await waitFor(() => instance.state === 'running');
				assert.deepEqual(processService.readCursors, [0, 0]);
			} else {
				assert.equal(instance.state, 'disconnected');
				assert.deepEqual(processService.readCursors, [0]);
			}
			await instance.close();
		});
	}

	test('closes a late creation without publishing an instance after window disposal', async () => {
		const creation = deferred<void>();
		const processService = new TestTerminalProcessService([]);
		processService.creationGates.push(creation.promise);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processService, workspace);
		const service = services.get(ITerminalService);
		const created: ITerminalInstance[] = [];
		using listener = service.onDidCreateInstance(instance => created.push(instance));
		const pending = service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		services.dispose();
		creation.resolve();
		await assert.rejects(pending, isCancellationError);
		await assert.rejects(service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } }), isCancellationError);
		assert.deepEqual({
			created,
			instances: service.instances,
			reads: processService.readCursors,
			closes: processService.closeCalls,
			creates: processService.createCalls.length,
		}, {
			created: [],
			instances: [],
			reads: [],
			closes: ['terminal-1'],
			creates: 1,
		});
	});

	test('joins concurrent closes until the backend acknowledges release', async () => {
		const release = deferred<void>();
		const processService = new TestTerminalProcessService([]);
		processService.closeGates.push(release.promise);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processService, workspace);
		const service = services.get(ITerminalService);
		const instance = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		const disposed: string[] = [];
		using listener = service.onDidDisposeInstance(value => disposed.push(value.id));
		const completed: string[] = [];
		const first = service.closeTerminal(instance).then(() => completed.push('first'));
		const second = service.closeTerminal(instance).then(() => completed.push('second'));
		await Promise.resolve();
		assert.deepEqual(completed, []);
		release.resolve();
		await Promise.all([first, second]);
		assert.deepEqual({
			closes: processService.closeCalls,
			disposed,
			instances: service.instances,
			active: service.activeInstance,
		}, {
			closes: ['terminal-1'],
			disposed: [instance.id],
			instances: [],
			active: undefined,
		});
	});

	test('direct instance disposal removes the terminal and stops queued IO', async () => {
		const read = deferred<ITerminalProcessReadResult>();
		const processService = new TestTerminalProcessService([read.promise]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processService, workspace);
		const service = services.get(ITerminalService);
		const instance = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		const output: Uint8Array[] = [];
		using listener = instance.onDidWriteData(data => output.push(data));
		instance.write('queued');
		instance.resize({ rows: 30, cols: 100 });
		instance.dispose();
		read.resolve(readResult({ chunks: [{ sequence: 1, data: new Uint8Array([65]) }], nextSequence: 1 }));
		await instance.close();
		services.dispose();
		assert.deepEqual({
			output,
			writes: processService.writeCalls,
			resizes: processService.resizeCalls,
			closes: processService.closeCalls,
			instances: service.instances,
		}, {
			output: [],
			writes: [],
			resizes: [],
			closes: ['terminal-1'],
			instances: [],
		});
	});

	test('concurrent relaunches create one replacement with the first requested dimensions', async () => {
		const creation = deferred<void>();
		const processService = new TestTerminalProcessService([readResult({ exited: true, exitCode: 17 })]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processService, workspace);
		const service = services.get(ITerminalService);
		const instance = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		await waitFor(() => instance.state === 'exited');
		processService.creationGates.push(creation.promise);
		const first = service.relaunchTerminal(instance, { rows: 30, cols: 100 });
		await waitFor(() => processService.createCalls.length === 2);
		const second = service.relaunchTerminal(instance, { rows: 40, cols: 120 });
		creation.resolve();
		await Promise.all([first, second]);
		await instance.close();
		assert.deepEqual({ creates: processService.createCalls, closes: processService.closeCalls }, {
			creates: [
				{ rows: 24, cols: 80, profile: { type: 'default' } },
				{ rows: 30, cols: 100, profile: { type: 'profile', profileId: 'command-prompt' } },
			],
			closes: ['terminal-1', 'terminal-2'],
		});
	});

	test('closing during relaunch waits for and releases the replacement without reviving the instance', async () => {
		const creation = deferred<void>();
		const processService = new TestTerminalProcessService([readResult({ exited: true })]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processService, workspace);
		const service = services.get(ITerminalService);
		const instance = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		await waitFor(() => instance.state === 'exited');
		const states: string[] = [];
		using listener = instance.onDidChangeState(state => states.push(state));
		processService.creationGates.push(creation.promise);
		const relaunch = service.relaunchTerminal(instance, { rows: 30, cols: 100 });
		const cancelled = assert.rejects(relaunch, isCancellationError);
		await waitFor(() => processService.createCalls.length === 2);
		let completed = false;
		const close = instance.close().then(() => { completed = true; });
		await Promise.resolve();
		assert.equal(completed, false);
		creation.resolve();
		await Promise.all([close, cancelled]);
		assert.deepEqual({
			states,
			reads: processService.readCursors,
			closes: processService.closeCalls,
			instances: service.instances,
		}, {
			states: [],
			reads: [0],
			closes: ['terminal-1', 'terminal-2'],
			instances: [],
		});
	});

	test('closing before old-process release prevents replacement creation', async () => {
		const release = deferred<void>();
		const processService = new TestTerminalProcessService([readResult({ exited: true })]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processService, workspace);
		const service = services.get(ITerminalService);
		const instance = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		await waitFor(() => instance.state === 'exited');
		processService.closeGates.push(release.promise);
		const relaunch = service.relaunchTerminal(instance, { rows: 30, cols: 100 });
		const cancelled = assert.rejects(relaunch, isCancellationError);
		const close = instance.close();
		release.resolve();
		await Promise.all([close, cancelled]);
		assert.deepEqual({ creates: processService.createCalls.length, closes: processService.closeCalls, instances: service.instances }, {
			creates: 1,
			closes: ['terminal-1'],
			instances: [],
		});
	});

	test('reports a failed close to all waiters while releasing UI ownership', async () => {
		const release = deferred<void>();
		const processService = new TestTerminalProcessService([]);
		processService.closeGates.push(release.promise);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processService, workspace);
		const service = services.get(ITerminalService);
		const instance = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		const failure = new Error('PTY close failed');
		const first = assert.rejects(instance.close(), error => error === failure);
		const second = assert.rejects(instance.close(), error => error === failure);
		release.reject(failure);
		await Promise.all([first, second]);
		services.dispose();
		assert.deepEqual({ closes: processService.closeCalls, instances: service.instances }, { closes: ['terminal-1'], instances: [] });
	});

	test('a failed relaunch can be retried without creating concurrent replacements', async () => {
		const creation = deferred<void>();
		const processService = new TestTerminalProcessService([readResult({ exited: true })]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processService, workspace);
		const service = services.get(ITerminalService);
		const instance = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		await waitFor(() => instance.state === 'exited');
		processService.creationGates.push(creation.promise);
		const failure = new Error('PTY creation failed');
		const failed = assert.rejects(service.relaunchTerminal(instance, { rows: 30, cols: 100 }), error => error === failure);
		creation.reject(failure);
		await failed;
		assert.equal(instance.state, 'error');
		await service.relaunchTerminal(instance, { rows: 40, cols: 120 });
		assert.equal(instance.state, 'running');
		await instance.close();
		assert.deepEqual(processService.closeCalls, ['terminal-1', 'terminal-3']);
	});

	test('window disposal releases a late relaunch and publishes no further output', async () => {
		const creation = deferred<void>();
		const processService = new TestTerminalProcessService([readResult({ exited: true })]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processService, workspace);
		const service = services.get(ITerminalService);
		const instance = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		await waitFor(() => instance.state === 'exited');
		const output: Uint8Array[] = [];
		using listener = instance.onDidWriteData(data => output.push(data));
		processService.creationGates.push(creation.promise);
		const cancelled = assert.rejects(service.relaunchTerminal(instance, { rows: 30, cols: 100 }), isCancellationError);
		await waitFor(() => processService.createCalls.length === 2);
		services.dispose();
		creation.resolve();
		await cancelled;
		await instance.close();
		assert.deepEqual({ output, instances: service.instances, closes: processService.closeCalls }, {
			output: [],
			instances: [],
			closes: ['terminal-1', 'terminal-2'],
		});
	});

	test('late creation cleanup keeps the selected workspace binding across window changes', async () => {
		const creation = deferred<void>();
		const processService = new TestTerminalProcessService([]);
		processService.creationGates.push(creation.promise);
		using workspace = new WorkspaceContextService({
			id: 'multi-root',
			folders: [
				{ id: 'first', uri: URI.file('/first'), name: 'first', index: 0 },
				{ id: 'second', uri: URI.file('/second'), name: 'second', index: 1 },
			],
		});
		using services = terminalServices(processService, workspace);
		const service = services.get(ITerminalService);
		const cancelled = assert.rejects(service.createTerminal({ dirId: 'second', dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } }), isCancellationError);
		workspace.updateWorkspace({ id: 'other', uri: URI.file('/other') });
		services.dispose();
		creation.resolve();
		await cancelled;
		assert.deepEqual(processService.closeOptions, [{ dirId: 'second', terminalId: 'terminal-1' }]);
	});
});
