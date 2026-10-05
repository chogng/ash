import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { ITaskService } from '../../../../services/tasks/common/taskService.js';
import { IDebugAdapterFactorySource } from '../../common/debugAdapterFactory.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter, Event } from "../../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import { URI } from "../../../../../base/common/uri.js";
import { type AppServerConnectionState } from "../../../../../platform/app-server/common/appServerApi.js";
import { type IDebugAdapterProcessReadResult, IDebugAdapterProcessService } from "../../../../../platform/debug/common/debugAdapterProcessService.js";
import { FileKind, FileNotFoundError, type IFileBytes, IFileService, type IFileStat, type IFileWriteResult } from "../../../../../platform/files/common/files.js";
import { IStorageService, type IStorageValueChangeEvent, type IWillSaveStateEvent, StorageScope, StorageTarget, type StorageValue, WillSaveStateReason } from "../../../../../platform/storage/common/storage.js";
import { IWorkspaceContextService } from "../../../../../platform/workspace/common/workspace.js";
import { type ITaskRun, type IWorkspaceTask, type TaskProvider, type TaskProviderRegistration } from "../../../../services/tasks/common/taskService.js";
import { ITerminalService } from "../../../../contrib/terminal/browser/terminal.js";
import { DebugAdapterFactoryRegistry, createStaticDebugAdapterFactory } from "../../common/debugAdapterFactory.js";
import { DebugService } from "../../../../contrib/debug/browser/debugService.js";
import { DebugAdapterSession } from "../../browser/debugAdapterSession.js";

const launchJson = `{
  "version": "0.2.0",
  "configurations": [
    { "name": "One", "type": "example", "request": "launch", "debugAdapter": { "program": "adapter" }, "preLaunchTask": "build", "postDebugTask": "cleanup" },
    { "name": "Two", "type": "example", "request": "launch", "debugAdapter": { "program": "adapter" } }
  ],
  "compounds": [{ "name": "Both", "configurations": ["One", "Two"], "preLaunchTask": "prepare", "stopAll": true }]
}`;

test("DebugService persists workspace breakpoints and watch expressions", async () => {
	const storage = new TestStorageService();
	const root = URI.parse('file:///C:/project');
	const resource = URI.parse('file:///C:/project/main.ts');
	const workspace = workspaceService(root);
	using resources = new DisposableStore();
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	using first = createDebugService(resources, new FakeFileService(root), workspace, processes, {} as ITerminalService, storage, tasks, adapters);
	first.toggleBreakpoint(resource, 7);
	first.updateBreakpoint(first.breakpoints[0]!.id, { enabled: false, condition: 'value > 0', hitCondition: '>= 3', logMessage: ' value = {value} ' });
	first.addWatchExpression("value + 1");
	await storage.flush();

	using second = createDebugService(resources, new FakeFileService(root), workspace, processes, {} as ITerminalService, storage, tasks, adapters);
	assert.deepEqual(second.breakpoints, [{ id: `${resource.toString()}:7`, resource, lineNumber: 7, enabled: false, verified: false, condition: 'value > 0', hitCondition: '>= 3', logMessage: ' value = {value} ' }]);
	assert.deepEqual(second.watchExpressions, ["value + 1"]);
	second.setBreakpointsEnabled(true);
	second.updateBreakpoint(second.breakpoints[0]!.id, { condition: '', hitCondition: '', logMessage: '' });
	assert.deepEqual(second.breakpoints.map(point => ({ enabled: point.enabled, condition: point.condition, hitCondition: point.hitCondition, logMessage: point.logMessage })), [{ enabled: true, condition: undefined, hitCondition: undefined, logMessage: undefined }]);
	assert.throws(() => second.updateBreakpoint(second.breakpoints[0]!.id, { condition: '\0' }), /no null characters/);
	second.removeAllBreakpoints();
	await storage.flush();
	using third = createDebugService(resources, new FakeFileService(root), workspace, processes, {} as ITerminalService, storage, tasks, adapters);
	assert.deepEqual(third.breakpoints, []);
});

