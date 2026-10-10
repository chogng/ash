import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { initializeTestLocalization } from '../../../localization/test/common/localizationTestUtils.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { WorkbenchConfigurationService } from '../../../configuration/browser/configurationService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IRendererHostService } from '../../../../../platform/renderer/common/rendererHost.js';
import { createDisconnectedRendererApi } from '../../../../../platform/agentHost/browser/rendererApi.js';
import { BrowserPathService } from '../../../path/browser/pathService.js';
import { IPathService } from '../../../../../platform/path/common/pathService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { CommandService } from '../../../commands/common/commandService.js';
import { ITerminalProcessService } from '../../../../../platform/terminal/common/terminal.js';
import { ConfigurationResolverService } from '../../../configurationResolver/browser/configurationResolverService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { WorkspaceContextService } from '../../../workspaces/browser/workspaceContextService.js';
import type { DebugAdapterSessionStartOptions } from '../../browser/debugAdapterSession.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter } from "../../../../../base/common/event.js";
import { URI } from "../../../../../base/common/uri.js";
import { type IDebugAdapterProcessReadResult, type IDebugAdapterProcessService } from "../../../../../platform/debug/common/debugAdapterProcessService.js";
import { type AppServerConnectionState } from "../../../../../platform/agentHost/common/appServerApi.js";
import { createSshRemoteWorkspaceUri } from "../../../../../platform/remote/common/remote.js";
import { DebugAdapterSession } from "../../browser/debugAdapterSession.js";
import { DebugBreakpoint, type IDebugBreakpoint, type IDebugConfiguration } from "../../common/debugService.js";

test("DebugAdapterSession handles zero-sequence DAP messages, clears breakpoints, and resolves an omitted stopped thread", async () => {
	using processes = new FakeDebugAdapterProcessService();
	let breakpoints: readonly IDebugBreakpoint[] = [breakpoint(4)];
	const workspace = URI.file('C:\\workspace');
	const breakpointPath = breakpoints[0]!.resource.fsPath;
	const updates: Array<{ readonly id: string; readonly verified: boolean; readonly message?: string; }> = [];
	const terminalRequests: unknown[] = [];
	const session = await startSession({ configuration: configuration(), processService: processes, breakpoints: () => breakpoints, workspace, runInTerminal: async value => { terminalRequests.push(value); return {}; }, updateBreakpoints: values => updates.push(...values) });

	assert.equal(session.state, "running");
	assert.deepEqual(processes.started, { program: `${workspace.fsPath}\\adapter`, arguments: ['--stdio', workspace.fsPath] });
	assert.deepEqual(processes.request("launch").arguments, { program: `${workspace.fsPath}\\bin\\app`, cwd: workspace.fsPath });
	assert.deepEqual(processes.request("setBreakpoints").arguments, { source: { path: breakpointPath }, breakpoints: [{ line: 4 }] });
	assert.deepEqual(processes.request("setExceptionBreakpoints").arguments, { filters: ["uncaught"] });
	assert.deepEqual(updates, [{ id: "main:4", verified: true }]);
	assert.deepEqual(session.capabilities, { supportsRestart: true, supportsTerminate: true, supportsSetVariable: true, supportsConditionalBreakpoints: true, supportsHitConditionalBreakpoints: true, supportsLogPoints: true, supportsFunctionBreakpoints: false, supportsDataBreakpoints: false, supportsInstructionBreakpoints: false, supportsDisassembleRequest: false, supportsSteppingGranularity: false, exceptionBreakpointFilters: [{ filter: "uncaught", label: "Uncaught Exceptions", default: true }, { filter: "caught", label: "Caught Exceptions", default: false }] });
	processes.event("output", { output: "adapter ready\n" });
	await waitFor(() => session.output === "adapter ready\n");

	processes.reverseRequest("runInTerminal", { kind: "integrated", args: ["app"] });
	await waitFor(() => processes.responses("runInTerminal").length === 1);
	assert.deepEqual(terminalRequests, [{ kind: "integrated", args: ["app"] }]);
	assert.equal(processes.responses("runInTerminal")[0]?.success, true);

	breakpoints = [];
	await session.syncBreakpoints();
	assert.deepEqual(processes.requests("setBreakpoints").at(-1)?.arguments, { source: { path: breakpointPath }, breakpoints: [] });

	processes.event("stopped", { reason: "breakpoint", allThreadsStopped: true });
	await waitFor(() => session.state === "stopped");
	const frames = await session.stackTrace();
	assert.equal(processes.requests("threads").length, 1);
	assert.deepEqual(frames.map(frame => ({ ...frame, source: frame.source ? { ...frame.source, resource: frame.source.resource?.toString() } : undefined })), [{ id: 11, threadId: 7, name: "main", source: { name: "main.ts", path: "C:\\workspace\\main.ts", resource: URI.parse('file:///C:/workspace/main.ts').toString() }, lineNumber: 4, columnNumber: 1 }, { id: 12, threadId: 7, name: "system", source: undefined, lineNumber: 0, columnNumber: 0 }]);

	assert.deepEqual(await session.threads(), [{ id: 7, name: "main" }, { id: 8, name: "worker" }]);
	session.selectThread(8);
	await session.stackTrace();
	assert.equal((processes.requests("stackTrace").at(-1)?.arguments as Record<string, unknown>).threadId, 8);
	assert.deepEqual(await session.scopes(11), [{ name: "Locals", variablesReference: 20, expensive: false }]);
	assert.deepEqual(await session.variables(20), [{ name: "answer", value: "42", variablesReference: 0, type: "number" }]);
	assert.deepEqual(await session.setVariable(20, "answer", "43"), { name: "answer", value: "43", variablesReference: 0, type: "number" });
	assert.deepEqual(processes.request("setVariable").arguments, { variablesReference: 20, name: "answer", value: "43" });
	assert.deepEqual(await session.evaluate("answer", 11, "watch"), { result: "42", variablesReference: 0, type: "number" });
	assert.deepEqual(await session.source({ name: "generated.ts", sourceReference: 33 }), { content: "const generated = true;", mimeType: "text/typescript" });
	await session.setExceptionBreakpoints(["caught"]);
	assert.deepEqual(processes.requests("setExceptionBreakpoints").at(-1)?.arguments, { filters: ["caught"] });
	await session.restart();
	assert.equal(processes.requests("restart").length, 1);
	await assert.rejects(session.setVariable(20, "answer", "44"), /Pause execution/);

	await session.disconnect();
	assert.equal(processes.closed, true);
});

