import { AppServerTerminalProcessService } from '../../browser/appServerTerminalProcessService.js';
import type { IAppServerApi } from '../../../agentHost/common/appServerApi.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { APP_SERVER_METHODS } from "../../../../../../.build/protocol/typescript/index.js";
import { toDisposable } from "../../../../base/common/lifecycle.js";
import type { AppServerConnectionState } from "../../../agentHost/common/appServerApi.js";
import type { AppServerProtocolClient } from "../../../agentHost/browser/appServerProtocolClient.js";
import { ReconnectableTerminalProcessService } from "../../../../platform/terminal/browser/reconnectableTerminalProcessService.js";
import type { ITerminalProcessService } from "../../common/terminal.js";

const FIRST_TOKEN = "a".repeat(64);
const SECOND_TOKEN = "b".repeat(64);
const THIRD_TOKEN = "c".repeat(64);

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

test("intentional server replacement abandons old broker leases without recovery retries", async () => {
	const supervisor = new TestSupervisor();
	using service = new ReconnectableTerminalProcessService(supervisor as unknown as AppServerProtocolClient);
	await service.create({
		rows: 24,
		cols: 80,
		profile: { type: "default" },
	});

	service.prepareForServerReplacement();
	assert.equal(supervisor.requests.at(-1)?.method, "terminal/close");
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
	operatingSystem: OperatingSystem | undefined = OperatingSystem.Linux;
	state: AppServerConnectionState = "ready";
	generation = 1;
	attachFailures = 0;
	successfulAttachments = 0;
	invalidCreateLease = false;
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
			case APP_SERVER_METHODS["terminal/profile/resolve"].method: {
				const { profile } = params as { profile: { args: string | string[]; }; };
				return { profile: { profileId: 'custom:Raw', title: 'Raw', isDefault: false }, executable: 'cmd.exe', args: profile.args };
			}
			case APP_SERVER_METHODS["terminal/create"].method:
				return {
					terminalId: "terminal-1",
					ready: { pid: 1234, cwd: '/backend/workspace' },
					profile: { profileId: "shell", title: "Shell", isDefault: true },
					reconnect: this.invalidCreateLease
						? { reconnectToken: "secret", reconnectGracePeriodMillis: 30_000 }
						: { reconnectToken: FIRST_TOKEN, reconnectGracePeriodMillis: 30_000 },
				};
			case APP_SERVER_METHODS["terminal/writeBinary"].method:
				return null;
			case APP_SERVER_METHODS["terminal/attach"].method:
				if (this.attachFailures > 0) {
					this.attachFailures -= 1;
					throw new Error("terminal is still detaching");
				}
				this.successfulAttachments += 1;
				return {
					terminalId: "terminal-1",
					ready: { pid: 1234, cwd: '/backend/workspace' },
					reconnect: {
						reconnectToken: this.successfulAttachments === 1 ? SECOND_TOKEN : THIRD_TOKEN,
						reconnectGracePeriodMillis: 30_000,
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
							commandDetection: true, cwdDetection: true, hasRichCommandDetection: true, commandStorageDisabled: false,
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
	await service.create({ rows: 24, cols: 80, profile: { type: 'default' } });
	const result = await service.read({ terminalId: 'terminal-1', afterSequence: 0, afterCommandSequence: 0, maxChunks: 128 });
	assert.deepEqual(result.cwd, { value: 'C:\\work; with spaces', isTrusted: true, afterOutputSequence: 2 });
	assert.equal(result.commandEvents[0].cwd, '/invocation');
	assert.equal(result.commandEvents[0].exitCode, undefined);
	assert.equal(result.commandEvents[0].afterOutputSequence, 1);
	assert.equal(result.commandEvents[0].command, 'echo 中文; \"quoted\"');
	assert.equal(result.commandEvents[0].isTrusted, false);
	assert.equal(result.shellIntegration?.hasRichCommandDetection, true);
	assert.deepEqual(result.shellIntegration?.commands[0], { sequence: 2, commandId: 'command-1', status: 'failed', exitCode: 7, afterOutputSequence: 2, cwd: '/invocation', command: 'echo 中文; \"quoted\"', isTrusted: false });
	await service.close({ terminalId: 'terminal-1' });
});