test('DebugService persists durable breakpoint families and retires session addresses', async () => {
	const root = URI.file('C:\\project');
	const storage = new TestStorageService();
	using resources = new DisposableStore();
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, storage, tasks, adapters);
	await service.refresh();
	service.addFunctionBreakpoint({ name: 'app::worker', condition: ' counter > 0 ', hitCondition: '>= 2' });
	const session = await service.startDebugging(service.configurations[1]!);
	const stopped = new Promise<void>(resolve => {
		const listener = resources.add(session.onDidChangeState(state => {
			if (state === 'stopped') { listener.dispose(); resolve(); }
		}));
	});
	processes.event(session.id, 'stopped', { threadId: 1 });
	await stopped;
	const focusedFrames: unknown[] = [];
	resources.add(service.onDidFocusStackFrame(frame => focusedFrames.push(frame)));
	const focusedFrame = { id: 11, name: 'main', lineNumber: 4, columnNumber: 1, instructionPointerReference: '0x1000' };
	service.focusStackFrame(focusedFrame);
	assert.equal(service.focusedStackFrame, focusedFrame);
	const options = { sessionId: session.id, dataId: ' memory:counter ', description: '', accessTypes: ['read', 'write', 'readWrite'] as const, accessType: 'readWrite' as const, canPersist: true, condition: 'counter > 0' };
	service.addDataBreakpoint(options);
	service.addDataBreakpoint({ ...options, dataId: 'stack:counter', canPersist: false });
	service.addInstructionBreakpoint({ instructionReference: '0x1000', offset: -4, hitCondition: '2' });
	assert.throws(() => service.addDataBreakpoint({ ...options, sessionId: 'other' }), /paused session/);
	assert.throws(() => service.addDataBreakpoint({ ...options, accessTypes: ['write'] }), /Unsupported data/);
	assert.throws(() => service.addInstructionBreakpoint({ instructionReference: '0x1000', offset: 1.5 }), /integer/);
	assert.throws(() => service.updateBreakpoint(service.functionBreakpoints[0]!.id, { offset: 4 }), /Only instruction/);
	await (session as DebugAdapterSession).syncBreakpoints();
	const last = (command: string) => processes.requests.filter(request => request.command === command).at(-1)?.arguments;
	assert.deepEqual(last('setFunctionBreakpoints'), { breakpoints: [{ name: 'app::worker', condition: ' counter > 0 ', hitCondition: '>= 2' }] });
	assert.deepEqual(last('setDataBreakpoints'), { breakpoints: [
		{ dataId: ' memory:counter ', accessType: 'readWrite', condition: 'counter > 0' },
		{ dataId: 'stack:counter', accessType: 'readWrite', condition: 'counter > 0' },
	] });
	assert.deepEqual(last('setInstructionBreakpoints'), { breakpoints: [{ instructionReference: '0x1000', offset: -4, hitCondition: '2' }] });
	await service.stop(session);
	assert.equal(service.focusedStackFrame, undefined);
	assert.deepEqual(focusedFrames, [focusedFrame, undefined]);
	assert.equal(service.dataBreakpoints.length, 1);
	assert.equal(service.instructionBreakpoints.length, 0);
	await storage.flush();
	const stored = JSON.parse(storage.get('memento/debug.workspace', StorageScope.WORKSPACE)!);
	assert.equal(stored.version, 2);
	assert.equal(stored.dataBreakpoints.length, 1);
	assert.equal(stored.dataBreakpoints[0].sessionId, undefined);
	assert.equal(stored.functionBreakpoints[0].verified, undefined);
	using restored = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, storage, tasks, adapters);
	assert.equal(restored.functionBreakpoints[0]?.name, 'app::worker');
	assert.equal(restored.functionBreakpoints[0]?.verified, false);
	assert.equal(restored.dataBreakpoints[0]?.dataId, ' memory:counter ');
	assert.equal(restored.dataBreakpoints[0]?.sessionId, undefined);
	assert.deepEqual(restored.instructionBreakpoints, []);
	restored.setBreakpointsEnabled(false);
	assert.equal(restored.functionBreakpoints[0]?.enabled, false);
	assert.equal(restored.dataBreakpoints[0]?.enabled, false);
	restored.removeAllBreakpoints();
	assert.deepEqual(restored.functionBreakpoints, []);
	assert.deepEqual(restored.dataBreakpoints, []);
});