test("DebugAdapterSession keeps Remote adapter paths on the Remote Workspace authority", async () => {
	using processes = new FakeDebugAdapterProcessService("/srv/project/src/main file.ts");
	const workspace = createSshRemoteWorkspaceUri("work-server", "/srv/project");
	const configurationValue: IDebugConfiguration = { ...configuration(), adapter: { program: "${workspaceFolder}/adapter", arguments: ["--stdio"] }, arguments: { program: "${workspaceFolder}/bin/app", cwd: "${workspaceFolder}" } };
	const remoteBreakpoint: IDebugBreakpoint = { id: "remote:4", resource: createSshRemoteWorkspaceUri("work-server", "/srv/project/src/main file.ts"), lineNumber: 4, enabled: true, verified: false };
	const session = await startSession({ configuration: configurationValue, processService: processes, breakpoints: () => [remoteBreakpoint], workspace });

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

test("DebugAdapterSession gates mutations on adapter capability and validates adapter replies", async () => {
	using unsupported = new FakeDebugAdapterProcessService(undefined, false);
	const unsupportedSession = await startSession({ configuration: configuration(), processService: unsupported, breakpoints: () => [], workspace: URI.file('/workspace') });
	try {
		await assert.rejects(unsupportedSession.setVariable(20, "answer", "43"), /does not support changing variables/);
		assert.deepEqual(unsupported.requests("setVariable"), []);
	} finally {
		await unsupportedSession.disconnect();
	}
	using processes = new FakeDebugAdapterProcessService();
	const session = await startSession({ configuration: configuration(), processService: processes, breakpoints: () => [], workspace: URI.file('/workspace') });
	try {
		processes.event("stopped", { reason: "breakpoint", threadId: 7 });
		await waitFor(() => session.state === "stopped");
		await assert.rejects(session.setVariable(20, "answer", "\0"), /no null characters/);
		assert.deepEqual(processes.requests("setVariable"), []);
		processes.setVariableReply = { value: "Object", type: "object", variablesReference: 21 };
		assert.deepEqual(await session.setVariable(20, "answer", "{}"), { name: "answer", value: "Object", type: "object", variablesReference: 21 });
		processes.setVariableReply = { value: 43 };
		await assert.rejects(session.setVariable(20, "answer", "43"), /value must be a string/);
	} finally {
		await session.disconnect();
	}
});

test("DebugAdapterSession sends expressions unchanged and does not install unsupported breakpoint types", async () => {
	let points: readonly IDebugBreakpoint[] = [breakpoint(4), { ...breakpoint(5), condition: 'answer > 0' }, { ...breakpoint(6), hitCondition: '% 3' }, { ...breakpoint(7), logMessage: ' answer = {answer} ' }];
	using supported = new FakeDebugAdapterProcessService();
	const session = await startSession({ configuration: configuration(), processService: supported, breakpoints: () => points, workspace: URI.file('/workspace') });
	try {
		assert.deepEqual(supported.request('setBreakpoints').arguments, {
			source: { path: points[0]!.resource.fsPath }, breakpoints: [
				{ line: 4 }, { line: 5, condition: 'answer > 0' }, { line: 6, hitCondition: '% 3' }, { line: 7, logMessage: ' answer = {answer} ' },
			]
		});
	} finally { await session.disconnect(); }
	using unsupported = new FakeDebugAdapterProcessService(undefined, true, false);
	const updates: unknown[] = [];
	const other = await startSession({ configuration: configuration(), processService: unsupported, breakpoints: () => points, workspace: URI.file('/workspace'), updateBreakpoints: values => updates.push(...values) });
	try {
		assert.deepEqual(unsupported.request('setBreakpoints').arguments, { source: { path: points[0]!.resource.fsPath }, breakpoints: [{ line: 4 }] });
		assert.deepEqual(updates, [
			{ id: 'main:5', verified: false, message: 'Debug Adapter does not support conditional breakpoints' },
			{ id: 'main:6', verified: false, message: 'Debug Adapter does not support hit conditions' },
			{ id: 'main:7', verified: false, message: 'Debug Adapter does not support logpoints' },
			{ id: 'main:4', verified: true },
		]);
		points = [{ ...breakpoint(4), logMessage: 'answer={answer}' }];
		await other.syncBreakpoints();
		assert.deepEqual(unsupported.requests('setBreakpoints').at(-1)?.arguments, { source: { path: points[0]!.resource.fsPath }, breakpoints: [] });
	} finally { await other.disconnect(); }
});

test("DebugAdapterSession groups interleaved source breakpoints and clears a retired source", async () => {
	using processes = new FakeDebugAdapterProcessService();
	const otherResource = URI.file('C:\\workspace\\other.ts');
	let points: readonly IDebugBreakpoint[] = [breakpoint(4), { ...breakpoint(5), resource: otherResource }, breakpoint(6)];
	const session = await startSession({ configuration: configuration(), processService: processes, breakpoints: () => points, workspace: URI.file('/workspace') });
	try {
		assert.deepEqual(processes.requests('setBreakpoints').map(request => request.arguments), [
			{ source: { path: points[0]!.resource.fsPath }, breakpoints: [{ line: 4 }, { line: 6 }] },
			{ source: { path: otherResource.fsPath }, breakpoints: [{ line: 5 }] },
		]);
		points = [breakpoint(4)];
		await session.syncBreakpoints();
		assert.deepEqual(processes.requests('setBreakpoints').at(-1)?.arguments, { source: { path: otherResource.fsPath }, breakpoints: [] });
	} finally { await session.disconnect(); }
});

test("DebugAdapterSession cancels pending breakpoint replacements when disposed", async () => {
	using processes = new FakeDebugAdapterProcessService();
	const session = await startSession({ configuration: configuration(), processService: processes, breakpoints: () => [breakpoint(4)], workspace: URI.file('/workspace') });
	processes.holdBreakpoints = true;
	const running = assert.rejects(session.syncBreakpoints(), /Debug session was disposed/);
	await waitFor(() => processes.heldBreakpointResponse !== undefined);
	const queued = assert.rejects(session.syncBreakpoints(), { name: 'CancellationError', message: 'Operation cancelled' });
	await session.disconnect();
	await Promise.all([running, queued]);
	assert.equal(processes.requests('setBreakpoints').length, 2);
});

test("DebugAdapterSession orders breakpoint replacements and discards verification for an edited point", async () => {
	using processes = new FakeDebugAdapterProcessService();
	let points: readonly IDebugBreakpoint[] = [breakpoint(4)];
	const updates: unknown[] = [];
	const session = await startSession({ configuration: configuration(), processService: processes, breakpoints: () => points, workspace: URI.file('/workspace'), updateBreakpoints: values => updates.push(...values) });
	try {
		updates.length = 0;
		processes.holdBreakpoints = true;
		points = [{ ...breakpoint(4), condition: 'counter > 1' }];
		const edit = session.syncBreakpoints();
		await waitFor(() => processes.heldBreakpointResponse !== undefined);
		points = [];
		const remove = session.syncBreakpoints();
		assert.equal(processes.requests('setBreakpoints').length, 2);
		processes.releaseBreakpoints();
		await Promise.all([edit, remove]);
		assert.deepEqual(processes.requests('setBreakpoints').slice(1).map(request => request.arguments), [
			{ source: { path: breakpoint(4).resource.fsPath }, breakpoints: [{ line: 4, condition: 'counter > 1' }] },
			{ source: { path: breakpoint(4).resource.fsPath }, breakpoints: [] },
		]);
		assert.deepEqual(updates, []);
	} finally { await session.disconnect(); }
});

test("DebugAdapterSession configures all breakpoint families and queries variable access without crossing sessions", async () => {
	using processes = new FakeDebugAdapterProcessService(undefined, true, true, true);
	let points: readonly Exclude<DebugBreakpoint, IDebugBreakpoint>[] = [
		{ kind: 'function', id: 'function', name: 'app::worker', enabled: true, verified: false, condition: 'counter > 0', hitCondition: '>= 2' },
		{ kind: 'data', id: 'data', dataId: 'memory:counter', description: 'counter', enabled: true, verified: false, accessType: 'readWrite', accessTypes: ['readWrite'], canPersist: false, adapterType: 'example', sessionId: 'debug-1' },
		{ kind: 'instruction', id: 'instruction', instructionReference: '0x1000', offset: -4, enabled: true, verified: false, sessionId: 'debug-1' },
		{ kind: 'instruction', id: 'other-session', instructionReference: '0x2000', enabled: true, verified: false, sessionId: 'debug-2' },
	];
	const session = await startSession({ configuration: configuration(), processService: processes, breakpoints: () => [], additionalBreakpoints: () => points, workspace: URI.file('/workspace') });
	try {
		assert.deepEqual(['setFunctionBreakpoints', 'setDataBreakpoints', 'setInstructionBreakpoints'].map(command => processes.request(command).arguments), [
			{ breakpoints: [{ name: 'app::worker', condition: 'counter > 0', hitCondition: '>= 2' }] },
			{ breakpoints: [{ dataId: 'memory:counter', accessType: 'readWrite' }] },
			{ breakpoints: [{ instructionReference: '0x1000', offset: -4 }] },
		]);
		await assert.rejects(session.dataBreakpointInfo('counter', 20, 11), /paused session/);
		processes.event('stopped', { threadId: 7 });
		await waitFor(() => session.state === 'stopped');
		assert.deepEqual(await session.dataBreakpointInfo('counter', 20, 11), { dataId: 'memory:counter', description: 'counter', canPersist: false, accessTypes: ['read', 'write', 'readWrite'] });
		assert.deepEqual(processes.request('dataBreakpointInfo').arguments, { name: 'counter', variablesReference: 20, frameId: 11 });
		processes.dataInfoReply = { dataId: null, description: 'No stable memory location' };
		assert.deepEqual(await session.dataBreakpointInfo('temporary', 20), { dataId: null, description: 'No stable memory location', canPersist: false, accessTypes: ['write'] });
		processes.dataInfoReply = { dataId: 'counter', description: 'counter', accessTypes: ['execute'] };
		await assert.rejects(session.dataBreakpointInfo('counter', 20), /Invalid data breakpoint access types/);
		points = [];
		await session.syncBreakpoints();
		assert.deepEqual(['setFunctionBreakpoints', 'setDataBreakpoints', 'setInstructionBreakpoints'].map(command => processes.requests(command).at(-1)?.arguments), [{ breakpoints: [] }, { breakpoints: [] }, { breakpoints: [] }]);
	} finally { await session.disconnect(); }
});

test('DebugAdapterSession excludes unsupported conditions from every additional family', async () => {
	using processes = new FakeDebugAdapterProcessService(undefined, true, false, true);
	const updates: unknown[] = [];
	const session = await startSession({
		configuration: configuration(), processService: processes, breakpoints: () => [], additionalBreakpoints: () => [
			{ kind: 'function', id: 'function', name: 'main', enabled: true, verified: false, condition: 'counter > 0' },
			{ kind: 'data', id: 'data', dataId: 'memory', description: 'counter', enabled: true, verified: false, accessType: 'write', accessTypes: ['write'], canPersist: true, adapterType: 'example', hitCondition: '2' },
			{ kind: 'instruction', id: 'instruction', instructionReference: '0x1000', enabled: true, verified: false, sessionId: 'debug-1', condition: 'counter > 0' },
		], workspace: URI.file('/workspace'), updateBreakpoints: values => updates.push(...values)
	});
	try {
		assert.deepEqual(['setFunctionBreakpoints', 'setDataBreakpoints', 'setInstructionBreakpoints'].map(command => processes.request(command).arguments), [{ breakpoints: [] }, { breakpoints: [] }, { breakpoints: [] }]);
		assert.deepEqual(updates, [
			{ id: 'function', verified: false, message: 'Debug Adapter does not support conditional breakpoints' },
			{ id: 'data', verified: false, message: 'Debug Adapter does not support hit conditions' },
			{ id: 'instruction', verified: false, message: 'Debug Adapter does not support conditional breakpoints' },
		]);
	} finally { await session.disconnect(); }
});

test("DebugAdapterSession reports unsupported breakpoint families without sending their commands", async () => {
	using processes = new FakeDebugAdapterProcessService();
	const updates: unknown[] = [];
	const session = await startSession({
		configuration: configuration(), processService: processes, breakpoints: () => [], additionalBreakpoints: () => [
			{ kind: 'function', id: 'function', name: 'main', enabled: true, verified: false },
			{ kind: 'data', id: 'data', dataId: 'memory', description: 'value', enabled: true, verified: false, accessType: 'write', accessTypes: ['write'], canPersist: true, adapterType: 'example' },
			{ kind: 'instruction', id: 'instruction', instructionReference: '0x1000', enabled: true, verified: false, sessionId: 'debug-1' },
		], workspace: URI.file('/workspace'), updateBreakpoints: values => updates.push(...values)
	});
	try {
		assert.deepEqual(updates, [
			{ id: 'function', verified: false, message: 'Debug Adapter does not support function breakpoints' },
			{ id: 'data', verified: false, message: 'Debug Adapter does not support data breakpoints' },
			{ id: 'instruction', verified: false, message: 'Debug Adapter does not support instruction breakpoints' },
		]);
		assert.deepEqual(processes.sent.filter(message => ['setFunctionBreakpoints', 'setDataBreakpoints', 'setInstructionBreakpoints'].includes(String(message.command))), []);
		await assert.rejects(session.dataBreakpointInfo('value', 20), /does not support data breakpoints/);
	} finally { await session.disconnect(); }
});

test('disassembly preserves byte and instruction offsets, resolves remote sources, and sends instruction stepping granularity', async () => {
	using processes = new FakeDebugAdapterProcessService(undefined, true, true, true, true);
	const session = await startSession({ configuration: configuration(), processService: processes, breakpoints: () => [], workspace: createSshRemoteWorkspaceUri('work-server', '/srv/project') });
	try {
		assert.equal((processes.request('initialize').arguments as Record<string, unknown>).supportsMemoryReferences, true);
		await assert.rejects(session.disassemble('0x1000', 4, -2, 50), /Pause debugging/);
		processes.event('stopped', { threadId: 7 });
		await waitFor(() => session.state === 'stopped');
		const instructions = await session.disassemble('0x1000', 4, -2, 50);
		assert.deepEqual(processes.request('disassemble').arguments, { memoryReference: '0x1000', offset: 4, instructionOffset: -2, instructionCount: 50, resolveSymbols: true });
		assert.deepEqual(instructions.map(instruction => ({ ...instruction, location: { ...instruction.location, resource: instruction.location?.resource?.toString() } })), [{ address: '0x1000', instruction: 'mov r0, r1', instructionBytes: '90', symbol: 'main', location: { name: 'main.ts', path: '/srv/project/main.ts', resource: 'ash-remote://ssh+work-server/srv/project/main.ts' }, line: 4, column: 1 }]);
		await assert.rejects(session.disassemble('0x1000', 0.5, 0, 50), /offsets must be integers/);
		await assert.rejects(session.disassemble('0x1000', 0, 0, 0), /instruction count/);
		assert.equal(processes.requests('disassemble').length, 1);
		processes.disassemblyReply = {
			instructions: [
				{ address: '0x1000', instruction: 'mov r0, r1', location: { path: '/srv/project/main.ts' }, line: 4 },
				{ address: '0x1004', instruction: 'ret', line: 5, endLine: 6, endColumn: 3 },
			]
		};
		const sameSource = await session.disassemble('0x1000', 0, 0, 2);
		assert.equal(sameSource[1]?.location?.resource?.toString(), 'ash-remote://ssh+work-server/srv/project/main.ts');
		assert.deepEqual({ line: sameSource[1]?.line, endLine: sameSource[1]?.endLine, endColumn: sameSource[1]?.endColumn }, { line: 5, endLine: 6, endColumn: 3 });
		processes.disassemblyReply = { instructions: [{ address: '0x1000', instruction: 42 }] };
		await assert.rejects(session.disassemble('0x1000', 0, 0, 1), /instruction must be a string/);
		await session.stepOver('instruction');
		assert.deepEqual(processes.request('next').arguments, { threadId: 7, granularity: 'instruction' });
	} finally { await session.disconnect(); }
});

test('unsupported adapters receive neither disassembly nor instruction stepping requests', async () => {
	using processes = new FakeDebugAdapterProcessService();
	const session = await startSession({ configuration: configuration(), processService: processes, breakpoints: () => [], workspace: URI.file('/workspace') });
	try {
		await assert.rejects(session.disassemble('0x1000', 0, 0, 50), /does not support disassembly/);
		await assert.rejects(session.stepInto('instruction'), /does not support instruction stepping/);
		assert.deepEqual(processes.requests('disassemble'), []);
		assert.deepEqual(processes.requests('stepIn'), []);
	} finally { await session.disconnect(); }
});

class FakeDebugAdapterProcessService implements IDebugAdapterProcessService {
	private readonly connectionEmitter = new Emitter<AppServerConnectionState>();
	private readonly messages: Array<{ readonly sequence: number; readonly message: unknown; }> = [];
	private nextMessageSequence = 0;
	readonly sent: Array<Record<string, unknown>> = [];
	started: unknown;
	closed = false;
	setVariableReply: Record<string, unknown> | undefined;
	holdBreakpoints = false;
	heldBreakpointResponse: Record<string, unknown> | undefined;
	disassemblyReply: Record<string, unknown> = { instructions: [{ address: '0x1000', instruction: 'mov r0, r1', instructionBytes: '90', symbol: 'main', location: { name: 'main.ts', path: '/srv/project/main.ts' }, line: 4, column: 1 }] };
	dataInfoReply: Record<string, unknown> = { dataId: 'memory:counter', description: 'counter', canPersist: false, accessTypes: ['read', 'write', 'readWrite'] };
	readonly onConnectionState = this.connectionEmitter.event;

	constructor(private readonly stackFramePath = "C:\\workspace\\main.ts", private readonly supportsSetVariable = true, private readonly supportsAdvancedBreakpoints = true, private readonly supportsBreakpointFamilies = false, private readonly supportsDisassembly = false, public threadId = 7, public frameId = 11) { }

	async start(options: unknown): Promise<string> { this.started = options; return "debug-1"; }

	async send(_sessionId: string, message: unknown): Promise<void> {
		const request = message as Record<string, unknown>;
		this.sent.push(request);
		if (request.type !== "request") return;
		const command = String(request.command);
		if (command === "launch") this.event("initialized");
		const body = command === "initialize" ? { supportsConfigurationDoneRequest: true, supportsRestartRequest: true, supportsTerminateRequest: true, supportsSetVariable: this.supportsSetVariable, supportsConditionalBreakpoints: this.supportsAdvancedBreakpoints, supportsHitConditionalBreakpoints: this.supportsAdvancedBreakpoints, supportsLogPoints: this.supportsAdvancedBreakpoints, supportsFunctionBreakpoints: this.supportsBreakpointFamilies, supportsDataBreakpoints: this.supportsBreakpointFamilies, supportsInstructionBreakpoints: this.supportsBreakpointFamilies, supportsDisassembleRequest: this.supportsDisassembly, supportsSteppingGranularity: this.supportsDisassembly, exceptionBreakpointFilters: [{ filter: "uncaught", label: "Uncaught Exceptions", default: true }, { filter: "caught", label: "Caught Exceptions" }] }
			: command === "threads" ? { threads: [{ id: this.threadId, name: "main" }, { id: 8, name: "worker" }] }
				: command === "stackTrace" ? { stackFrames: [{ id: this.frameId, name: "main", source: { name: "main.ts", path: this.stackFramePath }, line: 4, column: 1 }, { id: 12, name: "system", line: 0, column: 0 }] }
					: command === "scopes" ? { scopes: [{ name: "Locals", variablesReference: 20 }] }
						: command === "variables" ? { variables: [{ name: "answer", value: "42", type: "number", variablesReference: 0 }] }
							: command === "setVariable" ? this.setVariableReply ?? { value: (request.arguments as Record<string, unknown>).value, type: "number" }
								: command === "evaluate" ? { result: "42", type: "number", variablesReference: 0 }
									: command === "source" ? { content: "const generated = true;", mimeType: "text/typescript" }
										: command === "disassemble" ? this.disassemblyReply
											: command === "dataBreakpointInfo" ? this.dataInfoReply
												: ['setFunctionBreakpoints', 'setDataBreakpoints', 'setInstructionBreakpoints'].includes(command) ? { breakpoints: ((request.arguments as { breakpoints: unknown[]; }).breakpoints).map(() => ({ verified: true })) }
													: command === "setBreakpoints" && Array.isArray((request.arguments as Record<string, unknown>)?.breakpoints) && ((request.arguments as Record<string, unknown>).breakpoints as unknown[]).length > 0 ? { breakpoints: [{ verified: true }] }
														: {};
		const response = { seq: 0, type: "response", request_seq: request.seq, success: true, command, body };
		if (command === 'setBreakpoints' && this.holdBreakpoints) this.heldBreakpointResponse = response;
		else this.enqueue(response);
	}

	async read(_sessionId: string, afterSequence: number, maxMessages: number): Promise<IDebugAdapterProcessReadResult> {
		const messages = this.messages.filter(message => message.sequence >= afterSequence).slice(0, maxMessages);
		return { messages, nextSequence: this.nextMessageSequence, outputGap: false, stderr: "", exited: false, exitCode: null, protocolError: null };
	}

	async close(): Promise<void> { this.closed = true; }
	async getConnectionState(): Promise<AppServerConnectionState> { return "ready"; }
	dispose(): void { this.connectionEmitter.dispose(); }
	releaseBreakpoints(): void {
		assert.ok(this.heldBreakpointResponse);
		this.holdBreakpoints = false;
		this.enqueue(this.heldBreakpointResponse);
		this.heldBreakpointResponse = undefined;
	}
	[Symbol.dispose](): void { this.dispose(); }

	event(event: string, body?: unknown): void { this.enqueue({ seq: 0, type: "event", event, ...(body === undefined ? {} : { body }) }); }
	reverseRequest(command: string, argumentsValue: unknown): void { this.enqueue({ seq: 0, type: "request", command, arguments: argumentsValue }); }
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

async function startSession(options: Omit<DebugAdapterSessionStartOptions, 'resolvedConfiguration'>): Promise<DebugAdapterSession> {
	using workspace = new WorkspaceContextService({ id: 'test', uri: options.workspace });
	using services = new InstantiationService(new ServiceCollection([IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], [ITerminalProcessService, { getEnvironment: async () => ({}) }], [IWorkspaceContextService, workspace]));
	services.registerSingleton(ICommandService, () => new CommandService(services));
	const resolver = services.createInstance(ConfigurationResolverService);
	const resolvedConfiguration = await resolver.resolveAsync(workspace.getWorkspace().folders[0], { adapter: options.configuration.adapter, arguments: options.configuration.arguments });
	assert.ok(resolvedConfiguration.adapter);
	return DebugAdapterSession.start({ id: 'debug-1', ...options, resolvedConfiguration: { ...resolvedConfiguration, adapter: resolvedConfiguration.adapter } });
}


for (const id of [0, -1]) {
	test(`DebugAdapterSession preserves thread and frame identifier ${id} across inspection and execution`, async () => {
		using processes = new FakeDebugAdapterProcessService('/workspace/main.ts', true, true, true);
		processes.threadId = id;
		processes.frameId = id;
		const session = await startSession({ configuration: configuration(), processService: processes, breakpoints: () => [], workspace: URI.file('/workspace') });
		try {
			processes.event('stopped', { threadId: id });
			await waitFor(() => session.state === 'stopped');
			assert.equal(session.threadId, id);
			assert.equal((await session.stackTrace())[0].id, id);
			assert.equal(processes.requests('threads').length, 0, 'stopped identifier is already selected');
			assert.equal((await session.threads())[0].id, id);
			session.selectThread(id);
			await session.scopes(id);
			await session.evaluate('answer', id, 'watch');
			await session.dataBreakpointInfo('answer', 20, id);
			assert.deepEqual(processes.request('scopes').arguments, { frameId: id });
			assert.deepEqual(processes.request('evaluate').arguments, { expression: 'answer', context: 'watch', frameId: id });
			assert.deepEqual(processes.request('dataBreakpointInfo').arguments, { name: 'answer', variablesReference: 20, frameId: id });
			await session.continue();
			assert.deepEqual(processes.request('continue').arguments, { threadId: id });
		} finally { await session.disconnect(); }
	});
}

for (const [path, address] of [
	['C:\\workspace\\main.ts', 'file:///C:/workspace/main.ts'],
	['\\\\server\\share\\main.ts', 'file://server/share/main.ts'],
	['/workspace/main\\part.ts', 'file:///workspace/main%5Cpart.ts'],
]) {
	test(`DAP file sources preserve execution path ${path}`, async () => {
		using processes = new FakeDebugAdapterProcessService(path);
		const session = await startSession({ configuration: configuration(), processService: processes, breakpoints: () => [], workspace: URI.file('/workspace') });
		try {
			assert.equal((await session.stackTrace())[0].source?.resource?.toString(), address);
		} finally { await session.disconnect(); }
	});
}


test('DebugAdapterSession reports invalid identifiers in the current locale without sending a request', async () => {
	using localization = toDisposable(resetNlsResolver);
	initializeTestLocalization('zh-CN');
	using processes = new FakeDebugAdapterProcessService();
	const session = await startSession({ configuration: configuration(), processService: processes, breakpoints: () => [], workspace: URI.file('/workspace') });
	try {
		processes.event('stopped', { threadId: 0 });
		await waitFor(() => session.state === 'stopped');
		assert.throws(() => session.selectThread(1.5), { message: 'threadId 必须是整数。' });
		await assert.rejects(session.scopes(1.5), { message: 'frameId 必须是整数。' });
		assert.equal(processes.requests('scopes').length, 0);
		assert.equal(session.threadId, 0);
	} finally { await session.disconnect(); }
});

for (const succeeds of [true, false]) {
	test(`DAP reverse startDebugging advertises its handler and sends a ${succeeds ? 'successful' : 'failed'} acknowledgement`, async () => {
		using processes = new FakeDebugAdapterProcessService();
		const requests: unknown[] = [];
		const session = await startSession({
			configuration: configuration(), processService: processes, breakpoints: () => [], workspace: URI.file('/workspace'), startDebugging: async value => {
				requests.push(value);
				if (!succeeds) throw new Error('Child launch declined');
			}
		});
		try {
			assert.equal((processes.request('initialize').arguments as Record<string, unknown>).supportsStartDebuggingRequest, true);
			const args = { request: 'launch', configuration: { program: 'child' } };
			processes.reverseRequest('startDebugging', args);
			await waitFor(() => processes.responses('startDebugging').length === 1);
			assert.deepEqual(requests, [args]);
			const response = processes.responses('startDebugging')[0]!;
			assert.deepEqual({ request_seq: response.request_seq, success: response.success, body: response.body, message: response.message }, { request_seq: 0, success: succeeds, body: undefined, message: succeeds ? undefined : 'Child launch declined' });
		} finally { await session.disconnect(); session.dispose(); }
	});
}
