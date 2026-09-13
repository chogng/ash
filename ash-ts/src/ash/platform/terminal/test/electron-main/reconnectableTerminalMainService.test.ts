import assert from "node:assert/strict";
import { test } from "mocha";
import { APP_SERVER_METHODS } from "../../../../../../generated/app-server/index.js";
import { toDisposable } from "../../../../base/common/lifecycle.js";
import type { AppServerConnectionState } from "../../../../platform/app-server/common/appServerApi.js";
import type { AppServerProtocolClient } from "../../../../platform/app-server/browser/appServerProtocolClient.js";
import { ReconnectableTerminalProcessService } from "../../../../platform/terminal/browser/reconnectableTerminalProcessService.js";

const FIRST_TOKEN = "a".repeat(64);
const SECOND_TOKEN = "b".repeat(64);
const THIRD_TOKEN = "c".repeat(64);

test("Remote terminal leases stay in the renderer and rotate across connection generations", async () => {
	const supervisor = new TestSupervisor();
	const failures: unknown[] = [];
	using service = new ReconnectableTerminalProcessService({
		supervisor: supervisor as unknown as AppServerProtocolClient,
		wait: async () => {},
		reportError: (_message, error) => failures.push(error),
	});

	const created = await service.create({
		rows: 24,
		cols: 80,
		profile: { type: "default" },
		lifecycle: { type: "connectionOwned" },
	});

	assert.deepEqual(created, {
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
	using service = new ReconnectableTerminalProcessService({
		supervisor: supervisor as unknown as AppServerProtocolClient,
	});

	await assert.rejects(() => service.create({
		rows: 24,
		cols: 80,
		profile: { type: "default" },
		lifecycle: { type: "connectionOwned" },
	}), /invalid terminal reconnect lease/);
	assert.equal(supervisor.requests.at(-1)?.method, "terminal/close");
});

test("intentional server replacement abandons old broker leases without recovery retries", async () => {
	const supervisor = new TestSupervisor();
	using service = new ReconnectableTerminalProcessService({
		supervisor: supervisor as unknown as AppServerProtocolClient,
	});
	await service.create({
		rows: 24,
		cols: 80,
		profile: { type: "default" },
		lifecycle: { type: "connectionOwned" },
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

interface RecordedRequest {
	readonly method: string;
	readonly params: unknown;
}

class TestSupervisor {
	state: AppServerConnectionState = "ready";
	generation = 1;
	attachFailures = 0;
	successfulAttachments = 0;
	invalidCreateLease = false;
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

	async request(definition: { method: string }, params: unknown): Promise<any> {
		this.requests.push({ method: definition.method, params });
		switch (definition.method) {
			case APP_SERVER_METHODS["terminal/create"].method:
				return {
					terminalId: "terminal-1",
					profile: { profileId: "shell", title: "Shell", isDefault: true },
					reconnect: this.invalidCreateLease
						? { reconnectToken: "secret", reconnectGracePeriodMillis: 30_000 }
						: { reconnectToken: FIRST_TOKEN, reconnectGracePeriodMillis: 30_000 },
				};
			case APP_SERVER_METHODS["terminal/attach"].method:
				if (this.attachFailures > 0) {
					this.attachFailures -= 1;
					throw new Error("terminal is still detaching");
				}
				this.successfulAttachments += 1;
				return {
					terminalId: "terminal-1",
					reconnect: {
						reconnectToken: this.successfulAttachments === 1 ? SECOND_TOKEN : THIRD_TOKEN,
						reconnectGracePeriodMillis: 30_000,
					},
				};
			case APP_SERVER_METHODS["terminal/read"].method:
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