test('DebugService migrates source breakpoint storage without losing expressions or watches', async () => {
	const root = URI.file('C:\\project');
	const storage = new TestStorageService();
	storage.store('memento/debug.workspace', JSON.stringify({ version: 1, breakpoints: [{ resource: URI.joinPath(root, 'main.ts').toString(), lineNumber: 7, enabled: false, condition: 'x > 0' }], watchExpressions: ['x'], exceptionBreakpoints: {} }), StorageScope.WORKSPACE, StorageTarget.USER);
	using resources = new DisposableStore();
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, storage, tasks, adapters);
	assert.equal(service.breakpoints[0]?.condition, 'x > 0');
	assert.equal(service.breakpoints[0]?.enabled, false);
	assert.deepEqual(service.watchExpressions, ['x']);
	assert.deepEqual(service.functionBreakpoints, []);
	await storage.flush();
	assert.equal(JSON.parse(storage.get('memento/debug.workspace', StorageScope.WORKSPACE)!).version, 2);
});

test("DebugService starts compounds, runs launch lifecycle tasks, and owns multiple sessions", async () => {
	const root = URI.file("C:\\project");
	using resources = new DisposableStore();
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	await service.refresh();
	const sessions = await service.startCompound(service.compounds[0]!);

	assert.equal(sessions.length, 2);
	assert.equal(service.sessions.length, 2);
	assert.equal(service.session, sessions[1]);
	assert.deepEqual(tasks.ran, ["prepare", "build"]);
	service.setActiveSession(sessions[0]!);
	assert.equal(service.session, sessions[0]);
	await service.stopAll();
	assert.equal(service.sessions.length, 0);
	assert.deepEqual(tasks.ran, ["prepare", "build", "cleanup"]);
});

test("DebugService resolves adapter executables from the canonical factory source", async () => {
	const root = URI.file("C:\\project");
	const document = `{"version":"0.2.0","configurations":[{"name":"Contributed","type":"contributed","request":"launch"}]}`;
	using resources = new DisposableStore();
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	using registration = adapters.registerFactories([createStaticDebugAdapterFactory("contributed", "Contributed", "extension:demo", { program: "demo-adapter", arguments: ["--stdio"] })]);
	using service = createDebugService(resources, new FakeFileService(root, document), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);

	await service.refresh();

	assert.deepEqual(service.configurations[0]?.adapter, { program: "demo-adapter", arguments: ["--stdio"] });
});

