import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter } from "../../../../../base/common/event.js";
import { URI } from "../../../../../base/common/uri.js";
import { type IDebugAdapterProcessReadResult, type IDebugAdapterProcessService } from "../../../../../platform/debug/common/debugAdapterProcessService.js";
import { type AppServerConnectionState } from "../../../../../platform/app-server/common/appServerApi.js";
import { createSshRemoteWorkspaceUri } from "../../../../../platform/remote/common/remote.js";
import { DebugAdapterSession } from "../../browser/debugAdapterSession.js";
import { type IDebugBreakpoint, type IDebugConfiguration } from "../../common/debugService.js";

test("DebugAdapterSession performs DAP configuration, clears breakpoints, and resolves an omitted stopped thread", async () => {
	using processes = new FakeDebugAdapterProcessService();
	let breakpoints: readonly IDebugBreakpoint[] = [breakpoint(4)];
	const updates: Array<{ readonly id: string; readonly verified: boolean; readonly message?: string }> = [];
	const terminalRequests: unknown[] = [];
	const session = await DebugAdapterSession.start({ configuration: configuration(), processService: processes, breakpoints: () => breakpoints, workspace: URI.file("C:\\workspace"), runInTerminal: async value => { terminalRequests.push(value); return {}; }, updateBreakpoints: values => updates.push(...values) });

	assert.equal(session.state, "running");
	assert.deepEqual(processes.started, { program: "C:\\workspace\\adapter", arguments: ["--stdio", "C:\\workspace"] });
	assert.deepEqual(processes.request("launch").arguments, { program: "C:\\workspace\\bin\\app", cwd: "C:\\workspace" });
	assert.deepEqual(processes.request("setBreakpoints").arguments, { source: { path: "C:\\workspace\\main.ts" }, breakpoints: [{ line: 4 }] });
	assert.deepEqual(processes.request("setExceptionBreakpoints").arguments, { filters: ["uncaught"] });
	assert.deepEqual(updates, [{ id: "main:4", verified: true }]);
	assert.deepEqual(session.capabilities, { supportsRestart: true, supportsTerminate: true, exceptionBreakpointFilters: [{ filter: "uncaught", label: "Uncaught Exceptions", default: true }, { filter: "caught", label: "Caught Exceptions", default: false }] });
	processes.event("output", { output: "adapter ready\n" });
	await waitFor(() => session.output === "adapter ready\n");

	processes.reverseRequest("runInTerminal", { kind: "integrated", args: ["app"] });
	await waitFor(() => processes.responses("runInTerminal").length === 1);
	assert.deepEqual(terminalRequests, [{ kind: "integrated", args: ["app"] }]);
	assert.equal(processes.responses("runInTerminal")[0]?.success, true);

	breakpoints = [];
	await session.syncBreakpoints();
	assert.deepEqual(processes.requests("setBreakpoints").at(-1)?.arguments, { source: { path: "C:\\workspace\\main.ts" }, breakpoints: [] });

	processes.event("stopped", { reason: "breakpoint", allThreadsStopped: true });
	await waitFor(() => session.state === "stopped");
	const frames = await session.stackTrace();
	assert.equal(processes.requests("threads").length, 1);
	assert.deepEqual(frames.map(frame => ({ ...frame, source: frame.source ? { ...frame.source, resource: frame.source.resource?.toString() } : undefined })), [{ id: 11, name: "main", source: { name: "main.ts", path: "C:\\workspace\\main.ts", resource: "file:///C:/workspace/main.ts" }, lineNumber: 4, columnNumber: 1 }]);

	assert.deepEqual(await session.threads(), [{ id: 7, name: "main" }, { id: 8, name: "worker" }]);
	session.selectThread(8);
	await session.stackTrace();
	assert.equal((processes.requests("stackTrace").at(-1)?.arguments as Record<string, unknown>).threadId, 8);
	assert.deepEqual(await session.scopes(11), [{ name: "Locals", variablesReference: 20, expensive: false }]);
	assert.deepEqual(await session.variables(20), [{ name: "answer", value: "42", variablesReference: 0, type: "number" }]);
	assert.deepEqual(await session.evaluate("answer", 11, "watch"), { result: "42", variablesReference: 0, type: "number" });
	assert.deepEqual(await session.source({ name: "generated.ts", sourceReference: 33 }), { content: "const generated = true;", mimeType: "text/typescript" });
	await session.setExceptionBreakpoints(["caught"]);
	assert.deepEqual(processes.requests("setExceptionBreakpoints").at(-1)?.arguments, { filters: ["caught"] });
	await session.restart();
	assert.equal(processes.requests("restart").length, 1);

	await session.disconnect();
	assert.equal(processes.closed, true);
});

