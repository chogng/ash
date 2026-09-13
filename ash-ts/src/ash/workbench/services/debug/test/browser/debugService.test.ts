import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter, Event } from "../../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import { URI } from "../../../../../base/common/uri.js";
import { type AppServerConnectionState } from "../../../../../platform/app-server/common/appServerApi.js";
import { type IDebugAdapterProcessReadResult, type IDebugAdapterProcessService } from "../../../../../platform/debug/common/debugAdapterProcessService.js";
import { FileKind, FileNotFoundError, type IFileBytes, type IFileService, type IFileStat, type IFileWriteResult } from "../../../../../platform/files/common/files.js";
import { type IStorageService, type IStorageValueChangeEvent, type IWillSaveStateEvent, StorageScope, StorageTarget, type StorageValue, WillSaveStateReason } from "../../../../../platform/storage/common/storage.js";
import { type IWorkspaceContextService } from "../../../../../platform/workspace/common/workspace.js";
import { type ITaskRun, type ITaskService, type IWorkspaceTask, type TaskProvider, type TaskProviderRegistration } from "../../../../services/tasks/common/taskService.js";
import { type ITerminalService } from "../../../../services/terminal/common/terminal.js";
import { DebugAdapterFactoryRegistry, createStaticDebugAdapterFactory } from "../../common/debugAdapterFactory.js";
import { DebugService } from "../../browser/debugService.js";

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
	const root = URI.file("C:\\project");
	const workspace = workspaceService(root);
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	using first = new DebugService(new FakeFileService(root), workspace, processes, {} as ITerminalService, storage, tasks, adapters);
	first.toggleBreakpoint(URI.file("C:\\project\\main.ts"), 7);
	first.addWatchExpression("value + 1");
	await storage.flush();

	using second = new DebugService(new FakeFileService(root), workspace, processes, {} as ITerminalService, storage, tasks, adapters);
	assert.deepEqual(second.breakpoints.map(breakpoint => [breakpoint.resource.fsPath, breakpoint.lineNumber]), [["C:\\project\\main.ts", 7]]);
	assert.deepEqual(second.watchExpressions, ["value + 1"]);
});

test("DebugService starts compounds, runs launch lifecycle tasks, and owns multiple sessions", async () => {
	const root = URI.file("C:\\project");
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	using service = new DebugService(new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
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
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	using registration = adapters.registerFactories([createStaticDebugAdapterFactory("contributed", "Contributed", "extension:demo", { program: "demo-adapter", arguments: ["--stdio"] })]);
	using service = new DebugService(new FakeFileService(root, document), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);

	await service.refresh();

	assert.deepEqual(service.configurations[0]?.adapter, { program: "demo-adapter", arguments: ["--stdio"] });
});

class FakeFileService implements IFileService {
	readonly onDidChangeFiles = Event.None;
	constructor(private readonly root: URI, private readonly document = launchJson) {}
	async stat(resource: URI) { return { resource, kind: FileKind.File, sizeBytes: this.document.length, readonly: false, modifiedAtMillis: undefined }; }
	async readFile(resource: URI) { if (!resource.path.endsWith("/.vscode/launch.json")) throw new FileNotFoundError(resource); return { resource, content: this.document, revision: "1" }; }
	async readDirectory() { return []; }
	async readFileBytes(): Promise<IFileBytes> { throw new Error("unused"); }
	async writeFile(): Promise<IFileWriteResult> { throw new Error("unused"); }
	async createFile(): Promise<IFileStat> { throw new Error("unused"); }
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
	async run(taskValue: IWorkspaceTask): Promise<ITaskRun> { this.ran.push(taskValue.label); const run = { task: taskValue, terminal: {} as ITaskRun["terminal"], status: "succeeded" as const, exitCode: 0, onDidChangeStatus: Event.None }; this.lastRun = run; return run; }
	async terminate() {}
}

class FakeDebugAdapterProcessService implements IDebugAdapterProcessService {
	private readonly connectionEmitter = new Emitter<AppServerConnectionState>();
	private readonly sessions = new Map<string, { messages: Array<{ readonly sequence: number; readonly message: unknown }>; next: number; protocol: number }>();
	private nextSession = 1;
	readonly onConnectionState = this.connectionEmitter.event;
	async start(): Promise<string> { const id = `debug-${this.nextSession++}`; this.sessions.set(id, { messages: [], next: 0, protocol: 100 }); return id; }
	async send(sessionId: string, message: unknown): Promise<void> {
		const state = this.sessions.get(sessionId)!;
		const request = message as Record<string, unknown>;
		if (request.type !== "request") return;
		const command = String(request.command);
		if (command === "launch") this.enqueue(state, { seq: state.protocol++, type: "event", event: "initialized" });
		const body = command === "initialize" ? { supportsConfigurationDoneRequest: true } : {};
		this.enqueue(state, { seq: state.protocol++, type: "response", request_seq: request.seq, success: true, command, body });
	}
	async read(sessionId: string, afterSequence: number, maxMessages: number): Promise<IDebugAdapterProcessReadResult> { const state = this.sessions.get(sessionId)!; return { messages: state.messages.filter(message => message.sequence >= afterSequence).slice(0, maxMessages), nextSequence: state.next, outputGap: false, stderr: "", exited: false, exitCode: null, protocolError: null }; }
	async close(sessionId: string): Promise<void> { this.sessions.delete(sessionId); }
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

function workspaceService(root: URI): IWorkspaceContextService { return { onDidChangeWorkspace: Event.None, getWorkspace: () => ({ id: "workspace", folders: [{ id: "workspace", uri: root, name: "project", index: 0 }] }), getWorkbenchState: () => 2 }; }
function task(label: string): IWorkspaceTask { return Object.freeze({ id: `vscode:${label}`, label, command: label, source: "vscode", group: "other" }); }