test('DebugService launches and restarts supplied test configurations without launch.json entries', async () => {
	const root = URI.file('C:\\project');
	using resources = new DisposableStore();
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	using service = createDebugService(resources, new FakeFileService(root, '{"version":"0.2.0","configurations":[]}'), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	await service.refresh();
	const configuration = { id: 'test-launch', dirId: 'workspace', name: 'Debug test', type: 'lldb-dap', request: 'launch' as const, adapter: { program: 'lldb-dap', arguments: [] }, arguments: { program: 'test-binary', args: ['--exact', 'generated_case'], cwd: root.fsPath } };
	const session = await service.startDebugging(configuration);
	assert.deepEqual(service.configurations, []);
	assert.deepEqual(processes.requests.find(request => request.command === 'launch')?.arguments, configuration.arguments);
	const restarted = await service.restart(session);
	assert.notEqual(restarted.id, session.id);
	assert.equal(restarted.configuration, configuration);
	assert.equal(processes.requests.filter(request => request.command === 'launch').length, 2);
	assert.deepEqual(tasks.ran, []);
	await service.stop(restarted);
	assert.equal(service.sessions.length, 0);
});

class FakeFileService implements IFileService {
	readonly onDidChangeFiles = Event.None;
	constructor(private readonly root: URI, private readonly document = launchJson) {}
	async stat(resource: URI) { return { resource, kind: FileKind.File, sizeBytes: this.document.length, readonly: false, modifiedAtMillis: undefined }; }
	async readFile(resource: URI) { if (!resource.path.endsWith("/.vscode/launch.json")) throw new FileNotFoundError(resource); return { resource, content: this.document, revision: "1" }; }
	async readDirectory() { return []; }
	async readFileBytes(): Promise<IFileBytes> { throw new Error("unused"); }
	async writeFile(): Promise<IFileWriteResult> { throw new Error("unused"); }
	async writeFileBytes(): Promise<IFileWriteResult> { throw new Error("unused"); }
	async createFile(): Promise<IFileStat> { throw new Error("unused"); }
	async createDirectory(): Promise<IFileStat> { throw new Error("unused"); }
	async copy(): Promise<void> { throw new Error("Copy is not used in this test"); }
	async rename() { throw new Error("unused"); }
	async delete() { throw new Error("unused"); }
}

class FakeTaskService extends Disposable implements ITaskService {
	readonly tasks: readonly IWorkspaceTask[] = Object.freeze([task("prepare"), task("build"), task("cleanup")]);
	readonly activeRuns = Object.freeze([]);
	lastRun: ITaskRun | undefined;
	readonly ran: string[] = [];
	readonly onDidChangeTasks = Event.None;
	readonly onDidStartTask = Event.None;
	readonly onDidChangeTaskRun = Event.None;
	registerTaskProvider(_provider: TaskProvider) { return toDisposable(() => undefined); }
	registerTaskProviders(_providers: readonly TaskProvider[]): TaskProviderRegistration { const registration = toDisposable(() => undefined) as TaskProviderRegistration; registration.replace = () => undefined; return registration; }
	async refresh() { return this.tasks; }
	async run(taskValue: IWorkspaceTask): Promise<ITaskRun> { this.ran.push(taskValue.label); const run = { task: taskValue, terminalId: "task-terminal", status: "succeeded" as const, exitCode: 0, onDidChangeStatus: Event.None }; this.lastRun = run; return run; }
	async terminate() {}
}

class FakeDebugAdapterProcessService implements IDebugAdapterProcessService {
	private readonly connectionEmitter = new Emitter<AppServerConnectionState>();
	private readonly sessions = new Map<string, { messages: Array<{ readonly sequence: number; readonly message: unknown }>; next: number }>();
	private nextSession = 1;
	readonly requests: Record<string, unknown>[] = [];
	readonly onConnectionState = this.connectionEmitter.event;
	async start(): Promise<string> { const id = `debug-${this.nextSession++}`; this.sessions.set(id, { messages: [], next: 0 }); return id; }
	async send(sessionId: string, message: unknown): Promise<void> {
		const state = this.sessions.get(sessionId)!;
		const request = message as Record<string, unknown>;
		if (request.type !== "request") return;
		this.requests.push(request);
		const command = String(request.command);
		if (command === "launch") this.enqueue(state, { seq: 0, type: "event", event: "initialized" });
		const body = command === "initialize" ? { supportsConfigurationDoneRequest: true, supportsFunctionBreakpoints: true, supportsDataBreakpoints: true, supportsInstructionBreakpoints: true, supportsConditionalBreakpoints: true, supportsHitConditionalBreakpoints: true } : command.startsWith('set') && command.endsWith('Breakpoints') ? { breakpoints: ((request.arguments as { breakpoints?: unknown[] })?.breakpoints ?? []).map(() => ({ verified: true })) } : {};
		this.enqueue(state, { seq: 0, type: "response", request_seq: request.seq, success: true, command, body });
	}
	async read(sessionId: string, afterSequence: number, maxMessages: number): Promise<IDebugAdapterProcessReadResult> { const state = this.sessions.get(sessionId)!; return { messages: state.messages.filter(message => message.sequence >= afterSequence).slice(0, maxMessages), nextSequence: state.next, outputGap: false, stderr: "", exited: false, exitCode: null, protocolError: null }; }
	async close(sessionId: string): Promise<void> { this.sessions.delete(sessionId); }
	event(sessionId: string, event: string, body: unknown): void { this.enqueue(this.sessions.get(sessionId)!, { seq: 0, type: 'event', event, body }); }
	async getConnectionState(): Promise<AppServerConnectionState> { return "ready"; }
	dispose(): void { this.connectionEmitter.dispose(); }
	[Symbol.dispose](): void { this.dispose(); }
	private enqueue(state: { messages: Array<{ readonly sequence: number; readonly message: unknown }>; next: number }, message: unknown): void { state.messages.push({ sequence: state.next++, message }); }
}

class TestStorageService implements IStorageService {
	private readonly changeEmitter = new Emitter<IStorageValueChangeEvent>();
	private readonly saveEmitter = new Emitter<IWillSaveStateEvent>();
	private readonly values = new Map<string, string>();
	readonly onDidChangeValue = this.changeEmitter.event;
	readonly onWillSaveState = this.saveEmitter.event;
	get(key: string, scope: StorageScope, fallbackValue: string): string;
	get(key: string, scope: StorageScope): string | undefined;
	get(key: string, scope: StorageScope, fallbackValue?: string): string | undefined { return this.values.get(`${scope}:${key}`) ?? fallbackValue; }
	getBoolean(key: string, scope: StorageScope, fallbackValue: boolean): boolean;
	getBoolean(key: string, scope: StorageScope): boolean | undefined;
	getBoolean(key: string, scope: StorageScope, fallbackValue?: boolean): boolean | undefined { const value = this.get(key, scope); return value === "true" ? true : value === "false" ? false : fallbackValue; }
	getNumber(key: string, scope: StorageScope, fallbackValue: number): number;
	getNumber(key: string, scope: StorageScope): number | undefined;
	getNumber(key: string, scope: StorageScope, fallbackValue?: number): number | undefined { const value = this.get(key, scope); return value === undefined ? fallbackValue : Number(value); }
	store(key: string, value: StorageValue, scope: StorageScope, target: StorageTarget): void { if (value === undefined || value === null) this.remove(key, scope); else this.values.set(`${scope}:${key}`, String(value)); this.changeEmitter.fire({ key, scope, target, external: false }); }
	remove(key: string, scope: StorageScope): void { this.values.delete(`${scope}:${key}`); }
	keys(scope: StorageScope): readonly string[] { return [...this.values.keys()].filter(key => key.startsWith(`${scope}:`)).map(key => key.slice(scope.length + 1)); }
	isNew(_scope: StorageScope): boolean { return false; }
	async flush(reason: WillSaveStateReason = WillSaveStateReason.PERIODIC): Promise<void> { this.saveEmitter.fire({ reason }); }
}

function workspaceService(root: URI): IWorkspaceContextService {
	return {
		onDidChangeWorkspace: Event.None,
		getWorkspace: () => ({ id: "workspace", folders: [{ id: "workspace", uri: root, name: "project", index: 0 }] }),
		getWorkbenchState: () => 2,
		getWorkspaceFolder: () => null,
	};
}
function task(label: string): IWorkspaceTask { return Object.freeze({ id: `vscode:${label}`, label, command: label, source: "vscode", group: "other" }); }

function createDebugService(owner: DisposableStore, files: IFileService, workspace: IWorkspaceContextService, processes: IDebugAdapterProcessService | undefined, terminals: ITerminalService, storage: IStorageService, tasks: ITaskService, adapters: DebugAdapterFactoryRegistry): DebugService {
	const services = owner.add(new InstantiationService(new ServiceCollection(
		[IFileService, files],
		[IWorkspaceContextService, workspace],
		[IDebugAdapterProcessService, processes],
		[ITerminalService, terminals],
		[IStorageService, storage],
		[ITaskService, tasks],
		[IDebugAdapterFactorySource, adapters],
		[ILogService, new NullLoggerService()],
	)));
	return services.createInstance(DebugService);
}

test('DebugService rejects missing process registration and reports an explicitly unavailable host before launch', async () => {
	using resources = new DisposableStore();
	const root = URI.file('/workspace');
	const files = new FakeFileService(root);
	const workspace = workspaceService(root);
	using tasks = new FakeTaskService();
	using adapters = new DebugAdapterFactoryRegistry();
	using missing = new InstantiationService(new ServiceCollection([IFileService, files], [IWorkspaceContextService, workspace]));
	assert.throws(() => missing.createInstance(DebugService), /Unknown service: debugAdapterProcessService/);
	using service = createDebugService(resources, files, workspace, undefined, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	await assert.rejects(service.startDebugging({ id: 'unavailable', name: 'Unavailable', type: 'example', request: 'launch', adapter: { program: 'adapter', arguments: [] }, arguments: {} }), /This host does not provide the Code debug adapter capability/);
	assert.deepEqual(tasks.ran, []);
});
