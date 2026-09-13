import assert from "node:assert/strict";
import { test } from "mocha";
import { toDisposable } from "../../../../../base/common/lifecycle.js";
import { URI } from "../../../../../base/common/uri.js";
import type { ITerminalProcessCreateOptions, ITerminalProcessReadResult, ITerminalProcessService, TerminalProcessConnectionState } from "../../../../../platform/terminal/common/terminalProcessService.js";
import { TerminalService } from "../../../../../workbench/services/terminal/browser/terminalService.js";
import type { ITerminalInstance } from "../../../../../workbench/services/terminal/common/terminal.js";
import { WorkspaceContextService } from "../../../../../workbench/services/workspaces/browser/workspaceContextService.js";

const DEFAULT_PROFILE = {
	profileId: "command-prompt",
	title: "Command Prompt",
	isDefault: true,
} as const;

test("TerminalService keeps empty windows off the process API and enables a folder after transition", async () => {
	const processService = new TestTerminalProcessService([]);
	using workspace = new WorkspaceContextService({ id: "empty-window" });
	using service = new TerminalService(processService, workspace);

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
				dataBase64: Buffer.from("hello").toString("base64"),
			}],
			nextSequence: 1,
			commandEvents: [{
				sequence: 1,
				commandId: "command-1",
				status: "running",
				exitCode: null,
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
	using service = new TerminalService(processService, folderWorkspaceContext());
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
	using service = new TerminalService(processService, folderWorkspaceContext());
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
	using service = new TerminalService(processService, folderWorkspaceContext());
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
	using service = new TerminalService(processService, folderWorkspaceContext());
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
	using service = new TerminalService(processService, folderWorkspaceContext());
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
	using service = new TerminalService(processService, folderWorkspaceContext());
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

class TestTerminalProcessService implements ITerminalProcessService {
	profileListCalls = 0;
	readonly createCalls: ITerminalProcessCreateOptions[] = [];
	readonly writeCalls: Array<{ terminalId: string; data: string }> = [];
	readonly resizeCalls: Array<{ terminalId: string; rows: number; cols: number }> = [];
	readonly readCursors: number[] = [];
	readonly commandReadCursors: number[] = [];
	readonly closeCalls: string[] = [];
	private readonly connectionListeners = new Set<(state: TerminalProcessConnectionState) => void>();
	private connectionState: TerminalProcessConnectionState = "ready";

	constructor(private readonly reads: Array<ITerminalProcessReadResult | Promise<ITerminalProcessReadResult>>, private readonly connectionPersistence: "connectionOwned" | "reconnectable" = "connectionOwned") {}

	async listProfiles() {
		this.profileListCalls += 1;
		return [DEFAULT_PROFILE];
	}

	async create(params: ITerminalProcessCreateOptions) {
		this.createCalls.push(params);
		return {
			terminalId: `terminal-${this.createCalls.length}`,
			profile: DEFAULT_PROFILE,
			connectionPersistence: this.connectionPersistence,
		};
	}

	queueRead(result: ITerminalProcessReadResult | Promise<ITerminalProcessReadResult>): void {
		this.reads.push(result);
	}

	async write(params: { terminalId: string; data: string }) {
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

	async close(params: { terminalId: string }) {
		this.closeCalls.push(params.terminalId);
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

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(accept => {
		resolve = accept;
	});
	return { promise, resolve };
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
		exitCode: null,
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