test("DebugAdapterSession keeps Remote adapter paths on the Remote Workspace authority", async () => {
	using processes = new FakeDebugAdapterProcessService("/srv/project/src/main file.ts");
	const workspace = createSshRemoteWorkspaceUri("work-server", "/srv/project");
	const configurationValue: IDebugConfiguration = { ...configuration(), adapter: { program: "${workspaceFolder}/adapter", arguments: ["--stdio"] }, arguments: { program: "${workspaceFolder}/bin/app", cwd: "${workspaceFolder}" } };
	const remoteBreakpoint: IDebugBreakpoint = { id: "remote:4", resource: createSshRemoteWorkspaceUri("work-server", "/srv/project/src/main file.ts"), lineNumber: 4, enabled: true, verified: false };
	const session = await DebugAdapterSession.start({ configuration: configurationValue, processService: processes, breakpoints: () => [remoteBreakpoint], workspace });

	assert.deepEqual(processes.started, { program: "/srv/project/adapter", arguments: ["--stdio"] });
	assert.deepEqual(processes.request("launch").arguments, { program: "/srv/project/bin/app", cwd: "/srv/project" });
	assert.deepEqual(processes.request("setBreakpoints").arguments, { source: { path: "/srv/project/src/main file.ts" }, breakpoints: [{ line: 4 }] });
	processes.event("stopped", { reason: "breakpoint", allThreadsStopped: true });
	await waitFor(() => session.state === "stopped");
	const frame = (await session.stackTrace())[0];
	assert.equal(frame?.source?.path, "/srv/project/src/main file.ts");
	assert.equal(frame?.source?.resource?.toString(), "ash-remote://ssh+work-server/srv/project/src/main%20file.ts");

	await session.disconnect();
});

class FakeDebugAdapterProcessService implements IDebugAdapterProcessService {
	private readonly connectionEmitter = new Emitter<AppServerConnectionState>();
	private readonly messages: Array<{ readonly sequence: number; readonly message: unknown }> = [];
	private nextMessageSequence = 0;
	private nextProtocolSequence = 100;
	readonly sent: Array<Record<string, unknown>> = [];
	started: unknown;
	closed = false;
	readonly onConnectionState = this.connectionEmitter.event;

	constructor(private readonly stackFramePath = "C:\\workspace\\main.ts") {}

	async start(options: unknown): Promise<string> { this.started = options; return "debug-1"; }

	async send(_sessionId: string, message: unknown): Promise<void> {
		const request = message as Record<string, unknown>;
		this.sent.push(request);
		if (request.type !== "request") return;
		const command = String(request.command);
		if (command === "launch") this.event("initialized");
		const body = command === "initialize" ? { supportsConfigurationDoneRequest: true, supportsRestartRequest: true, supportsTerminateRequest: true, exceptionBreakpointFilters: [{ filter: "uncaught", label: "Uncaught Exceptions", default: true }, { filter: "caught", label: "Caught Exceptions" }] }
			: command === "threads" ? { threads: [{ id: 7, name: "main" }, { id: 8, name: "worker" }] }
			: command === "stackTrace" ? { stackFrames: [{ id: 11, name: "main", source: { name: "main.ts", path: this.stackFramePath }, line: 4, column: 1 }] }
			: command === "scopes" ? { scopes: [{ name: "Locals", variablesReference: 20 }] }
			: command === "variables" ? { variables: [{ name: "answer", value: "42", type: "number", variablesReference: 0 }] }
			: command === "evaluate" ? { result: "42", type: "number", variablesReference: 0 }
			: command === "source" ? { content: "const generated = true;", mimeType: "text/typescript" }
			: command === "setBreakpoints" && Array.isArray((request.arguments as Record<string, unknown>)?.breakpoints) && ((request.arguments as Record<string, unknown>).breakpoints as unknown[]).length > 0 ? { breakpoints: [{ verified: true }] }
			: {};
		this.enqueue({ seq: this.nextProtocolSequence++, type: "response", request_seq: request.seq, success: true, command, body });
	}

	async read(_sessionId: string, afterSequence: number, maxMessages: number): Promise<IDebugAdapterProcessReadResult> {
		const messages = this.messages.filter(message => message.sequence >= afterSequence).slice(0, maxMessages);
		return { messages, nextSequence: this.nextMessageSequence, outputGap: false, stderr: "", exited: false, exitCode: null, protocolError: null };
	}

	async close(): Promise<void> { this.closed = true; }
	async getConnectionState(): Promise<AppServerConnectionState> { return "ready"; }
	dispose(): void { this.connectionEmitter.dispose(); }
	[Symbol.dispose](): void { this.dispose(); }

	event(event: string, body?: unknown): void { this.enqueue({ seq: this.nextProtocolSequence++, type: "event", event, ...(body === undefined ? {} : { body }) }); }
	reverseRequest(command: string, argumentsValue: unknown): void { this.enqueue({ seq: this.nextProtocolSequence++, type: "request", command, arguments: argumentsValue }); }
	request(command: string): Record<string, unknown> { const request = this.requests(command)[0]; assert.ok(request); return request; }
	requests(command: string): Record<string, unknown>[] { return this.sent.filter(message => message.type === "request" && message.command === command); }
	responses(command: string): Record<string, unknown>[] { return this.sent.filter(message => message.type === "response" && message.command === command); }
	private enqueue(message: unknown): void { this.messages.push({ sequence: this.nextMessageSequence++, message }); }
}

function configuration(): IDebugConfiguration {
	return { id: "launch:0:test", name: "Test", type: "example", request: "launch", adapter: { program: "${workspaceFolder}\\adapter", arguments: ["--stdio", "${workspaceFolder}"] }, arguments: { program: "${workspaceFolder}\\bin\\app", cwd: "${workspaceFolder}" } };
}

function breakpoint(lineNumber: number): IDebugBreakpoint {
	return { id: `main:${lineNumber}`, resource: URI.file("C:\\workspace\\main.ts"), lineNumber, enabled: true, verified: false };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for debug session state");
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}
