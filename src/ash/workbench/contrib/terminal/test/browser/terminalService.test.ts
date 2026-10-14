import { ShellEnvDetectionCapability } from '../../../../../platform/terminal/common/capabilities/shellEnvDetectionCapability.js';
import { TerminalCapabilityStore, TerminalCapabilityStoreMultiplexer } from '../../../../../platform/terminal/common/capabilities/terminalCapabilityStore.js';
import { TerminalGroupService } from '../../browser/terminalGroupService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IQuickInputService, type IInputOptions } from '../../../../../platform/quickinput/common/quickInput.js';
import { IConfigurationResolverService } from '../../../../services/configurationResolver/common/configurationResolver.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { TerminalCommandId } from '../../common/terminal.js';
import '../../../terminalContrib/sendSequence/browser/terminal.sendSequence.contribution.js';
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
import { TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { TerminalService } from "../../browser/terminalService.js";
import { TerminalProcessManager } from '../../browser/terminalProcessManager.js';
import { AgentHostTerminalService } from '../../browser/agentHostTerminalService.js';
import { BasePty } from '../../common/basePty.js';
import { TerminalProcessExtHostProxy } from '../../browser/terminalProcessExtHostProxy.js';
import { ITerminalService, type ITerminalInstance, type ITerminalCommandStatusEvent } from "../../../../services/terminal/browser/terminal.js";
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

test('a single Session folder keeps its process route through creation and closing after selection changes', async () => {
	const processService = new TestTerminalProcessService([]);
	const scope = 'session:thread%3Aone:%2Fsession-workspace';
	using workspace = new WorkspaceContextService({ id: 'session', folders: [{ id: scope, uri: URI.file('/session-workspace'), name: 'session', index: 0 }] });
	using services = terminalServices(processService, workspace);
	const service = services.get(ITerminalService);
	const originalList = processService.listProfiles.bind(processService);
	processService.listProfiles = async (dirId?: string) => { assert.equal(dirId, scope); return originalList(); };
	await service.getProfiles();
	const instance = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
	assert.equal(processService.createCalls[0]?.dirId, scope);
	workspace.updateWorkspace({ id: 'other', uri: URI.file('/other') });
	await service.closeTerminal(instance);
	assert.deepEqual(processService.closeOptions, [{ dirId: scope, terminalId: 'terminal-1' }]);
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
	const output: string[] = [];
	const commandStatuses: string[] = [];
	let createdInstance: ITerminalInstance | undefined;
	service.onDidCreateInstance((instance) => {
		createdInstance = instance;
		instance.onDidWriteData((event) => output.push(event.data));
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
	assert.equal(output[0], "hello");
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

test('a Shell directory query uses the backend cwd and retires with its PTY', async () => {
	const processes = new TestTerminalProcessService([]);
	using services = terminalServices(processes, folderWorkspaceContext());
	const terminals = services.get(ITerminalService);
	const instance = await terminals.createTerminal({ dimensions: { cols: 80, rows: 24 }, profile: { type: 'default' } });
	const query = instance.capabilities!.get(TerminalCapability.NaiveCwdDetection)!;
	assert.equal(await query.getCwd(), '/workspace/current');
	assert.notEqual(instance.initialCwd, '/workspace/current');
	await instance.close();
	assert.equal(instance.capabilities!.has(TerminalCapability.NaiveCwdDetection), false);
	await assert.rejects(query.getCwd());
});

test("TerminalService batches input, coalesces resize, and releases terminals", async () => {
	const processService = new TestTerminalProcessService([]);
	using services = terminalServices(processService, folderWorkspaceContext());
	const service = services.get(ITerminalService);
	const instance = await service.createTerminal({
		dimensions: { rows: 20, cols: 60 },
		profile: { type: "profile", profileId: "command-prompt" },
	});

	const sent = Promise.all([instance.sendText("a", false), instance.sendText("b", false)]);
	instance.resize({ rows: 30, cols: 100 });
	instance.resize({ rows: 31, cols: 101 });
	await waitFor(() => processService.writeCalls.length === 1 && processService.resizeCalls.length === 1);
	await sent;
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

test('TerminalService relaunch retains custom candidates, literal argv, environment and presentation', async () => {
	const processes = new TestTerminalProcessService([]);
	using services = terminalServices(processes, folderWorkspaceContext());
	const terminals = services.get(ITerminalService);
	const path = ['/missing/shell', '/execution/shell'];
	const args = ['literal;$HOME'];
	const env = { PROFILE: 'original value', REMOVED: null };
	const terminal = await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'custom', name: 'Custom shell', path, args }, env, cwd: '/workspace/subdirectory', icon: { id: 'terminal-git-bash' }, color: 'terminal.ansiGreen' });
	path[1] = '/changed/shell'; args[0] = 'changed'; env.PROFILE = 'changed';
	processes.emitConnectionState('crashed');
	await waitFor(() => terminal.state === 'disconnected');
	processes.emitConnectionState('ready');
	await terminals.relaunchTerminal(terminal, { rows: 30, cols: 100 });
	assert.deepEqual(processes.createCalls[1], { rows: 30, cols: 100, profile: { type: 'custom', name: 'Custom shell', path: ['/missing/shell', '/execution/shell'], args: ['literal;$HOME'] }, env: { PROFILE: 'original value', REMOVED: null }, cwd: '/workspace/subdirectory' });
	assert.equal(terminal.profile.icon?.id, 'terminal-git-bash');
	assert.equal(terminal.profile.color, 'terminal.ansiGreen');
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
	const command = { sequence: 2, commandId: 'initial', status: 'completed' as const, exitCode: undefined, afterOutputSequence: 4, command: 'retained command', isTrusted: true };
	const integration = { commandDetection: true, cwdDetection: true, hasRichCommandDetection: true, commandStorageDisabled: false, commands: [command], afterOutputSequence: 4 };
	const processService = new TestTerminalProcessService([
		readResult({
			chunks: [{ sequence: 4, data: new TextEncoder().encode('initial output') }],
			nextSequence: 4,
			commandEvents: [command], shellIntegration: integration,
			nextCommandSequence: 2,
		}),
	], "reconnectable");
	using services = terminalServices(processService, folderWorkspaceContext());
	const service = services.get(ITerminalService);
	const instance = await service.createTerminal({
		dimensions: { rows: 24, cols: 80 },
		profile: { type: "default" },
	});
	const output: string[] = [];
	instance.onDidWriteData(data => output.push(data.data));
	let initialReadConsumed = false;
	using commandListener = instance.onDidChangeCommandStatus(() => { initialReadConsumed = true; });
	await waitFor(() => initialReadConsumed);

	processService.emitConnectionState("crashed");
	await waitFor(() => instance.state === "reconnecting");
	const supersededRead = deferred<ITerminalProcessReadResult>();
	processService.queueRead(supersededRead.promise);
	processService.emitConnectionState("ready");
	await waitFor(() => processService.readCursors.length >= 2);
	assert.equal(instance.state, "reconnecting");
	assert.equal(output.some(value => value.includes("terminal reconnected")), false);

	processService.emitConnectionState("crashed");
	supersededRead.resolve(readResult({ nextSequence: 4, nextCommandSequence: 2, shellIntegration: integration }));
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(instance.state, "reconnecting");

	processService.queueRead(readResult({ nextSequence: 4, nextCommandSequence: 2, shellIntegration: integration }));
	processService.emitConnectionState("ready");
	await waitFor(() => instance.state === "running" && processService.readCursors.length >= 3);

	assert.equal(processService.createCalls.length, 1);
	assert.deepEqual(instance.shellIntegration?.commands, [{ commandId: 'initial', status: 'completed', exitCode: undefined, command: 'retained command', isTrusted: true }]);
	assert.equal(instance.shellIntegration?.hasRichCommandDetection, true);
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
	instance.onDidWriteData(data => output.push(data.data));
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
		const textSent = instance.sendText(text, false);
		const bytes = instance.processBinary('\0\x80\xff');
		const following = instance.sendText('after', false);
		await Promise.all([textSent, bytes, following]);
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

	for (const binary of [false, true]) test(`custom PTY ${binary ? 'uses its declared binary port' : 'does not convert binary input into text'}`, async () => {
		const processes = new TestTerminalProcessService([]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		const text: string[] = [];
		const bytes: string[] = [];
		class TestPty extends BasePty {
			readonly processBinary = binary ? async (data: string) => { bytes.push(data); } : undefined;
			input(data: string): void { text.push(data); }
			async start(): Promise<void> { }
			shutdown(): void { }
		}
		const instance = await services.get(ITerminalService).createTerminal({
			dimensions: { cols: 80, rows: 24 }, deferStart: true,
			config: { customPtyImplementation: id => new TestPty(id, false) },
		});
		if (binary) await instance.processBinary('\0\x80\xff\n');
		else await assert.rejects(instance.processBinary('\0\x80\xff\n'), isCancellationError);
		assert.deepEqual(bytes, binary ? ['\0\x80\xff\n'] : []);
		assert.deepEqual(text, []);
		assert.deepEqual(processes.writeCalls, []);
		await instance.close();
		await assert.rejects(instance.processBinary('late'), isCancellationError);
	});

	test('sendText over an extension PTY waits for the provider and preserves its failure', async () => {
		const processes = new TestTerminalProcessService([]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		const started = deferred<void>();
		const acknowledgement = deferred<import('../../../../../platform/agentHost/common/extensionHostApi.js').JsonValue>();
		const input: string[] = [];
		const instance = await services.get(ITerminalService).createTerminal({
			dimensions: { cols: 80, rows: 24 }, deferStart: true,
			config: {
				customPtyImplementation: id => new TerminalProcessExtHostProxy(id, 'provider-pty', true, 80, 24, async (operation, payload) => {
					if (operation === 'inputTaskTerminal') {
						input.push((payload as { data: string; }).data);
						started.resolve();
						return acknowledgement.promise;
					}
					return { events: [] };
				}, () => { })
			},
		});
		instance.start();
		const failure = new Error('Provider input failed');
		let completed = false;
		const rejected = assert.rejects(instance.sendText('中文\n', true).then(() => { completed = true; }), error => error === failure);
		await started.promise;
		assert.equal(completed, false);
		acknowledgement.reject(failure);
		await rejected;
		assert.deepEqual(input, ['中文\r']);
		assert.equal(instance.state, 'exited');
		assert.deepEqual(processes.createCalls, []);
		await instance.close();
	});
});

class TestTerminalProcessService implements ITerminalProcessService {
	async resolveProfile(): Promise<import("../../../../../platform/terminal/common/terminal.js").ITerminalResolvedProfile> { return { profile: DEFAULT_PROFILE, executable: "cmd.exe", args: [] }; }
	profileListCalls = 0;
	readonly createCalls: ITerminalProcessCreateOptions[] = [];
	readonly writeCalls: Array<{ terminalId: string; data: string | Uint8Array; }> = [];
	readonly resizeCalls: Array<{ terminalId: string; rows: number; cols: number; }> = [];
	readonly readCursors: number[] = [];
	readonly commandReadCursors: number[] = [];
	readonly closeCalls: string[] = [];
	public readonly writeGates: Promise<void>[] = [];
	public readonly resizeGates: Promise<void>[] = [];
	public readonly creationGates: Promise<void>[] = [];
	public readonly closeGates: Promise<void>[] = [];
	public readonly closeOptions: Array<{ terminalId: string; dirId?: string; }> = [];
	private readonly connectionListeners = new Set<(state: TerminalProcessConnectionState) => void>();
	private connectionState: TerminalProcessConnectionState = "ready";

	constructor(private readonly reads: Array<ITerminalProcessReadResult | Promise<ITerminalProcessReadResult>>, private readonly connectionPersistence: "connectionOwned" | "reconnectable" = "connectionOwned") { }

	async getEnvironment(): Promise<Readonly<Record<string, string>>> { return {}; }
	async getProcessInfo() {
		return { ready: { pid: 1, cwd: '/workspace' }, cwd: '/workspace/current', rows: 24, cols: 80 };
	}

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

	async write(params: { terminalId: string; data: string | Uint8Array; }) {
		this.writeCalls.push(params);
		await this.writeGates.shift();
	}

	async resize(params: { terminalId: string; rows: number; cols: number; }) {
		this.resizeCalls.push(params);
		await this.resizeGates.shift();
	}

	async read(params: { terminalId: string; afterSequence: number; afterCommandSequence: number; maxChunks: number; }) {
		this.readCursors.push(params.afterSequence);
		this.commandReadCursors.push(params.afterCommandSequence);
		return await (this.reads.shift() ?? readResult({ nextSequence: params.afterSequence, nextCommandSequence: params.afterCommandSequence }));
	}

	public async close(params: { terminalId: string; dirId?: string; }): Promise<void> {
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

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (error: Error) => void; } {
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

	for (const disposeEarly of [false, true]) test(`retired PTY cleanup preserves its replacement registration with early disposal ${disposeEarly}`, async () => {
		const release = deferred<void>();
		const processes = new TestTerminalProcessService([]);
		processes.closeGates.push(release.promise);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		using backend = services.createInstance(AgentHostTerminalService);
		const options = { rows: 24, cols: 80, profile: { type: 'default' as const } };
		using first = await backend.createProcess(options, 1);
		const closing = first.close();
		if (disposeEarly) first.dispose();
		using replacement = await backend.createProcess(options, 1);
		release.resolve();
		await closing;
		backend.dispose();
		await replacement.close();
		assert.deepEqual(processes.closeCalls, ['terminal-1', 'terminal-2']);
	});

	test('custom PTY output normalizes strings and preserves structured event identity and commit promises', async () => {
		const processes = new TestTerminalProcessService([]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		const service = services.get(ITerminalService);
		const commit = Promise.resolve();
		const structured: import('../../../../../platform/terminal/common/terminal.js').IProcessDataEvent = { data: 'structured', trackCommit: true, writePromise: commit };
		class TestPty extends BasePty<string | typeof structured> {
			async start(): Promise<void> {
				this.handleData('string output');
				this.handleData(structured);
			}
			shutdown(): void { this.handleExit(0); }
		}
		const instance = await service.createTerminal({
			dimensions: { rows: 24, cols: 80 }, deferStart: true,
			config: { name: 'Custom PTY', customPtyImplementation: id => new TestPty(id, false) },
		});
		const output: typeof structured[] = [];
		using listener = instance.onDidWriteData(event => output.push(event));
		instance.start();
		await waitFor(() => output.length === 2);
		assert.equal(output[0]!.data, 'string output');
		assert.equal(output[0]!.trackCommit, false);
		assert.equal(output[1], structured);
		assert.equal(output[1]!.writePromise, commit);
		await service.closeTerminal(instance);
	});

	test('sendText normalizes Enter, executes once, and permits insertion without execution', async () => {
		const processes = new TestTerminalProcessService([]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		const instance = await services.get(ITerminalService).createTerminal({ dimensions: { cols: 80, rows: 24 }, profile: { type: 'default' } });
		await instance.sendText('first\r\nsecond\n', false);
		await instance.sendText('command', true);
		await instance.sendText('already complete\r', true);
		await instance.sendText('insert', false, true);
		await instance.sendText('', true);
		assert.deepEqual(processes.writeCalls.map(call => call.data), ['first\rsecond\r', 'command\r', 'already complete\r', 'insert', '\r']);
		await instance.close();
		await assert.rejects(instance.sendText('late', true), isCancellationError);
	});

	test('merged text waits for the backend acknowledgement and preserves the original failure', async () => {
		const acknowledgement = deferred<void>();
		const processes = new TestTerminalProcessService([]);
		processes.writeGates.push(acknowledgement.promise);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		const terminals = services.get(ITerminalService);
		const instance = await terminals.createTerminal({ dimensions: { cols: 80, rows: 24 }, profile: { type: 'default' } });
		const failure = new Error('PTY rejected input');
		let finished = 0;
		const first = assert.rejects(instance.sendText('a', false).then(() => { finished++; }), error => error === failure);
		const second = assert.rejects(instance.sendText('b', false).then(() => { finished++; }), error => error === failure);
		await waitFor(() => processes.writeCalls.length === 1);
		assert.deepEqual({ finished, input: processes.writeCalls[0].data }, { finished: 0, input: 'ab' });
		acknowledgement.reject(failure);
		await Promise.all([first, second]);
		assert.equal(instance.state, 'error');
		await assert.rejects(instance.sendText('after failure', false), isCancellationError);
	});

	test('a large text write waits for its final UTF-8 batch before completing', async () => {
		const acknowledgement = deferred<void>();
		const processes = new TestTerminalProcessService([]);
		processes.writeGates.push(Promise.resolve(), acknowledgement.promise);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		const instance = await services.get(ITerminalService).createTerminal({ dimensions: { cols: 80, rows: 24 }, profile: { type: 'default' } });
		const text = '🙂'.repeat(20_000);
		let finished = false;
		const sent = instance.sendText(text, false).then(() => { finished = true; });
		await waitFor(() => processes.writeCalls.length === 2);
		assert.deepEqual({ finished, joined: processes.writeCalls.map(call => call.data).join(''), bytes: processes.writeCalls.map(call => new TextEncoder().encode(call.data as string).length) }, {
			finished: false, joined: text, bytes: [61_440, 18_560],
		});
		acknowledgement.resolve();
		await sent;
		assert.equal(finished, true);
	});

	for (const boundary of ['close', 'disconnect', 'exit'] as const) {
		test(`${boundary} cancels queued and in-flight text and binary acknowledgements`, async () => {
			const acknowledgement = deferred<void>();
			const read = deferred<ITerminalProcessReadResult>();
			const processes = new TestTerminalProcessService([read.promise]);
			processes.writeGates.push(acknowledgement.promise);
			using workspace = folderWorkspaceContext();
			using services = terminalServices(processes, workspace);
			const instance = await services.get(ITerminalService).createTerminal({ dimensions: { cols: 80, rows: 24 }, profile: { type: 'default' } });
			const inFlight = assert.rejects(instance.sendText('sent', false), isCancellationError);
			await waitFor(() => processes.writeCalls.length === 1);
			const binary = assert.rejects(instance.processBinary('\xff'), isCancellationError);
			const queued = assert.rejects(instance.sendText('queued', false), isCancellationError);
			if (boundary === 'close') await instance.close();
			else if (boundary === 'disconnect') processes.emitConnectionState('crashed');
			else read.resolve(readResult({ exited: true, exitCode: 0 }));
			await Promise.all([inFlight, binary, queued]);
			acknowledgement.resolve();
			assert.deepEqual(processes.writeCalls.map(call => call.data), ['sent']);
		});
	}

	test('reconnection accepts fresh input without waiting for or replaying an old write', async () => {
		const oldAcknowledgement = deferred<void>();
		const processes = new TestTerminalProcessService([], 'reconnectable');
		processes.writeGates.push(oldAcknowledgement.promise);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		const instance = await services.get(ITerminalService).createTerminal({ dimensions: { cols: 80, rows: 24 }, profile: { type: 'default' } });
		const cancelled = assert.rejects(instance.sendText('old input', false), isCancellationError);
		await waitFor(() => processes.writeCalls.length === 1);
		processes.emitConnectionState('crashed');
		await cancelled;
		processes.emitConnectionState('ready');
		await waitFor(() => instance.state === 'running');
		await instance.sendText('fresh input', false);
		oldAcknowledgement.reject(new Error('late old transport error'));
		await Promise.resolve();
		assert.deepEqual({ state: instance.state, input: processes.writeCalls.map(call => call.data) }, { state: 'running', input: ['old input', 'fresh input'] });
	});

	test('coalesced dimensions wait for acknowledgement and stop cancels an in-flight resize', async () => {
		const acknowledgement = deferred<void>();
		const processes = new TestTerminalProcessService([]);
		processes.resizeGates.push(acknowledgement.promise);
		using services = new InstantiationService(new ServiceCollection([ITerminalProcessService, processes]));
		using manager = services.createInstance(TerminalProcessManager, { terminalId: 'terminal-1' });
		let finished = 0;
		const first = assert.rejects(manager.setDimensions(90, 30).then(() => { finished++; }), isCancellationError);
		const second = assert.rejects(manager.setDimensions(100, 40).then(() => { finished++; }), isCancellationError);
		await waitFor(() => processes.resizeCalls.length === 1);
		assert.deepEqual({ finished, dimensions: processes.resizeCalls }, { finished: 0, dimensions: [{ terminalId: 'terminal-1', rows: 40, cols: 100 }] });
		manager.stop();
		await Promise.all([first, second]);
		acknowledgement.resolve();
	});

	test('every caller of coalesced dimensions completes after the last size is accepted', async () => {
		const acknowledgement = deferred<void>();
		const processes = new TestTerminalProcessService([]);
		processes.resizeGates.push(acknowledgement.promise);
		using services = new InstantiationService(new ServiceCollection([ITerminalProcessService, processes]));
		using manager = services.createInstance(TerminalProcessManager, { terminalId: 'terminal-1' });
		let finished = 0;
		const first = manager.setDimensions(90, 30).then(() => { finished++; });
		const second = manager.setDimensions(100, 40).then(() => { finished++; });
		await waitFor(() => processes.resizeCalls.length === 1);
		assert.equal(finished, 0);
		acknowledgement.resolve();
		await Promise.all([first, second]);
		assert.equal(finished, 2);
	});

	test('a creation listener can send input and dimensions before reading starts', async () => {
		const processes = new TestTerminalProcessService([]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		const terminals = services.get(ITerminalService);
		using listener = terminals.onDidCreateInstance(instance => {
			instance.sendText('early input', false);
			instance.resize({ cols: 91, rows: 31 });
		});
		const instance = await terminals.createTerminal({ dimensions: { cols: 80, rows: 24 }, profile: { type: 'default' } });
		await waitFor(() => processes.writeCalls.length === 1 && processes.resizeCalls.length === 1);
		assert.deepEqual({ writes: processes.writeCalls, dimensions: processes.resizeCalls }, {
			writes: [{ terminalId: 'terminal-1', data: 'early input' }],
			dimensions: [{ terminalId: 'terminal-1', cols: 91, rows: 31 }],
		});
		await instance.close();
	});

	test('list changes describe the final membership, order, titles and active instance', async () => {
		const processService = new TestTerminalProcessService([]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processService, workspace);
		const service = services.get(ITerminalService);
		const snapshots: Array<{ ids: string[]; titles: string[]; active: string | undefined; }> = [];
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
			listeners.add(service.onDidCreateInstance(instance => listeners.add(instance.onDidWriteData(data => outputs.push(data.data)))));
			const pending = service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
			processService.emitConnectionState('crashed');
			creation.resolve();
			const instance = await pending;
			await assert.rejects(instance.sendText('unsent', false), isCancellationError);
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
		const output: string[] = [];
		using listener = instance.onDidWriteData(event => output.push(event.data));
		const cancelledInput = assert.rejects(instance.sendText('queued', false), isCancellationError);
		instance.resize({ rows: 30, cols: 100 });
		instance.dispose();
		await cancelledInput;
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

	test('task reuse waits for old-process release and replaces environment and execution without replaying old output', async () => {
		const oldRead = deferred<ITerminalProcessReadResult>();
		const release = deferred<void>();
		const processes = new TestTerminalProcessService([oldRead.promise]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		const service = services.get(ITerminalService);
		const instance = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' }, env: { OLD: 'old' }, cwd: '/workspace/old', execution: { type: 'process', program: 'first', args: [] } });
		await waitFor(() => processes.readCursors.length === 1);
		const output: string[] = [];
		using listener = instance.onDidWriteData(event => output.push(event.data));
		processes.closeGates.push(release.promise);
		const executable = ['/custom/shell'];
		const args = ['-l'];
		const execution = { type: 'process' as const, program: 'second', args: ['$HOME', ''] };
		const env = { NEW: 'new', OLD: null };
		const replacing = instance.reuseTerminal({ name: 'Replacement', executable, args, env, cwd: '/workspace/new', execution, deferStart: true });
		executable[0] = '/changed/shell';
		args.push('-changed');
		execution.args[0] = 'changed';
		env.NEW = 'changed';
		await waitFor(() => processes.closeCalls.length === 1);
		assert.equal(processes.createCalls.length, 1, 'the replacement cannot overlap an unacknowledged old process');
		release.resolve();
		await replacing;
		oldRead.resolve(readResult({ chunks: [{ sequence: 1, data: new TextEncoder().encode('OLD_OUTPUT') }], nextSequence: 1, exited: true, exitCode: 99 }));
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual({ output, state: instance.state, exitCode: instance.exitCode, id: instance.id, title: instance.title, pid: instance.processId, reads: processes.readCursors, instances: service.instances.length }, { output: [], state: 'running', exitCode: undefined, id: 'terminal-instance-1', title: 'Replacement', pid: 1002, reads: [0], instances: 1 });
		assert.deepEqual(processes.createCalls[1], { rows: 24, cols: 80, profile: { type: 'custom', name: 'Replacement', path: ['/custom/shell'], args: ['-l'] }, env: { NEW: 'new', OLD: null }, cwd: '/workspace/new', execution: { type: 'process', program: 'second', args: ['$HOME', ''] } });
		instance.start();
		await waitFor(() => processes.readCursors.length === 2);
		await service.closeTerminal(instance);
		assert.deepEqual(processes.closeCalls, ['terminal-1', 'terminal-2']);
	});

	test('strict environment survives first launch and replacement and resets when omitted', async () => {
		const processes = new TestTerminalProcessService([]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		const service = services.get(ITerminalService);
		const instance = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' }, strictEnv: true, env: { ONLY: 'literal' }, deferStart: true });
		assert.equal(processes.createCalls[0]!.strictEnv, true);
		assert.equal(instance.shellLaunchConfig?.strictEnv, true);
		await instance.reuseTerminal({ strictEnv: true, env: { ONLY: 'replacement' }, deferStart: true });
		assert.equal(processes.createCalls[1]!.strictEnv, true);
		assert.deepEqual(processes.createCalls[1]!.env, { ONLY: 'replacement' });
		await instance.reuseTerminal({ deferStart: true });
		assert.equal(processes.createCalls[2]!.strictEnv, undefined);
		await service.closeTerminal(instance);
	});

	test('shell cwd and command completion wait for parsed output and preserve invocation cwd', async () => {
		const firstCommit = deferred<void>();
		const secondCommit = deferred<void>();
		const secondRead = deferred<ITerminalProcessReadResult>();
		const completed = { sequence: 2, commandId: 'command', status: 'failed' as const, exitCode: 17, afterOutputSequence: 2, cwd: '/invocation', command: 'cd /changed; false', isTrusted: true };
		const integration = { commandDetection: true, cwdDetection: true, hasRichCommandDetection: true, commandStorageDisabled: false, commands: [completed], promptType: 'starship', afterOutputSequence: 2 };
		const processes = new TestTerminalProcessService([readResult({
			chunks: [{ sequence: 1, data: new TextEncoder().encode('before cd') }], nextSequence: 1,
			commandEvents: [{ sequence: 1, commandId: 'command', status: 'running', exitCode: undefined, afterOutputSequence: 0, cwd: '/invocation' }, completed],
			nextCommandSequence: 2, cwd: { value: '/changed; directory', afterOutputSequence: 2 }, shellIntegration: integration,
		}), secondRead.promise]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		const service = services.get(ITerminalService);
		const instance = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' }, deferStart: true });
		const output: string[] = [];
		const commands: ITerminalCommandStatusEvent[] = [];
		using data = instance.onDidWriteData(event => { output.push(event.data); event.writePromise = output.length === 1 ? firstCommit.promise : secondCommit.promise; });
		using state = instance.onDidChangeCommandStatus(event => commands.push(event));
		instance.start();
		await waitFor(() => output.length === 1);
		assert.equal(instance.cwd, undefined);
		assert.equal(instance.capabilities!.has(TerminalCapability.PromptTypeDetection), false);
		assert.equal(Boolean(instance.shellIntegration), false);
		assert.equal(commands.length, 1);
		firstCommit.resolve();
		await waitFor(() => processes.readCursors.length === 2);
		secondRead.resolve(readResult({ chunks: [{ sequence: 2, data: new TextEncoder().encode('after cd') }], nextSequence: 2, nextCommandSequence: 2, cwd: { value: '/changed; directory', afterOutputSequence: 2 }, exited: true, exitCode: 0 }));
		await waitFor(() => output.length === 2);
		assert.equal(instance.cwd, undefined);
		assert.equal(instance.capabilities!.has(TerminalCapability.PromptTypeDetection), false);
		assert.equal(Boolean(instance.shellIntegration), false);
		assert.equal(commands.length, 1);
		secondCommit.resolve();
		await waitFor(() => instance.state === 'exited');
		assert.equal(instance.cwd, '/changed; directory');
		const cwdCapability = instance.capabilities!.get(TerminalCapability.CwdDetection)!;
		assert.equal(cwdCapability.getCwd(), instance.cwd);
		assert.equal(cwdCapability.isTrusted, false);
		assert.deepEqual(cwdCapability.cwds, ['/changed; directory']);
		assert.equal(instance.initialCwd, '/backend/workspace');
		assert.deepEqual(instance.shellIntegration?.commands, [{ commandId: 'command', status: 'failed', exitCode: 17, cwd: '/invocation', command: 'cd /changed; false', isTrusted: true }]);
		assert.equal(instance.shellIntegration?.hasRichCommandDetection, true);
		assert.equal(instance.capabilities!.get(TerminalCapability.PromptTypeDetection)!.promptType, 'starship');
		assert.deepEqual(commands, [{ commandId: 'command', status: 'running', exitCode: undefined, cwd: '/invocation' }, { commandId: 'command', status: 'failed', exitCode: 17, cwd: '/invocation', command: 'cd /changed; false', isTrusted: true }]);
	});

	for (const program of ['bash', 'zsh', 'pwsh']) test(`${program} reuse resets shell cwd and command cursors and ignores late metadata from the old PTY`, async () => {
		const oldRead = deferred<ITerminalProcessReadResult>();
		const newRead = deferred<ITerminalProcessReadResult>();
		const release = deferred<void>();
		const old = { sequence: 1, commandId: 'old', status: 'failed' as const, exitCode: 99, cwd: '/old', command: 'old command', isTrusted: true, afterOutputSequence: 0 };
		const oldIntegration = { commandDetection: true, cwdDetection: true, hasRichCommandDetection: true, commandStorageDisabled: false, commands: [old], afterOutputSequence: 0 };
		const processes = new TestTerminalProcessService([readResult({ shellIntegration: oldIntegration }), oldRead.promise, newRead.promise]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		const service = services.get(ITerminalService);
		const instance = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'custom', name: program, path: [program], args: [] } });
		await waitFor(() => processes.readCursors.length === 2);
		assert.equal(instance.shellIntegration?.commands[0].command, 'old command');
		processes.closeGates.push(release.promise);
		const commands: ITerminalCommandStatusEvent[] = [];
		using observer = instance.onDidChangeCommandStatus(event => commands.push(event));
		const replacing = instance.reuseTerminal({ executable: program, args: [], cwd: '/replacement', deferStart: true });
		await waitFor(() => processes.closeCalls.length === 1);
		assert.equal(processes.createCalls.length, 1);
		release.resolve(); await replacing;
		oldRead.resolve(readResult({ shellIntegration: oldIntegration, cwd: { value: '/old', afterOutputSequence: 0 }, commandEvents: [{ sequence: 1, commandId: 'old', status: 'failed', exitCode: 99, cwd: '/old', afterOutputSequence: 0 }], nextCommandSequence: 1, exited: true, exitCode: 99 }));
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(instance.cwd, undefined);
		assert.deepEqual(commands, []);
		assert.equal(Boolean(instance.shellIntegration), false);
		instance.start();
		await waitFor(() => processes.readCursors.length === 3);
		newRead.resolve(readResult({ shellIntegration: { ...oldIntegration, hasRichCommandDetection: false, commands: [] }, cwd: { value: '/replacement/current', afterOutputSequence: 0 }, commandEvents: [{ sequence: 1, commandId: 'new', status: 'completed', exitCode: undefined, cwd: '/replacement/current', afterOutputSequence: 0 }], nextCommandSequence: 1, exited: true }));
		await waitFor(() => instance.state === 'exited');
		assert.deepEqual(processes.readCursors, [0, 0, 0]);
		assert.deepEqual(instance.shellIntegration?.commands, []);
		assert.equal(instance.shellIntegration?.hasRichCommandDetection, false);
		assert.equal(instance.cwd, '/replacement/current');
		assert.deepEqual(commands, [{ commandId: 'new', status: 'completed', exitCode: undefined, cwd: '/replacement/current' }]);
		assert.equal(service.activeInstance, instance);
		assert.equal(service.instances.length, 1);
	});

	test('raw command line reuse waits for release and retains one instance through raw, argv and relaunch', async () => {
		const release = deferred<void>();
		const processes = new TestTerminalProcessService([]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		const service = services.get(ITerminalService);
		const raw = '/d /s /c "echo two words & literal;$HOME"';
		const instance = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'custom', name: 'Raw', path: ['cmd.exe'], args: raw }, execution: { type: 'process', program: 'cmd.exe', args: raw }, deferStart: true });
		processes.closeGates.push(release.promise);
		const args = ['', 'two words', 'literal;$HOME'];
		const replacing = instance.reuseTerminal({ name: 'Argv', executable: 'program.exe', args, execution: { type: 'process', program: 'program.exe', args }, deferStart: true });
		args.push('late mutation');
		await waitFor(() => processes.closeCalls.length === 1);
		assert.equal(processes.createCalls.length, 1);
		release.resolve(); await replacing;
		assert.deepEqual(processes.createCalls[1], { rows: 24, cols: 80, profile: { type: 'custom', name: 'Argv', path: ['program.exe'], args: ['', 'two words', 'literal;$HOME'] }, execution: { type: 'process', program: 'program.exe', args: ['', 'two words', 'literal;$HOME'] } });
		await instance.reuseTerminal({ name: 'Raw again', executable: 'cmd.exe', args: raw, execution: { type: 'process', program: 'cmd.exe', args: raw }, deferStart: true });
		processes.queueRead(readResult({ exited: true }));
		instance.start();
		await waitFor(() => instance.state === 'exited');
		await service.relaunchTerminal(instance, { rows: 30, cols: 100 });
		assert.equal(service.activeInstance, instance);
		assert.equal(service.instances.length, 1);
		assert.deepEqual(processes.closeCalls, ['terminal-1', 'terminal-2', 'terminal-3']);
		for (const index of [0, 2, 3]) {
			const create = processes.createCalls[index]!;
			assert.equal(create.profile.type, 'custom');
			if (create.profile.type === 'custom') assert.equal(create.profile.args, raw);
			assert.deepEqual(create.execution, { type: 'process', program: 'cmd.exe', args: raw });
		}
		await service.closeTerminal(instance);
	});

	test('closing a reused terminal during replacement releases its late process before close completes', async () => {
		const creation = deferred<void>();
		const processes = new TestTerminalProcessService([readResult({ exited: true })]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		const service = services.get(ITerminalService);
		const instance = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		await waitFor(() => instance.state === 'exited');
		processes.creationGates.push(creation.promise);
		const replacing = assert.rejects(instance.reuseTerminal({ execution: { type: 'process', program: 'second', args: [] }, deferStart: true }), isCancellationError);
		await waitFor(() => processes.createCalls.length === 2);
		let closed = false;
		const closing = service.closeTerminal(instance).then(() => { closed = true; });
		await Promise.resolve();
		assert.equal(closed, false);
		creation.resolve();
		await Promise.all([replacing, closing]);
		assert.deepEqual({ closed, instances: service.instances.length, closes: processes.closeCalls, reads: processes.readCursors }, { closed: true, instances: 0, closes: ['terminal-1', 'terminal-2'], reads: [0] });
	});

	test('task reuse rejects a failed old-process release without creating a replacement', async () => {
		const release = deferred<void>();
		const processes = new TestTerminalProcessService([readResult({ exited: true })]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		const service = services.get(ITerminalService);
		const instance = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		await waitFor(() => instance.state === 'exited');
		processes.closeGates.push(release.promise);
		const replacing = assert.rejects(instance.reuseTerminal({ execution: { type: 'process', program: 'second', args: [] } }), /release failed/);
		await waitFor(() => processes.closeCalls.length === 1);
		release.reject(new Error('release failed'));
		await replacing;
		assert.deepEqual({ creates: processes.createCalls.length, state: instance.state }, { creates: 1, state: 'error' });
		await assert.rejects(service.closeTerminal(instance), /release failed/);
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
		const output: string[] = [];
		using listener = instance.onDidWriteData(event => output.push(event.data));
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


suite('TerminalService output parsing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('process text decoding retains an incomplete UTF-8 prefix across a transport interruption', async () => {
		const stale = deferred<ITerminalProcessReadResult>();
		const processes = new TestTerminalProcessService([
			readResult({ chunks: [{ sequence: 1, data: new Uint8Array([0xe4]) }], nextSequence: 1 }), stale.promise,
		]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		using manager = services.createInstance(TerminalProcessManager, { terminalId: 'terminal-1' });
		const output: string[] = [];
		using listener = manager.onProcessData(event => output.push(event.data));
		const reading = manager.start();
		await waitFor(() => processes.readCursors.length === 2);
		manager.stop();
		await assert.rejects(reading, isCancellationError);
		processes.queueRead(readResult({ chunks: [{ sequence: 2, data: new Uint8Array([0xb8, 0xad]) }], nextSequence: 2, exited: true }));
		await manager.start(true);
		stale.resolve(readResult({ chunks: [{ sequence: 2, data: new TextEncoder().encode('stale') }], nextSequence: 2 }));
		await Promise.resolve();
		assert.deepEqual(output, ['', '中']);
		assert.deepEqual(processes.readCursors, [0, 1, 1]);
	});

	test('an output gap flushes an incomplete UTF-8 prefix before the gap notification', async () => {
		const processes = new TestTerminalProcessService([
			readResult({ chunks: [{ sequence: 1, data: new Uint8Array([0xe4]) }], nextSequence: 1 }),
			readResult({ chunks: [{ sequence: 3, data: new TextEncoder().encode('tail') }], nextSequence: 3, outputGap: true, exited: true }),
		]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		using manager = services.createInstance(TerminalProcessManager, { terminalId: 'terminal-1' });
		const observed: string[] = [];
		const boundaries: unknown[] = [];
		using data = manager.onProcessData(event => { if (event.shellIntegration) boundaries.push(event.shellIntegration); else observed.push(event.data); });
		using gap = manager.onOutputGap(() => observed.push('gap'));
		await manager.start();
		assert.deepEqual(observed, ['', '�', 'gap', 'tail']);
		assert.deepEqual(boundaries, [{ type: 'outputGap' }]);
	});

	test('final decoder output waits for parsing before publishing process exit', async () => {
		const parsed = deferred<void>();
		const processes = new TestTerminalProcessService([
			readResult({ chunks: [{ sequence: 1, data: new Uint8Array([0xe4]) }], nextSequence: 1, exited: true, exitCode: 0 }),
		]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		using manager = services.createInstance(TerminalProcessManager, { terminalId: 'terminal-1' });
		const observed: unknown[] = [];
		using data = manager.onProcessData(event => {
			observed.push(event.data);
			if (event.data) event.writePromise = parsed.promise;
		});
		using exit = manager.onProcessExit(code => observed.push(code));
		const reading = manager.start();
		await waitFor(() => observed.length === 2);
		assert.deepEqual(observed, ['', '�']);
		parsed.resolve();
		await reading;
		assert.deepEqual(observed, ['', '�', 0]);
	});

	test('waits for screen parsing before command completion, another read and exit', async () => {
		const parsed = deferred<void>();
		const processes = new TestTerminalProcessService([
			readResult({
				chunks: [{ sequence: 1, data: new TextEncoder().encode('first') }],
				nextSequence: 1,
				commandEvents: [
					{ sequence: 1, commandId: 'command', status: 'running', exitCode: undefined, afterOutputSequence: 0 },
					{ sequence: 2, commandId: 'command', status: 'succeeded', exitCode: 0, afterOutputSequence: 1 },
				],
				nextCommandSequence: 2,
			}),
			readResult({ nextSequence: 1, nextCommandSequence: 2, exited: true, exitCode: 0 }),
		]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		using listeners = new DisposableStore();
		const terminals = services.get(ITerminalService);
		const events: string[] = [];
		listeners.add(terminals.onDidCreateInstance(instance => {
			listeners.add(instance.onDidWriteData(event => {
				events.push(event.data);
				event.writePromise = parsed.promise;
			}));
			listeners.add(instance.onDidChangeCommandStatus(event => events.push(event.status)));
			listeners.add(instance.onDidExit(() => events.push('exit')));
		}));
		const instance = await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		await waitFor(() => events.includes('first'));
		assert.deepEqual({ events, reads: processes.readCursors, state: instance.state }, { events: ['running', 'first'], reads: [0], state: 'running' });
		parsed.resolve();
		await waitFor(() => instance.state === 'exited');
		assert.deepEqual({ events, reads: processes.readCursors }, { events: ['running', 'first', 'succeeded', 'exit'], reads: [0, 1] });
	});

	test('drains an exited process beyond one page and holds commands positioned after future output', async () => {
		const processes = new TestTerminalProcessService([
			readResult({
				chunks: Array.from({ length: 128 }, (_, index) => ({ sequence: index + 1, data: new TextEncoder().encode(`line-${index + 1}`) })),
				nextSequence: 128,
				commandEvents: [{ sequence: 1, commandId: 'command', status: 'succeeded', exitCode: 0, afterOutputSequence: 129 }],
				nextCommandSequence: 1,
				exited: true,
				exitCode: 0,
			}),
			readResult({ chunks: [{ sequence: 129, data: new TextEncoder().encode('tail') }], nextSequence: 129, nextCommandSequence: 1, exited: true, exitCode: 0 }),
		]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		using listeners = new DisposableStore();
		const terminals = services.get(ITerminalService);
		const events: string[] = [];
		listeners.add(terminals.onDidCreateInstance(instance => {
			listeners.add(instance.onDidWriteData(event => {
				events.push(event.data);
				event.writePromise = Promise.resolve();
			}));
			listeners.add(instance.onDidChangeCommandStatus(event => events.push(event.status)));
			listeners.add(instance.onDidExit(() => events.push('exit')));
		}));
		const instance = await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		await waitFor(() => instance.state === 'exited');
		assert.deepEqual({ count: events.length, tail: events.slice(-3), reads: processes.readCursors, commands: processes.commandReadCursors }, {
			count: 131, tail: ['tail', 'succeeded', 'exit'], reads: [0, 128], commands: [0, 1],
		});
	});

	test('drains the last command page before reporting process exit', async () => {
		const command = { commandId: 'command', status: 'completed', exitCode: undefined, afterOutputSequence: 0 } as const;
		const processes = new TestTerminalProcessService([
			readResult({ commandEvents: Array.from({ length: 128 }, (_, index) => ({ ...command, sequence: index + 1 })), nextCommandSequence: 128, exited: true }),
			readResult({ commandEvents: [{ ...command, sequence: 129 }], nextCommandSequence: 129, exited: true }),
		]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		using listeners = new DisposableStore();
		const terminals = services.get(ITerminalService);
		const events: string[] = [];
		listeners.add(terminals.onDidCreateInstance(instance => {
			listeners.add(instance.onDidChangeCommandStatus(event => events.push(event.status)));
			listeners.add(instance.onDidExit(() => events.push('exit')));
		}));
		const instance = await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		await waitFor(() => instance.state === 'exited');
		assert.deepEqual({ count: events.length, last: events.at(-1), cursors: processes.commandReadCursors }, { count: 130, last: 'exit', cursors: [0, 128] });
	});

	test('closing cancels an unfinished screen write without waiting for its callback', async () => {
		const parsed = deferred<void>();
		const processes = new TestTerminalProcessService([readResult({ chunks: [{ sequence: 1, data: new Uint8Array([65]) }], nextSequence: 1 })]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		using listeners = new DisposableStore();
		const terminals = services.get(ITerminalService);
		let delivered = false;
		listeners.add(terminals.onDidCreateInstance(instance => listeners.add(instance.onDidWriteData(event => {
			delivered = true;
			event.writePromise = parsed.promise;
		}))));
		const instance = await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		await waitFor(() => delivered);
		await instance.close();
		parsed.resolve();
		await Promise.resolve();
		assert.deepEqual({ reads: processes.readCursors, closes: processes.closeCalls, remaining: terminals.instances.length }, { reads: [0], closes: ['terminal-1'], remaining: 0 });
	});

	test('transport recovery waits for the existing screen write and never replays it', async () => {
		const parsed = deferred<void>();
		const processes = new TestTerminalProcessService([
			readResult({ chunks: [{ sequence: 1, data: new TextEncoder().encode('once') }], nextSequence: 1 }),
			readResult({ nextSequence: 1, exited: true, exitCode: 0 }),
		], 'reconnectable');
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		using listeners = new DisposableStore();
		const terminals = services.get(ITerminalService);
		const output: string[] = [];
		listeners.add(terminals.onDidCreateInstance(instance => listeners.add(instance.onDidWriteData(event => {
			output.push(event.data);
			if (event.trackCommit) {
				event.writePromise = parsed.promise;
			}
		}))));
		const instance = await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		await waitFor(() => output.includes('once'));
		processes.emitConnectionState('crashed');
		processes.emitConnectionState('ready');
		await Promise.resolve();
		assert.deepEqual({ reads: processes.readCursors, state: instance.state }, { reads: [0], state: 'reconnecting' });
		parsed.resolve();
		await waitFor(() => instance.state === 'exited');
		assert.deepEqual({ reads: processes.readCursors, output: output.filter(value => value === 'once') }, { reads: [0, 1], output: ['once'] });
	});
});

suite('TerminalService parser failure and replacement', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a failed screen write stops the stream and exposes a closable error', async () => {
		const parsed = deferred<void>();
		const processes = new TestTerminalProcessService([readResult({ chunks: [{ sequence: 1, data: new Uint8Array([65]) }], nextSequence: 1 })]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		using listeners = new DisposableStore();
		const terminals = services.get(ITerminalService);
		let delivered = false;
		listeners.add(terminals.onDidCreateInstance(instance => listeners.add(instance.onDidWriteData(event => {
			delivered = true;
			event.writePromise = parsed.promise;
		}))));
		const instance = await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		await waitFor(() => delivered);
		parsed.reject(new Error('Screen could not parse output'));
		await waitFor(() => instance.state === 'error');
		await instance.close();
		assert.deepEqual({ reads: processes.readCursors, closes: processes.closeCalls }, { reads: [0], closes: ['terminal-1'] });
	});

	test('an old parse callback cannot hold or advance a replacement Shell', async () => {
		const parsed = deferred<void>();
		const processes = new TestTerminalProcessService([
			readResult({ chunks: [{ sequence: 1, data: new TextEncoder().encode('old') }], nextSequence: 1 }),
			readResult({ terminalId: 'terminal-2', chunks: [{ sequence: 1, data: new TextEncoder().encode('new') }], nextSequence: 1, exited: true, exitCode: 0 }),
		]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		using listeners = new DisposableStore();
		const terminals = services.get(ITerminalService);
		const output: string[] = [];
		listeners.add(terminals.onDidCreateInstance(instance => listeners.add(instance.onDidWriteData(event => {
			const text = event.data;
			output.push(text);
			if (event.trackCommit) {
				event.writePromise = text === 'old' ? parsed.promise : Promise.resolve();
			}
		}))));
		const instance = await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		await waitFor(() => output.includes('old'));
		processes.emitConnectionState('crashed');
		processes.emitConnectionState('ready');
		await terminals.relaunchTerminal(instance, { rows: 24, cols: 80 });
		await waitFor(() => instance.state === 'exited');
		parsed.resolve();
		await Promise.resolve();
		await instance.close();
		assert.deepEqual({ reads: processes.readCursors, output: output.filter(text => text === 'old' || text === 'new'), closes: processes.closeCalls }, {
			reads: [0, 0], output: ['old', 'new'], closes: ['terminal-1', 'terminal-2'],
		});
	});
});


test('TerminalService evaluates the exit display callback before exit delivery and replaces it on task reuse', async () => {
	const processes = new TestTerminalProcessService([readResult({ exited: true, exitCode: 7 })]);
	using workspace = folderWorkspaceContext();
	using services = terminalServices(processes, workspace);
	const terminals = services.get(ITerminalService);
	const events: string[] = [];
	const instance = await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' }, deferStart: true, waitOnExit: code => { events.push(`display:${code}`); return 'DISPLAY_ONLY_EXIT_NOTICE'; } });
	using output = instance.onDidWriteData(() => events.push('process-output'));
	using exit = instance.onDidExit(code => events.push(`exit:${code}`));
	instance.start();
	await waitFor(() => instance.state === 'exited');
	assert.deepEqual(events, ['display:7', 'exit:7']);
	processes.queueRead(readResult({ exited: true, exitCode: 0 }));
	await instance.reuseTerminal({ name: 'Replacement', deferStart: true });
	instance.start();
	await waitFor(() => instance.state === 'exited');
	assert.deepEqual({ events, writes: processes.writeCalls, closes: processes.closeCalls }, { events: ['display:7', 'exit:7', 'exit:0'], writes: [], closes: ['terminal-1'] });
});

test('TerminalService retains the spawn environment snapshot when relaunching a terminal', async () => {
	const processes = new TestTerminalProcessService([]);
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	using services = terminalServices(processes, workspace);
	const service = services.get(ITerminalService);
	const env = { MODE: 'original', REMOVE: null };
	const instance = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' }, env });
	env.MODE = 'changed';
	processes.emitConnectionState('crashed');
	processes.emitConnectionState('ready');
	await service.relaunchTerminal(instance, { rows: 25, cols: 90 });
	assert.deepEqual(processes.createCalls.map(call => call.env), [{ MODE: 'original', REMOVE: null }, { MODE: 'original', REMOVE: null }]);
});


suite('Terminal Send Sequence', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function setup(owner: DisposableStore) {
		const processes = new TestTerminalProcessService([]);
		const workspace = owner.add(new WorkspaceContextService({ id: 'sequence', uri: URI.file('/workspace') }));
		const services = owner.add(terminalServices(processes, workspace));
		const terminals = services.get(ITerminalService);
		const commands = owner.add(new CommandService(services));
		services.registerInstance(ICommandService, commands);
		const resolver = { resolveAsync: async (_folder: unknown, value: unknown): Promise<unknown> => value };
		services.registerInstance(IConfigurationResolverService, resolver as IConfigurationResolverService);
		return { processes, workspace, services, terminals, commands, resolver };
	}

	test('Send Sequence uses only committed trusted shell values and falls back after a forged update', async () => {
		using owner = new DisposableStore();
		const { processes, resolver, terminals, commands } = setup(owner);
		const instance = await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		const store = owner.add(new TerminalCapabilityStore());
		const env = owner.add(new ShellEnvDetectionCapability());
		store.add(TerminalCapability.ShellEnvDetection, env);
		owner.add((instance.capabilities as TerminalCapabilityStoreMultiplexer).add(store));
		Object.assign(resolver, {
			resolveWithEnvironment: async (values: Readonly<Record<string, string | undefined>>) => values.SHELL_VALUE ?? '',
			resolveAsync: async () => 'frozen host value',
		});
		env.setEnvironment({ SHELL_VALUE: 'startup' }, true);
		env.startEnvironmentSingleVar(true, true);
		env.setEnvironmentSingleVar('SHELL_VALUE', 'pending', true);
		await commands.executeCommand(TerminalCommandId.SendSequence, { text: '${env:SHELL_VALUE}' });
		env.endEnvironmentSingleVar(true);
		await commands.executeCommand(TerminalCommandId.SendSequence, { text: '${env:SHELL_VALUE}' });
		env.setEnvironment({ SHELL_VALUE: 'forged' }, false);
		await commands.executeCommand(TerminalCommandId.SendSequence, { text: '${env:SHELL_VALUE}' });
		assert.deepEqual(processes.writeCalls.map(call => call.data), ['startup', 'pending', 'frozen host value']);
	});

	test('resolves for the initiating folder and waits for the actual input acknowledgement', async () => {
		using owner = new DisposableStore();
		const { processes, workspace, resolver, terminals, commands } = setup(owner);
		await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		const acknowledgement = deferred<void>();
		processes.writeGates.push(acknowledgement.promise);
		const resolutions: unknown[] = [];
		resolver.resolveAsync = async (folder, value) => { resolutions.push({ folder, value }); return '\x1b[1;5D中文'; };
		let completed = false;
		const sending = commands.executeCommand(TerminalCommandId.SendSequence, { text: '${workspaceFolder}' }).then(() => { completed = true; });
		await waitFor(() => processes.writeCalls.length === 1);
		assert.deepEqual(resolutions, [{ folder: workspace.getWorkspace().folders[0], value: '${workspaceFolder}' }]);
		assert.deepEqual(processes.writeCalls, [{ terminalId: 'terminal-1', data: '\x1b[1;5D中文' }]);
		assert.equal(completed, false);
		acknowledgement.resolve();
		await sending;
		assert.equal(completed, true);
	});

	test('uses the terminal folder in a multi-root workspace', async () => {
		using owner = new DisposableStore();
		const { processes, workspace, resolver, terminals, commands } = setup(owner);
		workspace.updateWorkspace({
			id: 'multi', folders: [
				{ id: 'first', uri: URI.file('/first'), name: 'First', index: 0 },
				{ id: 'second', uri: URI.file('/second'), name: 'Second', index: 1 },
			]
		});
		await terminals.createTerminal({ dirId: 'second', dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		resolver.resolveAsync = async (folder) => {
			assert.equal(folder, workspace.getWorkspace().folders[1]);
			return '/second';
		};
		await commands.executeCommand(TerminalCommandId.SendSequence, { text: '${workspaceFolder}' });
		assert.deepEqual(processes.writeCalls, [{ dirId: 'second', terminalId: 'terminal-1', data: '/second' }]);
	});

	test('cancellation settles the command while an unresolved variable remains pending', async () => {
		using owner = new DisposableStore();
		const { processes, resolver, terminals, commands } = setup(owner);
		await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		const resolution = deferred<string>();
		let resolving = false;
		resolver.resolveAsync = async () => { resolving = true; return resolution.promise; };
		const sending = commands.executeCommand(TerminalCommandId.SendSequence, { text: '${pending}' });
		await waitFor(() => resolving);
		terminals.setActiveInstance(undefined);
		await sending;
		resolution.reject(new Error('late failure after cancellation'));
		assert.deepEqual(processes.writeCalls, []);
	});

	test('prompt decodes control characters once, while supplied text keeps literal escapes', async () => {
		using owner = new DisposableStore();
		const { processes, services, terminals, commands } = setup(owner);
		await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		const prompts: IInputOptions[] = [];
		services.registerInstance(IQuickInputService, {
			input: async options => { prompts.push(options); return String.raw`\x1b[A\n\r\x00\x5cn\xGG中文`; },
		} as IQuickInputService);
		await commands.executeCommand(TerminalCommandId.SendSequence);
		await commands.executeCommand(TerminalCommandId.SendSequence, { text: String.raw`\n\r\x1b` });
		assert.equal(prompts.length, 1);
		assert.deepEqual(processes.writeCalls, [
			{ terminalId: 'terminal-1', data: '\x1b[A\r\r\0\\n\\xGG中文' },
			{ terminalId: 'terminal-1', data: String.raw`\n\r\x1b` },
		]);
	});

	test('rejects malformed command arguments and never prompts without a running instance', async () => {
		using owner = new DisposableStore();
		const { processes, services, terminals, commands } = setup(owner);
		let prompts = 0;
		services.registerInstance(IQuickInputService, { input: async () => { prompts++; return 'unexpected'; } } as unknown as IQuickInputService);
		for (const value of [null, 'text', [], {}, { text: 42 }]) {
			await assert.rejects(commands.executeCommand(TerminalCommandId.SendSequence, value), /string text property/);
		}
		await commands.executeCommand(TerminalCommandId.SendSequence);
		const instance = await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		await instance.close();
		await commands.executeCommand(TerminalCommandId.SendSequence);
		assert.equal(prompts, 0);
		assert.deepEqual(processes.writeCalls, []);
	});

	for (const change of ['switch away and back', 'reuse', 'close', 'workspace', 'disconnect and recover'] as const) {
		test(`discards a delayed resolution after ${change}`, async () => {
			using owner = new DisposableStore();
			const { processes, resolver, workspace, terminals, commands } = setup(owner);
			const instance = await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
			const resolution = deferred<string>();
			let resolving = false;
			resolver.resolveAsync = async () => { resolving = true; return resolution.promise; };
			const sending = commands.executeCommand(TerminalCommandId.SendSequence, { text: 'stale input' });
			await waitFor(() => resolving);
			switch (change) {
				case 'switch away and back': terminals.setActiveInstance(undefined); terminals.setActiveInstance(instance); break;
				case 'reuse': await instance.reuseTerminal({}); break;
				case 'close': await instance.close(); break;
				case 'workspace': workspace.updateWorkspace({ id: 'other', uri: URI.file('/other') }); break;
				case 'disconnect and recover': processes.emitConnectionState('crashed'); processes.emitConnectionState('ready'); break;
			}
			resolution.resolve('stale input');
			await sending;
			assert.deepEqual(processes.writeCalls, []);
		});
	}

	test('cancels an open prompt when the active instance changes', async () => {
		using owner = new DisposableStore();
		const { processes, services, terminals, commands } = setup(owner);
		await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		let prompted = false;
		let canceled = false;
		services.registerInstance(IQuickInputService, {
			input: (_options, token) => new Promise(resolve => {
				prompted = true;
				owner.add(token!.onCancellationRequested(() => { canceled = true; resolve(undefined); }));
			}),
		} as IQuickInputService);
		const sending = commands.executeCommand(TerminalCommandId.SendSequence);
		await waitFor(() => prompted);
		terminals.setActiveInstance(undefined);
		await sending;
		assert.equal(canceled, true);
		assert.deepEqual(processes.writeCalls, []);
	});

	test('propagates configuration resolution and transport failures without executing extra input', async () => {
		using owner = new DisposableStore();
		const { processes, resolver, terminals, commands } = setup(owner);
		await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		const failure = new Error('sequence failed');
		resolver.resolveAsync = async () => { throw failure; };
		await assert.rejects(commands.executeCommand(TerminalCommandId.SendSequence, { text: 'unsent' }), error => error === failure);
		assert.deepEqual(processes.writeCalls, []);
		resolver.resolveAsync = async (_folder, value) => value;
		const acknowledgement = deferred<void>();
		processes.writeGates.push(acknowledgement.promise);
		const sending = assert.rejects(commands.executeCommand(TerminalCommandId.SendSequence, { text: 'sent' }), error => error === failure);
		await waitFor(() => processes.writeCalls.length === 1);
		acknowledgement.reject(failure);
		await sending;
		assert.deepEqual(processes.writeCalls, [{ terminalId: 'terminal-1', data: 'sent' }]);
	});
});


suite('TerminalService panel groups', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('join and unsplit retain each original process and select panes through the instance owner', async () => {
		const processes = new TestTerminalProcessService([]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		services.registerInstance(IViewsService, { openView: async () => null } as unknown as IViewsService);
		const terminals = services.get(ITerminalService);
		const first = await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		const second = await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		using groups = services.createInstance(TerminalGroupService);
		assert.deepEqual(groups.groups.map(group => group.terminalInstances), [[first], [second]]);
		groups.joinInstances([first, second]);
		assert.deepEqual(groups.groups.map(group => group.terminalInstances), [[first, second]]);
		assert.equal(groups.instanceIsSplit(first), true);
		assert.equal(groups.activeGroup, groups.getGroupForInstance(second));
		groups.activeGroup!.focusPreviousPane();
		assert.equal(terminals.activeInstance, first);
		groups.unsplitInstance(second);
		assert.deepEqual(groups.groups.map(group => group.terminalInstances), [[first], [second]]);
		groups.setActiveInstanceByIndex(1);
		assert.equal(terminals.activeInstance, second);
		assert.equal(processes.createCalls.length, 2);
		assert.deepEqual(processes.closeCalls, []);
		await terminals.closeTerminal(first);
		assert.deepEqual(groups.groups.map(group => group.terminalInstances), [[second]]);
	});

	test('groups observe future creation and remove empty groups after the original close event', async () => {
		const processes = new TestTerminalProcessService([]);
		using workspace = folderWorkspaceContext();
		using services = terminalServices(processes, workspace);
		services.registerInstance(IViewsService, { openView: async () => null } as unknown as IViewsService);
		const terminals = services.get(ITerminalService);
		using groups = services.createInstance(TerminalGroupService);
		const first = await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		const second = await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
		groups.joinInstances([first, second, second]);
		await terminals.closeTerminal(second);
		assert.deepEqual(groups.groups.map(group => group.terminalInstances), [[first]]);
		await terminals.closeTerminal(first);
		assert.deepEqual(groups.groups, []);
		assert.equal(groups.activeGroup, undefined);
	});
});


test('Terminal process failure retains its display reason and relaunch clears the old message', async () => {
	using workspace = folderWorkspaceContext();
	const processes = new TestTerminalProcessService([]);
	using services = terminalServices(processes, workspace);
	const terminals = services.get(ITerminalService);
	const instance = await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
	const acknowledgement = deferred<void>();
	processes.writeGates.push(acknowledgement.promise);
	const failure = new Error('execution host refused input');
	const sending = assert.rejects(instance.sendText('input', false), error => error === failure);
	await waitFor(() => processes.writeCalls.length === 1);
	acknowledgement.reject(failure);
	await sending;
	assert.equal(instance.state, 'error');
	assert.equal(instance.statusList?.primary?.tooltip, 'Terminal process failed: execution host refused input');
	await terminals.relaunchTerminal(instance, { rows: 24, cols: 80 });
	assert.equal(instance.state, 'running');
	assert.deepEqual(instance.statusList?.statuses, []);
});


test('terminal title and icon editing survive process replacement and reset through the original owner', async () => {
	const processes = new TestTerminalProcessService([]);
	using services = terminalServices(processes, folderWorkspaceContext());
	const terminals = services.get(ITerminalService);
	const first = await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
	const second = await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
	const resource = first.resource;
	await first.rename!('User name');
	await first.changeIcon!({ id: 'terminal-git-bash' });
	assert.equal(first.title, 'User name');
	assert.equal(second.title, 'cmd 2');
	assert.equal(processes.createCalls.length, 2);
	await terminals.relaunchTerminal(first, { rows: 30, cols: 100 });
	assert.equal(first.title, 'User name');
	assert.equal(first.profile.icon?.id, 'terminal-git-bash');
	assert.equal(first.resource, resource);
	await first.rename!('');
	assert.equal(first.title, 'cmd 1');
	await terminals.closeTerminal(second);
	assert.equal(first.title, 'cmd');
});
