import { IEditorService } from '../../../editor/common/editorService.js';
import { IEditorGroupsService } from '../../../editor/common/editorGroupsService.js';
import { emptyEditorServiceState } from '../../../../test/common/testEditorService.js';
import { ConfigurationRegistry, ConfigurationScope } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { TestUriIdentityServices } from '../../../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { DebugContentProvider } from '../../../../contrib/debug/common/debugContentProvider.js';
import { getUriFromSource } from '../../../../contrib/debug/common/debugSource.js';
import { DebugConsoleService } from '../../browser/debugConsoleService.js';
import { MainThreadDebugService } from '../../../../api/browser/mainThreadDebugService.js';
import { IExtensionHostApi, type ExtensionHostFleetSnapshot, type JsonValue } from '../../../../../platform/extensionHost/common/extensionHostApi.js';
import { registerTestWorkbenchInteractionServices, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { TaskService } from '../../../../contrib/tasks/browser/taskService.js';
import { TerminalService } from '../../../../contrib/terminal/browser/terminalService.js';
import { IMarkerService, MarkerService } from '../../../../../platform/markers/common/markers.js';
import { IExtensionService } from '../../../extensions/common/extensionService.js';
import { normalizeExtensionCatalog } from '../../../../../platform/extensions/common/extensionApi.js';
import { ExtensionResourceLoaderService } from '../../../../../platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import { createHash } from 'node:crypto';
import { registerTestExtensionService, TestExtensionService } from '../../../../test/common/testExtensionServices.js';
import { WorkbenchConfigurationService } from '../../../configuration/browser/configurationService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IRendererHostService } from '../../../../../platform/renderer/common/rendererHost.js';
import { createDisconnectedRendererApi } from '../../../../../platform/agentHost/browser/rendererApi.js';
import { BrowserPathService } from '../../../path/browser/pathService.js';
import { IPathService } from '../../../../../platform/path/common/pathService.js';
import { DebugConfigurationProviderTriggerKind, DebugConsoleMode, IDebugService, type DebugConfiguration, type IDebugConfiguration } from '../../common/debugService.js';
import '../../../../contrib/debug/browser/debugActions.js';
import { SELECT_AND_START_ID } from '../../../../contrib/debug/common/debug.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createExtensionHostDebugAdapterFactory, createExtensionHostDebugAdapterTrackerFactory } from '../../../../api/browser/extensionHostWorkflowBridge.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { CommandService } from '../../../commands/common/commandService.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { initializeTestLocalization } from '../../../localization/test/common/localizationTestUtils.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { WorkspaceContextService } from '../../../workspaces/browser/workspaceContextService.js';
import { ITerminalProcessService } from '../../../../../platform/terminal/common/terminal.js';
import { ConfigurationResolverService } from '../../../configurationResolver/browser/configurationResolverService.js';
import { IConfigurationResolverService } from '../../../configurationResolver/common/configurationResolver.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { type IFileSystemProvider, type IFileWriteOptions, FileSystemProviderCapabilities } from '../../../../../platform/files/common/files.js';
import { createTestFileService } from '../../../../test/common/testEditorServices.js';
import { DisposableStore, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { ITaskService } from '../../../../services/tasks/common/taskService.js';
import { IDebugAdapterFactorySource } from '../../common/debugAdapterFactory.js';
import assert from "node:assert/strict";
import { suite, test } from "mocha";
import { Emitter, Event } from "../../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import { URI } from "../../../../../base/common/uri.js";
import { type AppServerConnectionState } from "../../../../../platform/agentHost/common/appServerApi.js";
import { type IDebugAdapterProcessReadResult, IDebugAdapterProcessService } from "../../../../../platform/debug/common/debugAdapterProcessService.js";
import { FileKind, FileNotFoundError, type IFileBytes, IFileService, type IFileStat, type IFileWriteResult } from "../../../../../platform/files/common/files.js";
import { IStorageService, type IStorageValueChangeEvent, type IWillSaveStateEvent, StorageScope, StorageTarget, type StorageValue, WillSaveStateReason } from "../../../../../platform/storage/common/storage.js";
import { IWorkspaceContextService } from "../../../../../platform/workspace/common/workspace.js";
import { type ITaskRun, type IWorkspaceTask, type TaskProvider, type TaskProviderRegistration, type TaskRunStatus } from "../../../../services/tasks/common/taskService.js";
import { ITerminalService } from "../../../../contrib/terminal/browser/terminal.js";
import { DebugAdapterFactoryRegistry, createStaticDebugAdapterFactory } from "../../common/debugAdapterFactory.js";
import { DebugService } from "../../../../contrib/debug/browser/debugService.js";
import { DebugAdapterSession } from "../../browser/debugAdapterSession.js";
import { JSDOM } from 'jsdom';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { WorkbenchQuickInputService } from '../../../quickinput/browser/quickInputService.js';

const launchJson = `{
  "version": "0.2.0",
  "configurations": [
    { "name": "One", "type": "example", "request": "launch", "debugAdapter": { "program": "adapter" }, "preLaunchTask": "build", "postDebugTask": "cleanup" },
    { "name": "Two", "type": "example", "request": "launch", "debugAdapter": { "program": "adapter" } }
  ],
  "compounds": [{ "name": "Both", "configurations": ["One", {"name":"Two", "folder":"project"}], "preLaunchTask": "prepare", "stopAll": true }]
}`;

test('DebugService exposes the active session state for the pause shortcut and clears it after stopping', async () => {
	using resources = new DisposableStore();
	const root = URI.file('C:\\project');
	const contextKeys = resources.add(new ContextKeyService());
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters, contextKeys);
	assert.equal(contextKeys.getContext().getValue('debugState'), 'inactive');
	await service.refresh();
	const session = await service.startDebugging(service.configurations[1]!);
	assert.equal(contextKeys.getContext().getValue('debugState'), 'running');
	const stopped = new Promise<void>(resolve => {
		const listener = resources.add(session.onDidChangeState(state => {
			if (state === 'stopped') { listener.dispose(); resolve(); }
		}));
	});
	processes.event('debug-1', 'stopped', { threadId: 1 });
	await stopped;
	assert.equal(contextKeys.getContext().getValue('debugState'), 'stopped');
	await service.stop(session);
	assert.equal(contextKeys.getContext().getValue('debugState'), 'inactive');
});

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

test('DebugService reloads external state, preserves pending edits and releases storage listeners on disposal', async () => {
	using storage = new TestStorageService();
	using resources = new DisposableStore();
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	const root = URI.file('/workspace');
	using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, storage, tasks, adapters);
	const externalState = (expression: string) => JSON.stringify({ version: 2, breakpoints: [], functionBreakpoints: [], dataBreakpoints: [], watchExpressions: [expression], exceptionBreakpoints: {} });
	storage.storeExternal('memento/debug.workspace', externalState('remote'), StorageScope.WORKSPACE, StorageTarget.USER);
	assert.deepEqual(service.watchExpressions, ['remote']);
	service.addWatchExpression('local');
	storage.storeExternal('memento/debug.workspace', externalState('newer-remote'), StorageScope.WORKSPACE, StorageTarget.USER);
	assert.deepEqual(service.watchExpressions, ['remote', 'local']);
	await storage.flush();
	assert.deepEqual(JSON.parse(storage.get('memento/debug.workspace', StorageScope.WORKSPACE)!).watchExpressions, ['remote', 'local']);
	service.dispose();
	storage.storeExternal('memento/debug.workspace', externalState('after-disposal'), StorageScope.WORKSPACE, StorageTarget.USER);
	await storage.flush();
	assert.deepEqual(service.watchExpressions, ['remote', 'local']);
	assert.equal(storage.get('memento/debug.workspace', StorageScope.WORKSPACE), externalState('after-disposal'));
});

test('DebugService rejects persisted state with an invalid Debug schema', () => {
	using storage = new TestStorageService();
	using resources = new DisposableStore();
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	const root = URI.file('/workspace');
	storage.store('memento/debug.workspace', '{"version":99}', StorageScope.WORKSPACE, StorageTarget.USER);
	assert.throws(() => createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, storage, tasks, adapters), /Debug workspace state version is unsupported/);
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
	processes.event('debug-1', 'stopped', { threadId: 1 });
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
	assert.deepEqual(last('setDataBreakpoints'), {
		breakpoints: [
			{ dataId: ' memory:counter ', accessType: 'readWrite', condition: 'counter > 0' },
			{ dataId: 'stack:counter', accessType: 'readWrite', condition: 'counter > 0' },
		]
	});
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

class FakeFileService implements IFileSystemProvider {
	public readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy;
	public readonly onDidChangeCapabilities = Event.None;
	public watch(): IDisposable { return Disposable.None; }

	readonly onDidChangeFiles = Event.None;
	constructor(private readonly root: URI, private readonly document = launchJson) { }
	async stat(resource: URI) { return { resource, kind: FileKind.File, sizeBytes: this.document.length, readonly: false, modifiedAtMillis: undefined }; }
	async readDirectory() { return []; }
	async readFile(resource: URI): Promise<IFileBytes> { if (!resource.path.endsWith("/.vscode/launch.json")) throw new FileNotFoundError(resource); return { resource, bytes: new TextEncoder().encode(this.document), revision: "1" }; }
	public async writeFile(resource: URI, bytes: Uint8Array, options: IFileWriteOptions): Promise<IFileWriteResult> {
		if (!options.overwrite) { throw new Error("unused"); }
		const request = { resource, content: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes), ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }) };
		throw new Error("unused");
	}
	async createFile(): Promise<IFileStat> { throw new Error("unused"); }
	async createDirectory(): Promise<IFileStat> { throw new Error("unused"); }
	async copy(): Promise<void> { throw new Error("Copy is not used in this test"); }
	async rename() { throw new Error("unused"); }
	async delete() { throw new Error("unused"); }
}

class FakeTaskService extends Disposable implements ITaskService {
	async rerun(): Promise<undefined> { return undefined; }
	async runProvidedTask(): Promise<never> { throw new Error('Provided task execution is outside this fixture'); }
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
	async terminate() { }
}

class FakeDebugAdapterProcessService implements IDebugAdapterProcessService {
	readonly reverseResponses = new Emitter<{ readonly sessionId: string; readonly response: Record<string, unknown>; }>();
	readonly closed: string[] = [];
	private readonly connectionEmitter = new Emitter<AppServerConnectionState>();
	private readonly sessions = new Map<string, { messages: Array<{ readonly sequence: number; readonly message: unknown; }>; next: number; }>();
	private nextSession = 1;
	public earlyCustomEvent = false;
	public breakpointIds = false;
	public closeBarrier: DeferredPromise<void> | undefined;
	public closeRequested: DeferredPromise<void> | undefined;
	public customHandler: ((request: Record<string, unknown>) => { readonly body?: unknown; readonly success?: boolean; readonly message?: string; }) | undefined;
	public sourceHandler: ((request: Record<string, unknown>) => unknown | Promise<unknown>) | undefined;
	public requestHandler: ((request: Record<string, unknown>) => unknown | Promise<unknown>) | undefined;
	readonly requests: Record<string, unknown>[] = [];
	readonly requestsBySession = new Map<string, Record<string, unknown>[]>();
	readonly started: unknown[] = [];
	readonly onConnectionState = this.connectionEmitter.event;
	async start(options: unknown): Promise<string> { this.started.push(options); const id = `debug-${this.nextSession++}`; this.sessions.set(id, { messages: [], next: 0 }); return id; }
	async send(sessionId: string, message: unknown): Promise<void> {
		const state = this.sessions.get(sessionId)!;
		const request = message as Record<string, unknown>;
		if (request.type === 'response') { this.reverseResponses.fire({ sessionId, response: request }); return; }
		if (request.type !== "request") return;
		this.requests.push(request);
		const sessionRequests = this.requestsBySession.get(sessionId) ?? [];
		sessionRequests.push(request);
		this.requestsBySession.set(sessionId, sessionRequests);
		const command = String(request.command);
		if (command === "launch" || command === "attach") {
			if (this.earlyCustomEvent) this.enqueue(state, { seq: 0, type: "event", event: "builderReady", body: null });
			this.enqueue(state, { seq: 0, type: "event", event: "initialized" });
		}
		if (command.startsWith('custom:') && this.customHandler) {
			this.enqueue(state, { seq: 0, type: 'response', request_seq: request.seq, command, success: true, ...this.customHandler(request) });
			return;
		}
		const handler = command === 'source' ? this.sourceHandler : this.requestHandler;
		if (handler) {
			void Promise.resolve(handler(request)).then(body => {
				if (this.sessions.get(sessionId) === state) this.enqueue(state, { seq: 0, type: 'response', request_seq: request.seq, command, success: true, body });
			}, error => {
				if (this.sessions.get(sessionId) === state) this.enqueue(state, { seq: 0, type: 'response', request_seq: request.seq, command, success: false, message: String(error) });
			});
			return;
		}
		const body = command === "initialize" ? { supportsConfigurationDoneRequest: true, supportsFunctionBreakpoints: true, supportsDataBreakpoints: true, supportsInstructionBreakpoints: true, supportsConditionalBreakpoints: true, supportsHitConditionalBreakpoints: true } : command.startsWith('set') && command.endsWith('Breakpoints') ? { breakpoints: ((request.arguments as { breakpoints?: unknown[]; })?.breakpoints ?? []).map((point, index) => ({ verified: true, ...(this.breakpointIds ? { id: index + 100, ...point as object } : {}) })) } : {};
		this.enqueue(state, { seq: 0, type: "response", request_seq: request.seq, success: true, command, body });
	}
	async read(sessionId: string, afterSequence: number, maxMessages: number): Promise<IDebugAdapterProcessReadResult> { const state = this.sessions.get(sessionId)!; return { messages: state.messages.filter(message => message.sequence >= afterSequence).slice(0, maxMessages), nextSequence: state.next, outputGap: false, stderr: "", exited: false, exitCode: null, protocolError: null }; }
	async close(sessionId: string): Promise<void> {
		this.closed.push(sessionId);
		void this.closeRequested?.complete(undefined);
		await this.closeBarrier?.p;
		this.sessions.delete(sessionId);
	}
	event(sessionId: string, event: string, body: unknown): void { this.enqueue(this.sessions.get(sessionId)!, { seq: 0, type: 'event', event, body }); }
	reverseRequest(sessionId: string, argumentsValue: unknown): void { this.enqueue(this.sessions.get(sessionId)!, { seq: 11, type: 'request', command: 'startDebugging', arguments: argumentsValue }); }
	async getConnectionState(): Promise<AppServerConnectionState> { return "ready"; }
	dispose(): void { this.reverseResponses.dispose(); this.connectionEmitter.dispose(); }
	[Symbol.dispose](): void { this.dispose(); }
	private enqueue(state: { messages: Array<{ readonly sequence: number; readonly message: unknown; }>; next: number; }, message: unknown): void { state.messages.push({ sequence: state.next++, message }); }
}

class TestStorageService extends Disposable implements IStorageService {
	private readonly changeEmitter = this._register(new Emitter<IStorageValueChangeEvent>());
	private readonly saveEmitter = this._register(new Emitter<IWillSaveStateEvent>());
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
	storeExternal(key: string, value: string, scope: StorageScope, target: StorageTarget): void {
		this.values.set(`${scope}:${key}`, value);
		this.changeEmitter.fire({ key, scope, target, external: true });
	}
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

function createDebugService(owner: DisposableStore, files: IFileSystemProvider, workspace: IWorkspaceContextService, processes: IDebugAdapterProcessService | undefined, terminals: ITerminalService, storage: IStorageService, tasks: ITaskService, adapters: DebugAdapterFactoryRegistry, contextKeys = owner.add(new ContextKeyService()), quickInput?: IQuickInputService, extensions?: TestExtensionService, editorServices?: { editor: IEditorService; groups?: IEditorGroupsService; configuration?: IConfigurationService; }): DebugService {
	const services = owner.add(new InstantiationService(new ServiceCollection([IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, editorServices?.configuration ?? new SyncDescriptor(WorkbenchConfigurationService)],
		[IFileService, owner.add(createTestFileService(files))],
		[IUriIdentityService, new SyncDescriptor(UriIdentityService)],
		[IWorkspaceContextService, workspace], [IConfigurationResolverService, new SyncDescriptor(ConfigurationResolverService)],
		[IDebugAdapterProcessService, processes],
		[ITerminalProcessService, { getEnvironment: async () => ({ HOME: '/execution/home' }) }], [ITerminalService, terminals],
		[IStorageService, storage],
		[ITaskService, tasks],
		[IDebugAdapterFactorySource, adapters],
		[ILogService, new NullLoggerService()],
		[IContextKeyService, contextKeys],
	)));
	services.registerSingleton(ICommandService, () => new CommandService(services));
	if (extensions) services.registerInstance(IExtensionService, extensions);
	else registerTestExtensionService(owner, services);
	if (quickInput) services.registerInstance(IQuickInputService, quickInput);
	services.registerInstance(IEditorService, editorServices?.editor ?? { ...emptyEditorServiceState, openEditor: async () => { }, focusActiveEditor() { } });
	services.registerInstance(IEditorGroupsService, editorServices?.groups ?? {} as IEditorGroupsService);
	return services.createInstance(DebugService);
}

test('DebugService rejects missing process registration and reports an explicitly unavailable host before launch', async () => {
	using resources = new DisposableStore();
	const root = URI.file('/workspace');
	const files = new FakeFileService(root);
	const workspace = workspaceService(root);
	using tasks = new FakeTaskService();
	using adapters = new DebugAdapterFactoryRegistry();
	using missing = new InstantiationService(new ServiceCollection([IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], [IFileService, resources.add(createTestFileService(files))], [IWorkspaceContextService, workspace]));
	assert.throws(() => missing.createInstance(DebugService), /Unknown service: debugAdapterProcessService/);
	using service = createDebugService(resources, files, workspace, undefined, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	await assert.rejects(service.startDebugging({ id: 'unavailable', name: 'Unavailable', type: 'example', request: 'launch', adapter: { program: 'adapter', arguments: [] }, arguments: {} }), /This host does not provide the Code debug adapter capability/);
	assert.deepEqual(tasks.ran, []);
});

test('DebugService waits for editor save participants before providers, tasks and adapter creation', async () => {
	using resources = new DisposableStore();
	const root = URI.file('/workspace');
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	const entered = new DeferredPromise<void>();
	const saved = new DeferredPromise<void>();
	const phases: string[] = [];
	const editors: IEditorService = {
		...emptyEditorServiceState, openEditor: async () => { }, focusActiveEditor() { },
		saveAll: async () => { phases.push('save'); void entered.complete(undefined); await saved.p; return { success: true, editors: [] }; },
	};
	using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters, undefined, undefined, undefined, { editor: editors });
	resources.add(service.registerDebugConfigurationProviders([{
		id: 'save-provider', type: 'example', triggerKind: DebugConfigurationProviderTriggerKind.Initial,
		resolveDebugConfiguration: async (_folder, value) => { phases.push('provider'); return value; },
	}]));
	const launch = service.startDebugging({ id: 'saved', name: 'Saved', type: 'example', request: 'launch', adapter: { program: 'adapter', arguments: [] }, arguments: {}, preLaunchTask: 'build' });
	await entered.p;
	assert.deepEqual({ phases, tasks: tasks.ran, adapters: processes.started }, { phases: ['save'], tasks: [], adapters: [] });
	void saved.complete(undefined);
	const session = await launch;
	assert.deepEqual({ phases, tasks: tasks.ran, adapters: processes.started.length }, { phases: ['save', 'provider'], tasks: ['build'], adapters: 1 });
	await service.stop(session);
});

test('DebugService prevents launch after failed, cancelled or retired editor saves', async () => {
	for (const outcome of ['cancelled', 'failed', 'workspaceChanged'] as const) {
		using resources = new DisposableStore();
		const root = URI.file('/workspace');
		using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
		using tasks = new FakeTaskService();
		using processes = new FakeDebugAdapterProcessService();
		using adapters = new DebugAdapterFactoryRegistry();
		const editors: IEditorService = {
			...emptyEditorServiceState, openEditor: async () => { }, focusActiveEditor() { }, saveAll: async () => {
				if (outcome === 'failed') { throw new Error('Save failed'); }
				if (outcome === 'workspaceChanged') { workspace.updateWorkspace({ id: 'other', uri: URI.file('/other') }); }
				return { success: outcome !== 'cancelled', editors: [] };
			}
		};
		using service = createDebugService(resources, new FakeFileService(root), workspace, processes, {} as ITerminalService, new TestStorageService(), tasks, adapters, undefined, undefined, undefined, { editor: editors });
		await assert.rejects(service.startDebugging({ id: outcome, name: outcome, type: 'example', request: 'launch', adapter: { program: 'adapter', arguments: [] }, arguments: {}, preLaunchTask: 'build' }), outcome === 'failed' ? /Save failed/ : isCancellationError);
		assert.deepEqual({ tasks: tasks.ran, adapters: processes.started }, { tasks: [], adapters: [] });
	}
});

test('DebugService saveBeforeStart policies select files and active untitled Save As and cancellation prevents launch', async () => {
	for (const policy of ['none', 'nonUntitledEditorsInActiveGroup', 'allEditorsInActiveGroup', 'cancelUntitled']) {
		using resources = new DisposableStore();
		const root = URI.file('/workspace');
		using tasks = new FakeTaskService();
		using processes = new FakeDebugAdapterProcessService();
		using adapters = new DebugAdapterFactoryRegistry();
		const registry = new ConfigurationRegistry();
		registry.registerConfiguration({ key: 'debug.saveBeforeStart', defaultValue: policy === 'cancelUntitled' ? 'allEditorsInActiveGroup' : policy, scope: ConfigurationScope.LANGUAGE_OVERRIDABLE, parse: value => String(value) });
		const configuration = resources.add(new WorkbenchConfigurationService({ registry }));
		const calls: unknown[] = [];
		const activeEditor = { resource: URI.parse('untitled:/Draft') };
		const editors: IEditorService = {
			...emptyEditorServiceState, activeEditor, openEditor: async () => { }, focusActiveEditor() { },
			saveAll: async () => { calls.push('files'); return { success: true, editors: [] }; },
			save: async editor => { calls.push(editor); return { success: policy !== 'cancelUntitled', editors: [] }; },
		};
		using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters, undefined, undefined, undefined, { editor: editors, configuration, groups: { activeGroup: { id: 'active-group' } } as IEditorGroupsService });
		const launch = service.startDebugging({ id: policy, name: policy, type: 'example', request: 'launch', adapter: { program: 'adapter', arguments: [] }, arguments: {} });
		if (policy === 'cancelUntitled') { await assert.rejects(launch, isCancellationError); assert.equal(processes.started.length, 0); }
		else { await service.stop(await launch); }
		assert.deepEqual(calls, policy === 'none' ? [] : policy === 'nonUntitledEditorsInActiveGroup' ? ['files'] : ['files', { editor: activeEditor, groupId: 'active-group' }]);
	}
});

test('DebugService suppressSaveBeforeStart bypasses saves and parent sessions do not repeat them', async () => {
	using resources = new DisposableStore();
	const root = URI.file('/workspace');
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	let saves = 0;
	const editors: IEditorService = { ...emptyEditorServiceState, openEditor: async () => { }, focusActiveEditor() { }, saveAll: async () => { saves++; return { success: true, editors: [] }; } };
	using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters, undefined, undefined, undefined, { editor: editors });
	const configuration = { id: 'parent', name: 'Parent', type: 'example', request: 'launch' as const, adapter: { program: 'adapter', arguments: [] }, arguments: {} };
	const parent = await service.startDebugging(configuration);
	const child = await service.startDebugging({ ...configuration, id: 'child' }, { parentSession: parent });
	const suppressed = await service.startDebugging({ ...configuration, id: 'suppressed' }, { suppressSaveBeforeStart: true });
	assert.equal(saves, 1);
	await service.stop(suppressed);
	await service.stop(child);
	await service.stop(parent);
});

test('DebugService resolves adapter and launch data while retaining the source for restart', async () => {
	using resources = new DisposableStore();
	const root = URI.file('/workspace/project');
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	const configuration = { id: 'resolved', name: 'Resolved', type: 'example', request: 'launch' as const, adapter: { program: '${workspaceFolder}/adapter', arguments: ['${env:HOME}'], cwd: '${workspaceFolder}/src', env: { MODE: '${env:HOME}', LITERAL: '$HOME', TERM_PROGRAM: null } }, arguments: { cwd: '${workspaceFolder}', args: ['${workspaceFolderBasename}', '${workspaceFolder:project}/app', '${env:HOME}', '${env:MISSING}'] } };
	const session = await service.startDebugging(configuration);
	assert.equal(session.configuration, configuration);
	assert.deepEqual(processes.started.at(-1), { program: '/workspace/project/adapter', arguments: ['/execution/home'], cwd: '/workspace/project/src', env: { MODE: '/execution/home', LITERAL: '$HOME', TERM_PROGRAM: null } });
	assert.deepEqual(processes.requests.find(request => request.command === 'launch')?.arguments, { cwd: '/workspace/project', args: ['project', '/workspace/project/app', '/execution/home', ''] });
	const restarted = await service.restart(session);
	assert.equal(restarted.configuration, configuration);
	assert.equal(configuration.arguments.cwd, '${workspaceFolder}');
	await service.stop(restarted);
});

test('DebugService rejects a missing folder before executing preLaunchTask or starting the adapter', async () => {
	using resources = new DisposableStore();
	const root = URI.file('/workspace');
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	await assert.rejects(service.startDebugging({ id: 'invalid', name: 'Invalid', type: 'example', request: 'launch', adapter: { program: '${workspaceFolder:Missing}/adapter', arguments: [] }, arguments: {}, preLaunchTask: 'build' }));
	assert.deepEqual({ tasks: tasks.ran, adapters: processes.started }, { tasks: [], adapters: [] });
});

test('DebugService cancels dispatch when the workspace changes during preLaunchTask', async () => {
	using resources = new DisposableStore();
	const root = URI.file('/workspace');
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	const entered = new DeferredPromise<void>();
	const finish = new DeferredPromise<void>();
	const run = tasks.run.bind(tasks);
	tasks.run = async task => {
		void entered.complete(undefined);
		await finish.p;
		return run(task);
	};
	using service = createDebugService(resources, new FakeFileService(root), workspace, processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	const dispatch = assert.rejects(service.startDebugging({ id: 'changed', name: 'Changed', type: 'example', request: 'launch', adapter: { program: '${workspaceFolder}/adapter', arguments: [] }, arguments: {}, preLaunchTask: 'build' }), isCancellationError);
	await entered.p;
	workspace.updateWorkspace({ id: 'replacement', uri: URI.file('/replacement') });
	void finish.complete(undefined);
	await dispatch;
	assert.deepEqual(processes.started, []);
});

test('DebugService resolves command variables in the executable and task references once per start', async () => {
	using resources = new DisposableStore();
	const root = URI.file('/workspace');
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	let calls = 0;
	using commands = CommandsRegistry.registerMany([
		{ id: 'debug.test.adapter', handler: (_accessor, value) => { assert.equal((value as Record<string, unknown>).type, 'example'); return `/adapter-${++calls}`; } },
		{ id: 'debug.test.before', handler: () => 'build' },
		{ id: 'debug.test.after', handler: () => 'cleanup' },
	]);
	using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	const configuration = { id: 'command', name: 'Command', type: 'example', request: 'launch' as const, adapter: { program: '${command:debug.test.adapter}', arguments: ['${workspaceFolder}'] }, arguments: { program: '${command:debug.test.adapter}', cwd: '${workspaceFolder}' }, preLaunchTask: '${command:debug.test.before}', postDebugTask: '${command:debug.test.after}' };
	const session = await service.startDebugging(configuration);
	assert.equal(session.configuration, configuration);
	assert.deepEqual(processes.started.at(-1), { program: '/adapter-1', arguments: ['/workspace'] });
	assert.deepEqual(processes.requests.find(request => request.command === 'launch')?.arguments, { program: '/adapter-1', cwd: '/workspace' });
	const restarted = await service.restart(session);
	assert.deepEqual(processes.started.at(-1), { program: '/adapter-2', arguments: ['/workspace'] });
	await service.stop(restarted);
	assert.deepEqual(tasks.ran, ['build', 'cleanup', 'build', 'cleanup']);
	assert.equal(configuration.adapter.program, '${command:debug.test.adapter}');
});

test('DebugService uses the selected debugger command aliases once per start and refreshes them on restart', async () => {
	using resources = new DisposableStore();
	const root = URI.file('/workspace');
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	let command = 'debug.test.alias.first';
	let generation = 1;
	let present = true;
	let calls = 0;
	using extensions = new TestExtensionService({
		list: async () => {
			const manifestJson = JSON.stringify({ name: 'aliases', publisher: 'ash', version: '1.0.0', contributes: { debuggers: [{ type: 'mapped', variables: { PickProcess: command } }] } });
			return normalizeExtensionCatalog({ generation, extensions: present ? [{ id: 'ash.aliases', name: 'aliases', publisher: 'ash', version: '1.0.0', displayName: 'Aliases', sourceKind: 'builtIn', manifestJson, manifestSha256: `sha256:${createHash('sha256').update(manifestJson).digest('hex')}`, packageSha256: `sha256:${'b'.repeat(64)}` }] : [], diagnostics: [] });
		},
		resources: new ExtensionResourceLoaderService(async () => { throw new Error('Command mappings do not read package resources'); }),
	});
	await extensions.reload();
	using commands = CommandsRegistry.registerMany([
		{ id: 'debug.test.alias.first', handler: (_accessor, value) => { calls++; assert.deepEqual(Object.keys(value as object).sort(), ['debugAdapter', 'name', 'preLaunchTask', 'program', 'request', 'type']); return '/first'; } },
		{ id: 'debug.test.alias.second', handler: () => { calls++; return '/second'; } },
		{ id: 'debug.test.alias.cancel', handler: () => undefined },
		{ id: 'PickProcess', handler: () => '/unmapped' },
	]);
	using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters, undefined, undefined, extensions);
	const configuration = { id: 'mapped', name: 'Mapped', type: 'mapped', request: 'launch' as const, adapter: { program: '${command:PickProcess}', arguments: [] }, arguments: { program: '${command:PickProcess}' }, preLaunchTask: 'build' };
	const session = await service.startDebugging(configuration);
	assert.deepEqual({ process: processes.started.at(-1), launch: processes.requests.find(request => request.command === 'launch')?.arguments, calls }, { process: { program: '/first', arguments: [] }, launch: { program: '/first' }, calls: 1 });
	command = 'debug.test.alias.second'; generation++;
	await extensions.reload();
	const restarted = await service.restart(session);
	assert.deepEqual({ process: processes.started.at(-1), calls, source: restarted.configuration }, { process: { program: '/second', arguments: [] }, calls: 2, source: configuration });
	await service.stop(restarted);
	command = 'debug.test.alias.cancel'; generation++;
	await extensions.reload();
	const before = { tasks: tasks.ran.length, processes: processes.started.length };
	await assert.rejects(service.startDebugging(configuration), isCancellationError);
	assert.deepEqual({ tasks: tasks.ran.length, processes: processes.started.length }, before);
	const unrelated = await service.startDebugging({ ...configuration, id: 'unrelated', type: 'unrelated' });
	assert.deepEqual(processes.started.at(-1), { program: '/unmapped', arguments: [] });
	await service.stop(unrelated);
	present = false; generation++;
	await extensions.reload();
	const removed = await service.startDebugging(configuration);
	assert.deepEqual(processes.started.at(-1), { program: '/unmapped', arguments: [] });
	await service.stop(removed);
});

test('DebugService cancels before preLaunchTask and adapter launch when command resolution is canceled', async () => {
	using resources = new DisposableStore();
	const root = URI.file('/workspace');
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	using command = CommandsRegistry.register('debug.test.cancel', () => undefined);
	using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	await assert.rejects(service.startDebugging({ id: 'cancel', name: 'Cancel', type: 'example', request: 'launch', adapter: { program: '${command:debug.test.cancel}', arguments: [] }, arguments: {}, preLaunchTask: 'build' }), isCancellationError);
	assert.deepEqual({ tasks: tasks.ran, processes: processes.started, sessions: service.sessions }, { tasks: [], processes: [], sessions: [] });
});

test('DebugService cannot launch into a replacement workspace after a pending command resolves', async () => {
	using resources = new DisposableStore();
	const root = URI.file('/workspace');
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	const entered = new DeferredPromise<void>();
	const finish = new DeferredPromise<string>();
	using command = CommandsRegistry.register('debug.test.pending', () => { void entered.complete(undefined); return finish.p; });
	using service = createDebugService(resources, new FakeFileService(root), workspace, processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	const pending = assert.rejects(service.startDebugging({ id: 'pending', name: 'Pending', type: 'example', request: 'launch', adapter: { program: '${command:debug.test.pending}', arguments: [] }, arguments: {}, preLaunchTask: 'build' }), /workspace changed/);
	await entered.p;
	workspace.updateWorkspace({ id: 'replacement', uri: URI.file('/replacement') });
	void finish.complete('/adapter');
	await pending;
	assert.deepEqual({ tasks: tasks.ran, processes: processes.started, sessions: service.sessions }, { tasks: [], processes: [], sessions: [] });
});

test('DebugService rejects an invalid resolved executable before task or process side effects', async () => {
	using resources = new DisposableStore();
	using localization = toDisposable(resetNlsResolver);
	initializeTestLocalization('zh-CN');
	const root = URI.file('/workspace');
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	using command = CommandsRegistry.register('debug.test.empty', () => '');
	using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	await assert.rejects(service.startDebugging({ id: 'invalid', name: 'Invalid', type: 'example', request: 'launch', adapter: { program: '${command:debug.test.empty}', arguments: [] }, arguments: {}, preLaunchTask: 'build' }), { message: '解析后的调试适配器可执行文件为空，或包含无效的进程参数。' });
	assert.deepEqual({ tasks: tasks.ran, processes: processes.started }, { tasks: [], processes: [] });
});

test('DebugService resolves configured command inputs in adapter and launch data on start and restart, with cancellation before preLaunchTask', async () => {
	using resources = new DisposableStore();
	const root = URI.file('/workspace');
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	const dom = new JSDOM('<!doctype html><body></body>');
	resources.add(toDisposable(() => dom.window.close()));
	const context = resources.add(new ContextKeyService());
	const quickInput = resources.add(new WorkbenchQuickInputService({ container: dom.window.document.body, contextKeyService: context }));
	const input = {
		version: '0.2.0',
		inputs: [{ id: 'adapter', type: 'command', command: 'debug.test.input', args: { mode: 'debug' } }],
		configurations: [{ name: 'Configured', type: 'example', request: 'launch', debugAdapter: { program: '${input:adapter}' }, program: '${input:adapter}', preLaunchTask: 'build' }],
	};
	let calls = 0;
	using command = CommandsRegistry.register('debug.test.input', (_accessor, args) => {
		assert.deepEqual(args, { mode: 'debug' });
		return ++calls === 3 ? undefined : `/adapter-${calls}`;
	});
	using service = createDebugService(resources, new FakeFileService(root, JSON.stringify(input)), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters, context, quickInput);
	const configuration = (await service.refresh())[0]!;
	assert.equal(calls, 0);
	const session = await service.startDebugging(configuration);
	const restarted = await service.restart(session);
	await service.stop(restarted);
	assert.deepEqual(processes.started, [{ dirId: 'workspace', program: '/adapter-1', arguments: [] }, { dirId: 'workspace', program: '/adapter-2', arguments: [] }]);
	assert.deepEqual(processes.requests.filter(request => request.command === 'launch').map(request => request.arguments), [{ program: '/adapter-1' }, { program: '/adapter-2' }]);
	await assert.rejects(service.startDebugging(configuration), isCancellationError);
	assert.deepEqual(tasks.ran, ['build', 'build']);
	assert.equal(processes.started.length, 2);
	assert.equal(configuration.adapter?.program, '${input:adapter}');
});


test('DebugService validates all compound references before running its pre-launch task', async () => {
	using resources = new DisposableStore();
	const root = URI.file('/workspace');
	const document = JSON.stringify({ version: '0.2.0', configurations: [], compounds: [{ name: 'Missing', configurations: [{ name: 'Launch', folder: 'Missing' }], preLaunchTask: 'prepare' }] });
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	using service = createDebugService(resources, new FakeFileService(root, document), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	await service.refresh();
	await assert.rejects(service.startCompound(service.compounds[0]!), /was not found/);
	assert.deepEqual({ tasks: tasks.ran, adapters: processes.started }, { tasks: [], adapters: [] });
});


test('DebugService resolves Host-broker adapter descriptors only at dispatch and reevaluates restart', async () => {
	const root = URI.file('/workspace');
	using resources = new DisposableStore();
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
	const calls: unknown[] = [];
	using registration = adapters.registerFactories([createExtensionHostDebugAdapterFactory('hosted', 'extension:hosted', async (operation, payload, signal) => {
		assert.equal(signal.aborted, false);
		assert.deepEqual(tasks.ran, Array(calls.length + 1).fill('build'));
		calls.push({ operation, payload: JSON.parse(JSON.stringify(payload)) });
		return { program: `/adapter-${calls.length}`, arguments: ['', ' literal '] };
	}, workspace)]);
	const document = JSON.stringify({ version: '0.2.0', configurations: [{ name: 'Hosted', type: 'hosted', request: 'launch', program: '${workspaceFolder}/app', preLaunchTask: 'build' }] });
	using service = createDebugService(resources, new FakeFileService(root, document), workspace, processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	await service.refresh();
	assert.deepEqual(calls, []);
	const session = await service.start(service.configurations[0]!);
	const restarted = await service.restart(session);
	await service.stop(restarted);
	assert.deepEqual(calls, [session.id, restarted.id].map(id => ({ operation: 'createDebugAdapterDescriptor', payload: { configuration: { program: '/workspace/app', name: 'Hosted', type: 'hosted', request: 'launch' }, session: { id, workspaceFolder: { uri: root.toString(), name: 'workspace', index: 0 } }, dirId: 'workspace' } })));
	assert.deepEqual(processes.started, [1, 2].map(index => ({ program: `/adapter-${index}`, arguments: ['', ' literal '], dirId: 'workspace' })));
	assert.equal(service.configurations[0]?.adapter, undefined);
});

for (const result of ['succeeded', 'failed'] as const) {
	test(`DebugService waits for a ${result} pre-launch build before invoking the descriptor factory`, async () => {
		using resources = new DisposableStore();
		using tasks = new FakeTaskService();
		using processes = new FakeDebugAdapterProcessService();
		using adapters = new DebugAdapterFactoryRegistry();
		using buildStatus = new Emitter<TaskRunStatus>();
		const entered = new DeferredPromise<void>();
		let buildResult: TaskRunStatus = 'running';
		tasks.run = async task => {
			tasks.ran.push(task.label);
			void entered.complete(undefined);
			return { task, terminalId: 'build', get status() { return buildResult; }, get exitCode() { return buildResult === 'succeeded' ? 0 : buildResult === 'failed' ? 1 : undefined; }, onDidChangeStatus: buildStatus.event };
		};
		let descriptors = 0;
		using registration = adapters.registerFactories([{ type: 'hosted', label: 'Hosted', sourceId: 'host', createDebugAdapterDescriptor: async () => { descriptors++; assert.equal(buildResult, 'succeeded'); return { program: 'compiled-adapter', arguments: [] }; } }]);
		const root = URI.file('/workspace');
		using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
		const pending = service.startDebugging({ id: 'build', name: 'Build', type: 'hosted', request: 'launch', arguments: {}, preLaunchTask: 'build' });
		const failure = result === 'failed' ? assert.rejects(pending, /preLaunchTask 'build' failed/) : undefined;
		await entered.p;
		assert.deepEqual({ descriptors, processes: processes.started }, { descriptors: 0, processes: [] });
		buildResult = result;
		buildStatus.fire(result);
		if (failure) {
			await failure;
			assert.deepEqual({ descriptors, processes: processes.started }, { descriptors: 0, processes: [] });
		} else {
			const session = await pending;
			assert.equal(descriptors, 1);
			await service.stop(session);
		}
	});
}

for (const change of ['workspace', 'factory', 'dispose'] as const) {
	test(`DebugService cancels a pending descriptor on ${change} without starting its adapter process`, async () => {
		const root = URI.file('/workspace');
		using resources = new DisposableStore();
		using tasks = new FakeTaskService();
		using processes = new FakeDebugAdapterProcessService();
		using adapters = new DebugAdapterFactoryRegistry();
		const entered = new DeferredPromise<AbortSignal>();
		const result = new DeferredPromise<{ program: string; arguments: string[]; }>();
		using registration = adapters.registerFactories([{ type: 'hosted', label: 'Hosted', sourceId: 'extension:hosted', createDebugAdapterDescriptor: async (_configuration, signal) => { void entered.complete(signal); return result.p; } }]);
		using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
		using service = createDebugService(resources, new FakeFileService(root), workspace, processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
		const pending = assert.rejects(service.startDebugging({ id: 'pending', name: 'Pending', type: 'hosted', request: 'launch', arguments: {}, preLaunchTask: 'build' }), isCancellationError);
		const signal = await entered.p;
		if (change === 'workspace') workspace.updateWorkspace({ id: 'replacement', uri: URI.file('/replacement') });
		else if (change === 'factory') registration.dispose();
		else service.dispose();
		await pending;
		assert.equal(signal.aborted, true);
		void result.complete({ program: 'late-adapter', arguments: [] });
		await Promise.resolve();
		assert.deepEqual({ tasks: tasks.ran, adapters: processes.started }, { tasks: ['build'], adapters: [] });
	});
}

test('unrelated provider retirement preserves a pending Debug configuration resolver', async () => {
	using resources = new DisposableStore();
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	const root = URI.file('/workspace');
	using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	const entered = new DeferredPromise<AbortSignal>();
	const finish = new DeferredPromise<void>();
	using provider = service.registerDebugConfigurationProviders([{ id: 'selected', type: 'example', triggerKind: DebugConfigurationProviderTriggerKind.Initial, resolveDebugConfiguration: async (_folder, config, signal) => { void entered.complete(signal); await finish.p; return config; } }]);
	using unrelated = service.registerDebugConfigurationProviders([{ id: 'unrelated', type: 'other', triggerKind: DebugConfigurationProviderTriggerKind.Initial, provideDebugConfigurations: () => [] }]);
	await service.refresh();
	const pending = service.start(service.configurations[0]!);
	const signal = await entered.p;
	unrelated.dispose();
	assert.equal(signal.aborted, false);
	await finish.complete();
	const session = await pending;
	assert.equal(processes.started.length, 1);
	await service.stop(session);
});

test('unrelated provider retirement preserves pending Debug configuration discovery', async () => {
	using resources = new DisposableStore();
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	const root = URI.file('/workspace');
	using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	const entered = new DeferredPromise<AbortSignal>();
	const finish = new DeferredPromise<readonly DebugConfiguration[]>();
	using provider = service.registerDebugConfigurationProviders([{ id: 'selected', type: 'example', triggerKind: DebugConfigurationProviderTriggerKind.Dynamic, provideDebugConfigurations: async (_folder, signal) => { void entered.complete(signal); return finish.p; } }]);
	using unrelated = service.registerDebugConfigurationProviders([{ id: 'unrelated', type: 'other', triggerKind: DebugConfigurationProviderTriggerKind.Initial, provideDebugConfigurations: () => [] }]);
	const pending = service.provideDebugConfigurations(root, undefined, DebugConfigurationProviderTriggerKind.Dynamic);
	const signal = await entered.p;
	unrelated.dispose();
	assert.equal(signal.aborted, false);
	const configurations = [{ name: 'Retained', type: 'example', request: 'launch' as const }];
	await finish.complete(configurations);
	assert.deepEqual(await pending, configurations);
});

test('unrelated factory retirement preserves a pending Debug adapter descriptor', async () => {
	using resources = new DisposableStore();
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	const entered = new DeferredPromise<AbortSignal>();
	const finish = new DeferredPromise<{ program: string; arguments: string[]; }>();
	using factory = adapters.registerFactories([{ type: 'selected', label: 'Selected', sourceId: 'selected', createDebugAdapterDescriptor: async (_config, signal) => { void entered.complete(signal); return finish.p; } }]);
	using unrelated = adapters.registerFactories([createStaticDebugAdapterFactory('other', 'Other', 'other', { program: 'other-adapter', arguments: [] })]);
	const root = URI.file('/workspace');
	using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	const pending = service.startDebugging({ id: 'selected', name: 'Selected', type: 'selected', request: 'launch', arguments: {} });
	const signal = await entered.p;
	unrelated.dispose();
	assert.equal(signal.aborted, false);
	await finish.complete({ program: 'selected-adapter', arguments: [] });
	const session = await pending;
	assert.equal(processes.started.length, 1);
	assert.equal((processes.started[0] as { program: string; }).program, 'selected-adapter');
	await service.stop(session);
});

test('factory retirement during Debug session preparation prevents descriptor invocation', async () => {
	using resources = new DisposableStore();
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	let calls = 0;
	using factory = adapters.registerFactories([{ type: 'selected', label: 'Selected', sourceId: 'selected', createDebugAdapterDescriptor: async () => { calls++; return { program: 'selected-adapter', arguments: [] }; } }]);
	const root = URI.file('/workspace');
	using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	using listener = service.onWillNewSession(() => factory.dispose());
	await assert.rejects(service.startDebugging({ id: 'selected', name: 'Selected', type: 'selected', request: 'launch', arguments: {} }), isCancellationError);
	assert.equal(calls, 0);
	assert.deepEqual(processes.started, []);
});

test('DebugService keeps a pending launch alive across an unchanged discovery refresh', async () => {
	const root = URI.file('/workspace');
	using resources = new DisposableStore();
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	const entered = new DeferredPromise<AbortSignal>();
	const result = new DeferredPromise<{ program: string; arguments: string[]; }>();
	using registration = adapters.registerFactories([{ type: 'hosted', label: 'Hosted', sourceId: 'extension:hosted', createDebugAdapterDescriptor: async (_configuration, signal) => { void entered.complete(signal); return result.p; } }]);
	using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	const pending = service.startDebugging({ id: 'pending', name: 'Pending', type: 'hosted', request: 'launch', arguments: {} });
	const signal = await entered.p;
	await service.refresh();
	assert.equal(signal.aborted, false);
	void result.complete({ program: 'adapter', arguments: [] });
	const session = await pending;
	assert.deepEqual(processes.started, [{ program: 'adapter', arguments: [] }]);
	await service.stop(session);
});


test('DebugService closes a late initialized adapter instead of publishing it into a replacement workspace', async () => {
	const root = URI.file('/workspace');
	using resources = new DisposableStore();
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
	const entered = new DeferredPromise<void>();
	const release = new DeferredPromise<void>();
	const closed: string[] = [];
	const close = processes.close.bind(processes);
	processes.close = async id => { closed.push(id); await close(id); };
	const start = processes.start.bind(processes);
	processes.start = async options => { void entered.complete(undefined); await release.p; return start(options); };
	using service = createDebugService(resources, new FakeFileService(root), workspace, processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	let published = 0;
	using listener = service.onDidChangeSession(session => { if (session) published++; });
	const pending = assert.rejects(service.startDebugging({ id: 'pending', name: 'Pending', type: 'example', request: 'launch', adapter: { program: 'adapter', arguments: [] }, arguments: {} }), isCancellationError);
	await entered.p;
	workspace.updateWorkspace({ id: 'replacement', uri: URI.file('/replacement') });
	void release.complete(undefined);
	await pending;
	assert.deepEqual({ published, sessions: service.sessions, closed }, { published: 0, sessions: [], closed: ['debug-1'] });
});


suite('Debug service release', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('disposing the service releases every adapter once and clears session ownership', async () => {
		using resources = new DisposableStore();
		using tasks = new FakeTaskService();
		using processes = new FakeDebugAdapterProcessService();
		using adapters = new DebugAdapterFactoryRegistry();
		using storage = new TestStorageService();
		const closed: string[] = [];
		const close = processes.close.bind(processes);
		processes.close = async id => { closed.push(id); await close(id); };
		const root = URI.file('/workspace');
		using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, storage, tasks, adapters);
		await service.refresh();
		const sessions = await service.startCompound(service.compounds[0]!);
		service.dispose();
		await Promise.resolve();
		assert.deepEqual({ closed, sessions: service.sessions, tasks: tasks.ran }, { closed: sessions.map((_session, index) => `debug-${index + 1}`), sessions: [], tasks: ['prepare', 'build'] });
	});
});


test('Debug configuration providers run around variable substitution and preserve the source for restart', async () => {
	using resources = new DisposableStore();
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	const root = URI.file('/workspace');
	using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	const order: string[] = [];
	using providers = service.registerDebugConfigurationProviders([
		{
			id: 'wildcard', type: '*', triggerKind: DebugConfigurationProviderTriggerKind.Initial,
			resolveDebugConfiguration: async (_folder, config) => { order.push('wildcard-before'); assert.equal(config.program, '${workspaceFolder}/provided'); return config; },
			resolveDebugConfigurationWithSubstitutedVariables: async (_folder, config) => { order.push('wildcard-after'); return config; },
		},
		{
			id: 'specific', type: 'example', triggerKind: DebugConfigurationProviderTriggerKind.Dynamic,
			resolveDebugConfiguration: async (folder, config, signal) => {
				assert.equal(folder?.toString(), root.toString());
				assert.equal(signal.aborted, false);
				order.push('specific-before');
				return { ...config, program: '${workspaceFolder}/provided' };
			},
			resolveDebugConfigurationWithSubstitutedVariables: async (_folder, config) => {
				assert.equal(config.program, '/workspace/provided');
				order.push('specific-after');
				return { ...config, preLaunchTask: 'build', injected: true };
			},
		},
	]);
	await service.refresh();
	const source = service.configurations[1]!;
	const session = await service.start(source);
	const restarted = await service.restart(session);
	await service.stop(restarted);
	assert.deepEqual(order, Array(2).fill(['specific-before', 'wildcard-before', 'specific-after', 'wildcard-after']).flat());
	assert.deepEqual(tasks.ran, ['build', 'build']);
	assert.deepEqual(processes.requests.filter(request => request.command === 'launch').map(request => request.arguments), Array(2).fill({ program: '/workspace/provided', injected: true }));
	assert.equal(source.arguments.program, undefined);
	assert.equal(source.preLaunchTask, undefined);
});

test('Debug configuration templates exclude Dynamic providers and validate results before writing a document', async () => {
	using resources = new DisposableStore();
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	const root = URI.file('/workspace');
	using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	const template = { name: 'Generated', type: 'example', request: 'launch' as const, debugAdapter: { program: 'adapter' }, program: '${workspaceFolder}/app' };
	using providers = service.registerDebugConfigurationProviders([
		{ id: 'initial', type: 'example', triggerKind: DebugConfigurationProviderTriggerKind.Initial, provideDebugConfigurations: async () => [template] },
		{ id: 'dynamic', type: 'example', triggerKind: DebugConfigurationProviderTriggerKind.Dynamic, provideDebugConfigurations: async () => assert.fail('Dynamic templates require explicit discovery') },
	]);
	const generated = await service.provideDebugConfigurations(root);
	assert.deepEqual(generated, [template]);
	template.program = 'changed';
	assert.equal(generated[0]!.program, '${workspaceFolder}/app');
	providers.replace([{ id: 'invalid', type: 'example', triggerKind: DebugConfigurationProviderTriggerKind.Initial, provideDebugConfigurations: async () => [{ name: 'Invalid', type: 'example', request: 'launch', debugAdapter: { program: 42 } }] }]);
	await assert.rejects(service.provideDebugConfigurations(root), /program/);
	await assert.rejects(service.provideDebugConfigurations(URI.file('/other')), isCancellationError);
	assert.deepEqual(processes.started, []);
});

for (const cancellation of ['undefined result', 'provider retirement', 'workspace replacement'] as const) {
	test(`Debug configuration resolution cancels on ${cancellation} before tasks or adapter startup`, async () => {
		using resources = new DisposableStore();
		using tasks = new FakeTaskService();
		using processes = new FakeDebugAdapterProcessService();
		using adapters = new DebugAdapterFactoryRegistry();
		const root = URI.file('/workspace');
		using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
		using service = createDebugService(resources, new FakeFileService(root), workspace, processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
		const entered = new DeferredPromise<AbortSignal>();
		const finish = new DeferredPromise<null | undefined>();
		using providers = service.registerDebugConfigurationProviders([{ id: 'pending', type: 'example', triggerKind: DebugConfigurationProviderTriggerKind.Initial, resolveDebugConfiguration: async (_folder, _config, signal) => { void entered.complete(signal); return finish.p; } }]);
		await service.refresh();
		const pending = assert.rejects(service.start(service.configurations[0]!), isCancellationError);
		const signal = await entered.p;
		if (cancellation === 'provider retirement') providers.dispose();
		if (cancellation === 'workspace replacement') workspace.updateWorkspace({ id: 'other', uri: URI.file('/other') });
		if (cancellation !== 'undefined result') assert.equal(signal.aborted, true);
		await finish.complete(undefined);
		await pending;
		assert.deepEqual({ tasks: tasks.ran, adapters: processes.started }, { tasks: [], adapters: [] });
	});
}


test('Debug configuration type redirection visits the new provider and bounds cycles before DAP launch', async () => {
	using resources = new DisposableStore();
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	const root = URI.file('/workspace');
	using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	const calls: string[] = [];
	using providers = service.registerDebugConfigurationProviders([
		{ id: 'example', type: 'example', triggerKind: DebugConfigurationProviderTriggerKind.Initial, resolveDebugConfiguration: async (_folder, config) => { calls.push('example'); return { ...config, type: 'redirected' }; } },
		{ id: 'redirected', type: 'redirected', triggerKind: DebugConfigurationProviderTriggerKind.Initial, resolveDebugConfiguration: async (_folder, config) => { calls.push('redirected'); return { ...config, type: 'example', program: '${workspaceFolder}/redirected' }; } },
	]);
	await service.refresh();
	const session = await service.start(service.configurations[1]!);
	assert.deepEqual(calls, ['example', 'redirected']);
	assert.deepEqual(processes.requests.find(request => request.command === 'launch')?.arguments, { program: '/workspace/redirected' });
	await service.stop(session);
});

test('Debug configuration template cancellation never enters an already canceled callback', async () => {
	using resources = new DisposableStore();
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	const root = URI.file('/workspace');
	using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	using providers = service.registerDebugConfigurationProviders([{ id: 'initial', type: 'example', triggerKind: DebugConfigurationProviderTriggerKind.Initial, provideDebugConfigurations: () => assert.fail('Canceled discovery must not enter extension code') }]);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(service.provideDebugConfigurations(root, controller.signal), isCancellationError);
});


test('Debug configuration redirection selects the contributed adapter without exposing defaults to extensions', async () => {
	using resources = new DisposableStore();
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	using factories = adapters.registerFactories([
		createStaticDebugAdapterFactory('example', 'Old', 'old', { program: 'old-adapter', arguments: [] }),
		createStaticDebugAdapterFactory('redirected', 'New', 'new', { program: '${env:HOME}/adapter', arguments: ['${workspaceFolder}'] }),
	]);
	const root = URI.file('/workspace');
	const document = JSON.stringify({ version: '0.2.0', configurations: [{ name: 'Redirect', type: 'example', request: 'launch' }] });
	using service = createDebugService(resources, new FakeFileService(root, document), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	using providers = service.registerDebugConfigurationProviders([
		{ id: 'before', type: 'example', triggerKind: DebugConfigurationProviderTriggerKind.Initial, resolveDebugConfiguration: async (_folder, config) => { assert.equal(config.debugAdapter, undefined); return { ...config, type: 'redirected' }; } },
		{ id: 'after', type: 'redirected', triggerKind: DebugConfigurationProviderTriggerKind.Initial, resolveDebugConfigurationWithSubstitutedVariables: async (_folder, config) => { assert.equal(config.debugAdapter, undefined); return config; } },
	]);
	await service.refresh();
	const session = await service.start(service.configurations[0]!);
	assert.deepEqual(processes.started, [{ program: '/execution/home/adapter', arguments: ['/workspace'], dirId: 'workspace' }]);
	await service.stop(session);
});

test('Debug templates can obtain their adapter from a configuration resolver at dispatch', async () => {
	using resources = new DisposableStore();
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	const root = URI.file('/workspace');
	const document = JSON.stringify({ version: '0.2.0', configurations: [{ name: 'Provided', type: 'provided', request: 'launch' }] });
	using service = createDebugService(resources, new FakeFileService(root, document), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	let calls = 0;
	using providers = service.registerDebugConfigurationProviders([{
		id: 'provided', type: 'provided', triggerKind: DebugConfigurationProviderTriggerKind.Initial,
		provideDebugConfigurations: async () => [{ name: 'Provided', type: 'provided', request: 'launch' }],
		resolveDebugConfiguration: async (_folder, config) => { calls++; return { ...config, debugAdapter: { program: 'provided-adapter' } }; },
	}]);
	assert.equal((await service.provideDebugConfigurations(root)).length, 1);
	await service.refresh();
	assert.equal(calls, 0, 'discovery never invokes resolution');
	const session = await service.start(service.configurations[0]!);
	assert.equal(calls, 1);
	assert.deepEqual(processes.started, [{ program: 'provided-adapter', arguments: [], dirId: 'workspace' }]);
	await service.stop(session);
});

for (const selection of ['accept', 'escape', 'workspace replacement'] as const) {
	test(`Select and Start Debugging uses Dynamic providers and handles ${selection} without saving a configuration`, async () => {
		using resources = new DisposableStore();
		using localization = toDisposable(resetNlsResolver);
		initializeTestLocalization('zh-CN');
		const root = URI.file('/workspace');
		using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
		using tasks = new FakeTaskService();
		using processes = new FakeDebugAdapterProcessService();
		using adapters = new DebugAdapterFactoryRegistry();
		const dom = new JSDOM('<!doctype html><body></body>');
		resources.add(toDisposable(() => dom.window.close()));
		const context = resources.add(new ContextKeyService());
		const quickInput = resources.add(new WorkbenchQuickInputService({ container: dom.window.document.body, contextKeyService: context }));
		const files = new FakeFileService(root);
		using service = createDebugService(resources, files, workspace, processes, {} as ITerminalService, new TestStorageService(), tasks, adapters, context, quickInput);
		const entered = new DeferredPromise<AbortSignal>();
		const finish = new DeferredPromise<readonly { name: string; type: string; request: 'launch'; debugAdapter: { program: string; }; program: string; }[]>();
		const configuration = { name: 'Dynamic launch', type: 'example', request: 'launch' as const, debugAdapter: { program: 'dynamic-adapter' }, program: '${workspaceFolder}/app' };
		using providers = service.registerDebugConfigurationProviders([
			{ id: 'initial', type: 'example', triggerKind: DebugConfigurationProviderTriggerKind.Initial, provideDebugConfigurations: () => assert.fail('Selection must not query Initial providers') },
			{ id: 'dynamic', type: 'example', triggerKind: DebugConfigurationProviderTriggerKind.Dynamic, provideDebugConfigurations: (folder, signal) => { assert.equal(folder?.toString(), root.toString()); void entered.complete(signal); return finish.p; } },
		]);
		const actionServices = resources.add(new InstantiationService(new ServiceCollection([IPathService, new SyncDescriptor(BrowserPathService)], [IRendererHostService, createDisconnectedRendererApi()], [IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)], [IDebugService, service], [IWorkspaceContextService, workspace], [IQuickInputService, quickInput])));
		const commands = new CommandService(actionServices);
		const pending = commands.executeCommand(SELECT_AND_START_ID);
		const signal = await entered.p;
		const input = dom.window.document.querySelector<HTMLInputElement>('.ash-quick-pick input')!;
		assert.ok(input);
		assert.equal(input.getAttribute('aria-label'), '选择调试配置');
		if (selection === 'accept') {
			await finish.complete([configuration]);
			await new Promise<void>(resolve => {
				const observer = new dom.window.MutationObserver(() => { if (dom.window.document.body.textContent?.includes('Dynamic launch')) { observer.disconnect(); resolve(); } });
				resources.add(toDisposable(() => observer.disconnect()));
				if (dom.window.document.body.textContent?.includes('Dynamic launch')) resolve();
				else observer.observe(dom.window.document.body, { subtree: true, childList: true });
			});
			input.value = 'Dynamic launch';
			input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
			input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		} else if (selection === 'escape') {
			input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		} else workspace.updateWorkspace({ id: 'replacement', uri: URI.file('/replacement') });
		await pending;
		assert.equal(signal.aborted, selection !== 'accept');
		assert.equal(quickInput.currentQuickInput, undefined);
		assert.deepEqual(service.configurations.map(config => config.name), selection === 'workspace replacement' ? [] : ['One', 'Two']);
		if (selection === 'accept') {
			assert.deepEqual(processes.started, [{ program: 'dynamic-adapter', arguments: [], dirId: 'workspace' }]);
			assert.deepEqual(processes.requests.find(request => request.command === 'launch')?.arguments, { program: '/workspace/app' });
			await service.stop();
		} else {
			await finish.complete([configuration]);
			assert.deepEqual({ tasks: tasks.ran, processes: processes.started, sessions: service.sessions }, { tasks: [], processes: [], sessions: [] });
		}
	});
}

test('debug discovery and launch wait for the requested dormant provider before taking an execution lifetime', async () => {
	using resources = new DisposableStore();
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	using extensions = new TestExtensionService();
	const root = URI.file('/workspace');
	using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters, undefined, undefined, extensions);
	const events: string[] = [];
	const registered = new Set<string>();
	using activation = extensions.registerActivationHandler(async event => {
		events.push(event);
		if (registered.has(event)) return;
		registered.add(event);
		if (event === 'onDebugInitialConfigurations' || event === 'onDebugDynamicConfigurations') {
			resources.add(service.registerDebugConfigurationProviders([{
				id: event, type: 'example', triggerKind: event === 'onDebugInitialConfigurations' ? 1 : 2,
				provideDebugConfigurations: () => [{ name: event, type: 'example', request: 'launch', debugAdapter: { program: 'adapter' } }],
			}]));
		} else if (event === 'onDebugResolve:example') {
			resources.add(service.registerDebugConfigurationProviders([{
				id: event, type: 'example', triggerKind: 1,
				resolveDebugConfiguration: (_folder, configuration, signal) => {
					assert.equal(signal.aborted, false);
					return { ...configuration, activatedResolver: true };
				},
			}]));
		}
	});
	assert.equal((await service.provideDebugConfigurations(root))[0]!.name, 'onDebugInitialConfigurations');
	assert.equal((await service.provideDebugConfigurations(root, undefined, DebugConfigurationProviderTriggerKind.Dynamic))[0]!.name, 'onDebugDynamicConfigurations');
	const session = await service.startDebugging({ id: 'lazy', name: 'Lazy', type: 'example', request: 'launch', adapter: { program: 'adapter', arguments: [] }, arguments: {} });
	await service.stop(session);
	assert.deepEqual(events, ['onDebug', 'onDebugInitialConfigurations', 'onDebug', 'onDebugDynamicConfigurations', 'onDebug', 'onDebugResolve:example']);
	assert.deepEqual(processes.requests.find(request => request.command === 'launch')!.arguments, { activatedResolver: true });
});

test('Debug configuration redirection activates its dormant provider and retains existing owners through adapter launch', async () => {
	using resources = new DisposableStore();
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	using extensions = new TestExtensionService();
	const root = URI.file('/workspace');
	using service = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters, undefined, undefined, extensions);
	const originalFactory = createStaticDebugAdapterFactory('example', 'Original', 'original', { program: 'original-adapter', arguments: [] });
	using factories = adapters.registerFactories([originalFactory]);
	const originalProvider = {
		id: 'original', type: 'example', triggerKind: DebugConfigurationProviderTriggerKind.Initial,
		resolveDebugConfiguration: (_folder: URI | undefined, configuration: DebugConfiguration) => ({ ...configuration, type: 'redirected' }),
	};
	using providers = service.registerDebugConfigurationProviders([originalProvider]);
	const events: string[] = [];
	using activation = extensions.registerActivationHandler(async event => {
		events.push(event);
		if (event !== 'onDebugResolve:redirected') return;
		factories.replace([originalFactory, createStaticDebugAdapterFactory('redirected', 'Redirected', 'redirected', { program: 'redirected-adapter', arguments: [] })]);
		providers.replace([originalProvider, {
			id: 'redirected', type: 'redirected', triggerKind: DebugConfigurationProviderTriggerKind.Initial,
			resolveDebugConfiguration: (_folder, configuration, signal) => {
				assert.equal(signal.aborted, false);
				return { ...configuration, activatedTarget: '${workspaceFolder}/target' };
			},
		}]);
	});
	const session = await service.startDebugging({ id: 'redirect', dirId: 'workspace', name: 'Redirect', type: 'example', request: 'launch', adapterExplicit: false, arguments: {} });
	assert.deepEqual(events, ['onDebug', 'onDebugResolve:example', 'onDebugResolve:redirected']);
	assert.deepEqual(processes.started, [{ program: 'redirected-adapter', arguments: [], dirId: 'workspace' }]);
	assert.deepEqual(processes.requests.find(request => request.command === 'launch')?.arguments, { activatedTarget: '/workspace/target' });
	await service.stop(session);
});

test('workspace retirement during debug extension activation prevents provider invocation and adapter spawn', async () => {
	using resources = new DisposableStore();
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	using extensions = new TestExtensionService();
	const root = URI.file('/workspace');
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
	using service = createDebugService(resources, new FakeFileService(root), workspace, processes, {} as ITerminalService, new TestStorageService(), tasks, adapters, undefined, undefined, extensions);
	const entered = new DeferredPromise<void>();
	const release = new DeferredPromise<void>();
	using activation = extensions.registerActivationHandler(async () => { void entered.complete(undefined); await release.p; });
	const launch = assert.rejects(service.startDebugging({ id: 'lazy', name: 'Lazy', type: 'example', request: 'launch', adapter: { program: 'adapter', arguments: [] }, arguments: {} }), isCancellationError);
	await entered.p;
	workspace.updateWorkspace({ id: 'next', uri: URI.file('/next') });
	void release.complete(undefined);
	await launch;
	assert.equal(processes.started.length, 0);
	assert.deepEqual(tasks.ran, []);
});


suite('Extension debug session lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const retirement of ['deadline', 'workspace', 'factory', 'stop'] as const) {
		test(`releases late tracker creation after ${retirement} using the real Debug owner`, async () => {
			using resources = new DisposableStore();
			const services = workbenchInstantiationService(resources);
			const root = URI.file('/workspace');
			const workspace = services.get(IWorkspaceContextService) as WorkspaceContextService;
			services.registerInstance(IFileService, resources.add(createTestFileService(new FakeFileService(root))));
			services.registerInstance(IPathService, new BrowserPathService(createDisconnectedRendererApi(), workspace));
			services.registerSingleton(ICommandService, () => new CommandService(services));
			services.registerInstance(ILogService, new NullLoggerService());
			services.registerInstance(IContextKeyService, resources.add(new ContextKeyService()));
			services.registerInstance(IMarkerService, resources.add(new MarkerService()));
			registerTestExtensionService(resources, services);
			services.registerInstance(ITerminalProcessService, createDisconnectedRendererApi().terminal);
			services.registerInstance(IConfigurationResolverService, resources.add(services.createInstance(ConfigurationResolverService)));
			services.registerInstance(ITerminalService, resources.add(services.createInstance(TerminalService)));
			registerTestWorkbenchInteractionServices(resources, services);
			services.registerInstance(ITaskService, resources.add(services.createInstance(TaskService)));
			const processes = resources.add(new FakeDebugAdapterProcessService());
			services.registerInstance(IDebugAdapterProcessService, processes);
			services.registerInstance(IDebugAdapterFactorySource, resources.add(new DebugAdapterFactoryRegistry()));
			if (!services.has(IEditorService)) services.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async () => { }, focusActiveEditor() { } });
			if (!services.has(IEditorGroupsService)) services.registerInstance(IEditorGroupsService, {} as IEditorGroupsService);
			const debug = resources.add(services.createInstance(DebugService));
			await debug.refresh();
			const entered = new DeferredPromise<void>();
			const release = new DeferredPromise<void>();
			const disposed = new DeferredPromise<void>();
			let immediateDisposed = 0;
			let started = 0;
			const registration = resources.add(debug.registerDebugAdapterTrackerFactories([
				{ id: 'immediate', type: '*', createDebugAdapterTracker: () => Object.assign(toDisposable(() => immediateDisposed++), { onWillStartSession: () => { started++; } }) },
				{
					id: 'pending', type: '*', createDebugAdapterTracker: async () => {
						void entered.complete(undefined);
						await release.p;
						return toDisposable(() => { void disposed.complete(undefined); });
					}
				},
			]));
			let preparingSessionId = '';
			resources.add(debug.onWillNewSession(session => { preparingSessionId = session.id; }));
			const launch = debug.startDebugging(debug.configurations[1]!);
			await entered.p;
			if (retirement === 'workspace') {
				workspace.updateWorkspace({ id: 'retired', folders: [] });
				await assert.rejects(launch, isCancellationError);
				assert.equal(processes.started.length, 0);
			} else if (retirement === 'stop') {
				const cancelled = assert.rejects(launch, isCancellationError);
				await debug.stop(debug.getSession(preparingSessionId)!);
				await cancelled;
				assert.equal(processes.started.length, 0);
			} else if (retirement === 'factory') {
				registration.dispose();
				await release.complete(undefined);
				await disposed.p;
				const session = await launch;
				await debug.stop(session);
			} else {
				const session = await launch;
				assert.equal(processes.started.length, 1);
				assert.equal(started, 0);
				await debug.stop(session);
			}
			await release.complete(undefined);
			await disposed.p;
			assert.equal(immediateDisposed, 1);
		});
	}



	for (const launchKind of ['explicit', 'factory', 'factory default', 'server', 'pipe', 'debugServer', 'factory failure', 'factory empty'] as const) {
		for (const retireObserver of [false, true]) {
			if (['factory failure', 'factory empty', 'server', 'pipe', 'debugServer'].includes(launchKind) && retireObserver) continue;
			test(`routes ${launchKind} launches and custom DAP requests to real sessions and observes resource release with observer retirement ${retireObserver}`, async () => {
				using resources = new DisposableStore();
				using localization = toDisposable(resetNlsResolver);
				if (launchKind === 'factory empty' || launchKind === 'explicit' && !retireObserver) { initializeTestLocalization('zh-CN'); }
				const services = workbenchInstantiationService(resources);
				const root = URI.file('/workspace');
				const workspace = services.get(IWorkspaceContextService);
				services.registerInstance(IFileService, resources.add(createTestFileService(new FakeFileService(root))));
				services.registerInstance(IPathService, new BrowserPathService(createDisconnectedRendererApi(), workspace));
				services.registerSingleton(ICommandService, () => new CommandService(services));
				services.registerInstance(ILogService, new NullLoggerService());
				services.registerInstance(IContextKeyService, resources.add(new ContextKeyService()));
				services.registerInstance(IMarkerService, resources.add(new MarkerService()));
				registerTestExtensionService(resources, services);
				services.registerInstance(ITerminalProcessService, createDisconnectedRendererApi().terminal);
				services.registerInstance(IConfigurationResolverService, resources.add(services.createInstance(ConfigurationResolverService)));
				services.registerInstance(ITerminalService, resources.add(services.createInstance(TerminalService)));
				registerTestWorkbenchInteractionServices(resources, services);
				services.registerInstance(ITaskService, resources.add(services.createInstance(TaskService)));
				const processes = resources.add(new FakeDebugAdapterProcessService());
				processes.earlyCustomEvent = true;
				processes.customHandler = request => request.command === 'custom:fail'
					? { success: false, message: 'Adapter rejected request' }
					: request.command === 'custom:empty' ? {} : { body: request.arguments };
				services.registerInstance(IDebugAdapterProcessService, processes);
				const adapters = resources.add(new DebugAdapterFactoryRegistry());
				services.registerInstance(IDebugAdapterFactorySource, adapters);
				if (!services.has(IEditorService)) services.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async () => { }, focusActiveEditor() { } });
				if (!services.has(IEditorGroupsService)) services.registerInstance(IEditorGroupsService, {} as IEditorGroupsService);
				const debug = resources.add(services.createInstance(DebugService));
				services.registerInstance(IDebugService, debug);
				const consoleService = resources.add(new DebugConsoleService(debug));
				const events: { incarnation: number; value: Record<string, JsonValue>; }[] = [];
				const trackerEvents: { trackerId: string; event: string; message?: { type: string; seq: number; command?: string; event?: string; }; code?: unknown; signal?: unknown; }[] = [];
				let trackerCreations = 0;
				let trackerSessionId = '';
				const reentrantResponse = new DeferredPromise<void>();
				const ended = new DeferredPromise<void>();
				const breakpointsRemoved = new DeferredPromise<void>();
				let descriptorSession: { id: string; workspaceFolder: { uri: string; name: string; index: number; }; } | undefined;
				services.registerInstance(IExtensionHostApi, {
					...createDisconnectedRendererApi().extensionHost,
					invoke: async (invocation): Promise<JsonValue> => {
						if (invocation.operation === 'createDebugAdapterTracker') {
							const snapshot = (invocation.payload as { session: { id: string; type: string; name: string; configuration: { program: string; request: string; }; }; }).session;
							trackerSessionId = snapshot.id;
							assert.equal(debug.getSession(snapshot.id)?.name, snapshot.name);
							assert.equal(snapshot.configuration.program, '/workspace/app');
							assert.equal(snapshot.configuration.request, launchKind === 'explicit' ? 'launch' : 'attach');
							assert.equal(processes.started.length, 0);
							return { trackerId: `tracker-${++trackerCreations}`, operations: ['onWillStartSession', 'onWillReceiveMessage', 'onDidSendMessage', 'onWillStopSession', 'onError', 'onExit'] };
						}
						if (invocation.operation === 'debugAdapterTrackerEvent') {
							const value = invocation.payload as typeof trackerEvents[number];
							trackerEvents.push(value);
							if (value.event === 'onWillStartSession') {
								assert.equal(processes.started.length, 0);
								if (launchKind === 'explicit' && !retireObserver && value.trackerId === 'tracker-2') { throw new Error('Tracker callback marker'); }
							}
							if (value.event === 'onWillReceiveMessage' && value.message?.type === 'request') {
								assert.equal(processes.requests.some(request => request.seq === value.message!.seq), false);
							}
							if (value.event === 'onDidSendMessage' && value.message?.event === 'initialized' && value.trackerId === 'tracker-1') {
								const id = trackerSessionId;
								assert.deepEqual(JSON.parse(JSON.stringify(await bridge.handle({ operation: 'debugCustomRequest', sessionId: id, command: 'custom:tracker', arguments: { reentrant: true }, hasArguments: true }, signal))), { result: 'debugResponse', value: { reentrant: true }, hasBody: true });
								void reentrantResponse.complete(undefined);
							}
							return null;
						}
						if (invocation.operation === 'createDebugAdapterDescriptor') {
							const executable = (invocation.payload as { executable?: JsonValue; }).executable;
							assert.deepEqual(executable === undefined ? undefined : JSON.parse(JSON.stringify(executable)), ['factory default', 'factory empty'].includes(launchKind) ? { program: '/workspace/default-adapter', arguments: ['$HOME', ''], env: { REMOVED: null } } : undefined);
							descriptorSession = (invocation.payload as unknown as { session: NonNullable<typeof descriptorSession>; }).session;
							assert.deepEqual(JSON.parse(JSON.stringify(descriptorSession.workspaceFolder)), { uri: root.toString(), name: 'workspace', index: 0 });
							await bridge.handle({ operation: 'setDebugSessionName', sessionId: descriptorSession.id, name: 'Prepared factory session' }, signal);
							if (launchKind === 'factory failure') throw new Error('Descriptor failed before spawning');
							if (launchKind === 'factory empty') return null;
							return launchKind === 'server' ? { connection: { type: 'server', port: 4711, host: '::1' } } : launchKind === 'pipe' ? { connection: { type: 'namedPipe', path: '/tmp/adapter.sock' } } : { program: 'adapter', arguments: [] };
						}
						assert.equal(invocation.operation, 'debugEvent');
						const value = invocation.payload as Record<string, JsonValue>;
						events.push({ incarnation: invocation.incarnation, value });
						if (value.type === 'end') void ended.complete(undefined);
						if (value.type === 'breakpoints' && (value.removed as JsonValue[]).length === 2) void breakpointsRemoved.complete(undefined);
						return null;
					},
				});
				const trackerInvoker = (operation: string, payload: JsonValue, signal: AbortSignal) => services.get(IExtensionHostApi).invoke({
					extensionId: 'extension', activationGeneration: 1, incarnation: 1, registrationId: 'tracker', operation, payload, deadlineUnixMillis: Date.now() + 5000,
				}, signal);
				const trackerRegistration = resources.add(debug.registerDebugAdapterTrackerFactories([
					createExtensionHostDebugAdapterTrackerFactory('*', 'wildcard-tracker', trackerInvoker, workspace),
					createExtensionHostDebugAdapterTrackerFactory('example', 'type-tracker', trackerInvoker, workspace),
					{ id: 'unmatched-tracker', type: 'different', createDebugAdapterTracker: () => assert.fail('An unrelated tracker type must not run') },
				]));
				assert.throws(() => trackerRegistration.replace([{ id: 'invalid', type: '', createDebugAdapterTracker: () => undefined }]), /Invalid Debug Adapter tracker/);
				if (['factory default', 'factory empty'].includes(launchKind)) {
					resources.add(adapters.registerFactories([createStaticDebugAdapterFactory('example', 'Example', 'declarative:example', { program: '${workspaceFolder}/default-adapter', arguments: ['$HOME', ''], env: { REMOVED: null } })]));
				}
				if (launchKind !== 'explicit') {
					resources.add(debug.registerDebugConfigurationProviders([{ id: 'factory-resolver', type: 'example', triggerKind: DebugConfigurationProviderTriggerKind.Initial, resolveDebugConfiguration: (_folder, configuration) => ({ ...configuration, name: 'Resolved factory launch', request: 'attach' }) }]));
					const api = services.get(IExtensionHostApi);
					resources.add(adapters.registerFactories([createExtensionHostDebugAdapterFactory('example', 'owned-adapter', (operation, payload, signal) => api.invoke({
						extensionId: 'extension', activationGeneration: 1, incarnation: 1, registrationId: 'adapter',
						operation, payload, deadlineUnixMillis: Date.now() + 5000,
					}, signal), workspace)]));
				}
				const errors: unknown[] = [];
				const bridge = resources.add(services.createInstance(MainThreadDebugService, 5000, (error: unknown) => errors.push(error)));
				const snapshot = (incarnation: number): ExtensionHostFleetSnapshot => ({
					generation: incarnation, extensions: [{
						id: 'extension', version: '1', packageDigest: 'digest', runtimeApiVersion: 1,
						activationGeneration: 1, incarnation, lifecycle: 'ready', failure: undefined,
						stderr: '', outputEvents: [], registrations: [{ registrationId: 'vscode.debug.events', kind: 'debugEvents' }],
					}],
				});
				bridge.update(snapshot(1));
				const signal = new AbortController().signal;
				assert.deepEqual(await bridge.handle({ operation: 'listDebugSessions' }, signal), {
					result: 'debugSessions', sequence: 0, sessions: [], activeSession: null, breakpoints: [],
				});
				if (['factory failure', 'factory empty'].includes(launchKind)) {
					await assert.rejects(bridge.handle({
						operation: 'startDebugging', folder: root.toString(),
						configuration: { name: 'Rejected', type: 'example', request: 'launch' },
					}, signal), launchKind === 'factory empty' ? /调试适配器工厂未提供适配器。/ : /Descriptor failed before spawning/);
					await ended.p;
					assert.deepEqual({ sessions: debug.sessions, spawned: processes.started, events: events.map(entry => entry.value.type), errors }, {
						sessions: [], spawned: [], events: ['snapshot', 'name', 'end'], errors: [],
					});
					assert.equal((events.at(-1)!.value.session as { id: string; }).id, descriptorSession!.id);
					assert.equal(trackerCreations, 0);
					return;
				}
				const checkBreakpoints = launchKind === 'explicit' && !retireObserver;
				const sourcePoint = { kind: 'source', id: 'extension-source', uri: root.with({ path: '/workspace/app.ts' }).toString(), line: 6, column: 3, enabled: true, condition: 'value > 0', hitCondition: '2' } as const;
				if (checkBreakpoints) {
					processes.breakpointIds = true;
					await assert.rejects(bridge.handle({ operation: 'addDebugBreakpoints', breakpoints: [sourcePoint, { ...sourcePoint, id: 'invalid', line: -1 }] }, signal), /Invalid source breakpoint position/);
					assert.equal(debug.breakpoints.length, 0);
					await bridge.handle({ operation: 'addDebugBreakpoints', breakpoints: [sourcePoint, { kind: 'function', id: 'extension-function', name: 'main', enabled: true, logMessage: 'function hit' }] }, signal);
					const point = debug.breakpoints[0]!;
					assert.deepEqual({ id: point.id, resource: point.resource.toString(), line: point.lineNumber, column: point.columnNumber }, { id: sourcePoint.id, resource: sourcePoint.uri, line: 7, column: 4 });
					await services.get(IStorageService).flush();
					if (!services.has(IEditorService)) services.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async () => { }, focusActiveEditor() { } });
					if (!services.has(IEditorGroupsService)) services.registerInstance(IEditorGroupsService, {} as IEditorGroupsService);
					using restored = services.createInstance(DebugService);
					assert.deepEqual(restored.breakpoints, debug.breakpoints);
					assert.equal(restored.functionBreakpoints[0]!.logMessage, 'function hit');
				}
				assert.deepEqual(await bridge.handle({
					operation: 'startDebugging', folder: root.toString(), configuration: {
						name: 'Extension launch', type: 'example', request: 'launch',
						...(launchKind === 'explicit' ? { debugAdapter: { program: 'adapter' } } : launchKind === 'debugServer' ? { debugServer: 4711 } : {}), program: '${workspaceFolder}/app',
					},
				}, signal), { result: 'debugStarted', started: true });
				const session = debug.session!;
				let reentrantTimeout: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([reentrantResponse.p, new Promise<never>((_resolve, reject) => { reentrantTimeout = setTimeout(() => reject(new Error(`Tracker callback failed: ${session.output}`)), 5000); })]);
				} finally { clearTimeout(reentrantTimeout); }
				if (launchKind === 'server' || launchKind === 'pipe' || launchKind === 'debugServer') {
					assert.deepEqual((processes.started[0] as { connection?: unknown; }).connection, launchKind === 'pipe' ? { type: 'namedPipe', path: '/tmp/adapter.sock' } : { type: 'server', port: 4711, ...(launchKind === 'server' ? { host: '::1' } : {}) });
					assert.equal((processes.started[0] as { program?: unknown; }).program, undefined);
				}
				assert.equal(trackerCreations, 2);
				assert.equal(trackerEvents.filter(value => value.event === 'onWillStartSession').length, 2);
				assert.equal(trackerEvents.some(value => value.event === 'onError'), false);
				if (launchKind === 'explicit' && !retireObserver) { assert.match(session.output, /调试适配器跟踪器失败：Tracker callback marker/); }
				// Retiring factories must preserve hooks already owned by a session.
				trackerRegistration.dispose();
				if (launchKind === 'factory') assert.equal(descriptorSession!.id, session.id);
				if (launchKind === 'factory') {
					assert.equal(session.name, 'Prepared factory session');
					assert.equal(session.configuration.request, 'launch');
					assert.equal(session.resolvedConfiguration?.name, 'Resolved factory launch');
					assert.equal(processes.requests.some(value => value.command === 'attach'), true);
					assert.equal(processes.requests.some(value => value.command === 'launch'), false);
					assert.equal(consoleService.activeSession?.label, session.name);
				}
				const current = await bridge.handle({ operation: 'listDebugSessions' }, signal);
				assert.equal(current.result, 'debugSessions');
				if (current.result !== 'debugSessions') throw new Error('Expected debug session list');
				assert.equal(current.activeSession, session.id);
				assert.equal((current.sessions[0] as { configuration: { program: string; }; }).configuration.program, '/workspace/app');
				if (checkBreakpoints) {
					assert.deepEqual(JSON.parse(JSON.stringify(await bridge.handle({ operation: 'getDebugProtocolBreakpoint', sessionId: session.id, breakpointId: sourcePoint.id }, signal))), { result: 'debugResponse', value: { verified: true, id: 100, line: 7, column: 4, condition: 'value > 0', hitCondition: '2' }, hasBody: true });
					assert.equal((await bridge.handle({ operation: 'getDebugProtocolBreakpoint', sessionId: session.id, breakpointId: 'extension-function' }, signal) as { hasBody: boolean; }).hasBody, true);
					await bridge.handle({ operation: 'setDebugSessionName', sessionId: session.id, name: 'Extension renamed session' }, signal);
					assert.equal(session.name, 'Extension renamed session');
					assert.equal(consoleService.activeSession?.label, session.name);
					assert.equal(session.configuration.name, 'Extension launch');
					assert.equal(events.filter(entry => entry.value.type === 'breakpoints').length, 1);
					const verified = new DeferredPromise<void>();
					using verification = debug.onDidChangeBreakpoints(points => {
						if (points.find(point => point.id === sourcePoint.id)?.message === 'relocated') void verified.complete(undefined);
					});
					processes.event('debug-1', 'breakpoint', { reason: 'changed', breakpoint: { id: 100, verified: true, line: 8, column: 2, message: 'relocated' } });
					await verified.p;
					assert.deepEqual(session.getDebugProtocolBreakpoint(sourcePoint.id), { id: 100, verified: true, line: 8, column: 2, message: 'relocated' });
					assert.equal(events.filter(entry => entry.value.type === 'breakpoints').length, 1);
					debug.updateBreakpoint(sourcePoint.id, { condition: 'value > 1' });
					assert.equal(session.getDebugProtocolBreakpoint(sourcePoint.id), undefined);
					debug.updateBreakpoint(sourcePoint.id, { enabled: false });
					assert.equal(session.getDebugProtocolBreakpoint(sourcePoint.id), undefined);
					await bridge.handle({ operation: 'removeDebugBreakpoints', breakpointIds: [sourcePoint.id, 'extension-function'] }, signal);
					assert.equal(session.getDebugProtocolBreakpoint('extension-function'), undefined);
					assert.deepEqual([...debug.breakpoints], []);
					await breakpointsRemoved.p;
					const removed = events.filter(entry => entry.value.type === 'breakpoints').at(-1)!;
					assert.deepEqual((removed.value.removed as { id: string; }[]).map(value => value.id), [sourcePoint.id, 'extension-function']);
					await (session as DebugAdapterSession).syncBreakpoints();
					const sent = processes.requests.filter(value => value.command === 'setBreakpoints').length;
					const addedPoint = new DeferredPromise<string>();
					using additions = debug.onDidChangeBreakpoints(points => {
						const point = points.find(value => 'resource' in value && value.resource.scheme === 'debug');
						if (point && point.verified) {
							assert.equal((session.getDebugProtocolBreakpoint(point.id) as { id: number; }).id, 777, 'binding exists when the catalog change is published');
							void addedPoint.complete(point.id);
						}
					});
					processes.event('debug-1', 'breakpoint', { reason: 'new', breakpoint: { id: 777, source: { name: 'generated.ts', sourceReference: 17 }, line: 6, column: 3, verified: true } });
					const addedId = await addedPoint.p;
					assert.deepEqual(debug.breakpoints.map(point => ({ id: point.id, resource: point.resource.toString(), line: point.lineNumber, column: point.columnNumber, verified: point.verified })), [{ id: addedId, resource: `debug:/generated.ts?session=${session.id}&ref=17`, line: 6, column: 3, verified: true }]);
					const adapterRemoval = new DeferredPromise<void>();
					using removals = debug.onDidChangeBreakpoints(points => { if (!points.some(point => point.id === addedId)) void adapterRemoval.complete(); });
					processes.event('debug-1', 'breakpoint', { reason: 'removed', breakpoint: { id: 777, verified: false } });
					await adapterRemoval.p;
					assert.deepEqual([...debug.breakpoints], []);
					assert.equal(session.getDebugProtocolBreakpoint(addedId), undefined);
					await session.customRequest('custom:echo', { barrier: true });
					assert.equal(processes.requests.filter(value => value.command === 'setBreakpoints').length, sent, 'adapter-originated catalog changes do not echo back to the adapter');
					additions.dispose();
					removals.dispose();
					const unidentifiedPoint = new DeferredPromise<string>();
					using unidentified = debug.onDidChangeBreakpoints(points => {
						const point = points.find(point => 'resource' in point && point.resource.query.endsWith('&ref=18'));
						if (point) void unidentifiedPoint.complete(point.id);
					});
					processes.event('debug-1', 'breakpoint', { reason: 'new', breakpoint: { source: { sourceReference: 18 }, line: 7, verified: true } });
					const unidentifiedId = await unidentifiedPoint.p;
					assert.deepEqual(session.getDebugProtocolBreakpoint(unidentifiedId), { source: { sourceReference: 18 }, line: 7, verified: true });
					await bridge.handle({ operation: 'removeDebugBreakpoints', breakpointIds: [unidentifiedId] }, signal);
					await (session as DebugAdapterSession).syncBreakpoints();
					assert.deepEqual(processes.requests.filter(value => value.command === 'setBreakpoints').slice(sent).map(value => value.arguments), [{ source: { sourceReference: 18 }, breakpoints: [] }]);
				}
				const request = (command: string, args: JsonValue, hasArguments = true) => bridge.handle({
					operation: 'debugCustomRequest', sessionId: session.id, command, arguments: args, hasArguments,
				}, signal);
				assert.deepEqual(JSON.parse(JSON.stringify(await request('custom:echo', { value: [0, false, null, ''] }))), {
					result: 'debugResponse', value: { value: [0, false, null, ''] }, hasBody: true,
				});
				assert.deepEqual(await request('custom:echo', null), { result: 'debugResponse', value: null, hasBody: true });
				assert.deepEqual(await request('custom:empty', null, false), { result: 'debugResponse', value: null, hasBody: false });
				await assert.rejects(request('custom:fail', null), /Adapter rejected request/);
				await assert.rejects(request('', null), /Invalid Debug Adapter command/);
				assert.equal(processes.requests.some(value => value.command === ''), false);
				const custom = events.find(entry => entry.value.type === 'custom')!.value;
				assert.equal(custom.event, 'builderReady');
				assert.equal(custom.hasBody, true);
				assert.equal(custom.body, null);
				assert.deepEqual(events.filter(entry => !['breakpoints', 'name'].includes(String(entry.value.type))).map(entry => entry.value.type), ['snapshot', 'custom', 'start', 'active']);
				assert.ok(events.every(entry => ['snapshot', 'breakpoints'].includes(String(entry.value.type)) || (entry.value.session as { id: string; }).id === session.id));
				processes.closeRequested = new DeferredPromise<void>();
				processes.closeBarrier = new DeferredPromise<void>();
				const stop = bridge.handle({ operation: 'stopDebugging', sessionId: session.id }, signal);
				try {
					await processes.closeRequested.p;
					assert.equal(events.some(entry => entry.value.type === 'end'), false);
					assert.equal(trackerEvents.filter(value => value.event === 'onWillStopSession').length, 2);
					assert.equal(trackerEvents.some(value => value.event === 'onExit'), false);
					await assert.rejects(request('custom:after-stop', null), isCancellationError);
					assert.equal(processes.requests.some(value => value.command === 'custom:after-stop'), false);
					if (retireObserver) bridge.update(snapshot(2));
				} finally { await processes.closeBarrier.complete(undefined); }
				await stop;
				await ended.p;
				assert.deepEqual(trackerEvents.filter(value => value.event === 'onExit').map(value => [value.code, value.signal]), [[null, null], [null, null]]);
				assert.equal(trackerEvents.filter(value => value.event === 'dispose').length, 2);
				await assert.rejects(request('custom:echo', null), /Debug session has ended/);
				assert.deepEqual(debug.sessions, []);
				assert.deepEqual(events.filter(entry => entry.value.type === 'end').map(entry => entry.incarnation), [retireObserver ? 2 : 1]);
				assert.deepEqual(errors, []);
			});
		}
	}
});

test('installed inline descriptors use the real DAP session and await implementation release without spawning a process', async () => {
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	const root = URI.file('/workspace');
	const workspace = services.get(IWorkspaceContextService);
	services.registerInstance(IFileService, resources.add(createTestFileService(new FakeFileService(root))));
	services.registerInstance(IPathService, new BrowserPathService(createDisconnectedRendererApi(), workspace));
	services.registerSingleton(ICommandService, () => new CommandService(services));
	services.registerInstance(ILogService, new NullLoggerService());
	services.registerInstance(IContextKeyService, resources.add(new ContextKeyService()));
	services.registerInstance(IMarkerService, resources.add(new MarkerService()));
	registerTestExtensionService(resources, services);
	services.registerInstance(ITerminalProcessService, createDisconnectedRendererApi().terminal);
	services.registerInstance(IConfigurationResolverService, resources.add(services.createInstance(ConfigurationResolverService)));
	services.registerInstance(ITerminalService, resources.add(services.createInstance(TerminalService)));
	registerTestWorkbenchInteractionServices(resources, services);
	services.registerInstance(ITaskService, resources.add(services.createInstance(TaskService)));
	const processes = resources.add(new FakeDebugAdapterProcessService());
	services.registerInstance(IDebugAdapterProcessService, processes);
	// This peer supplies only DAP IO; the actual service/session own all debug state.
	const peer = resources.add(new FakeDebugAdapterProcessService());
	peer.customHandler = request => ({ body: request.arguments });
	const io = await peer.start({});
	peer.closeBarrier = new DeferredPromise<void>();
	peer.closeRequested = new DeferredPromise<void>();
	const factories = resources.add(new DebugAdapterFactoryRegistry());
	services.registerInstance(IDebugAdapterFactorySource, factories);
	let closed = 0;
	resources.add(factories.registerFactories([createExtensionHostDebugAdapterFactory('inline', 'inline-owner', async (operation, payload) => {
		const value = payload as { message?: unknown; afterSequence: number; maxMessages: number; };
		if (operation === 'createDebugAdapterDescriptor') { return { inlineAdapterId: 'inline.1' }; }
		if (operation === 'sendInlineDebugAdapter') { await peer.send(io, value.message); return null; }
		if (operation === 'readInlineDebugAdapter') {
			const { messages, nextSequence, exited, protocolError } = await peer.read(io, value.afterSequence, value.maxMessages);
			return JSON.parse(JSON.stringify({ messages, nextSequence, exited, protocolError }));
		}
		assert.equal(operation, 'closeInlineDebugAdapter');
		await peer.close(io); closed++; return null;
	}, workspace)]));
	if (!services.has(IEditorService)) services.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async () => { }, focusActiveEditor() { } });
	if (!services.has(IEditorGroupsService)) services.registerInstance(IEditorGroupsService, {} as IEditorGroupsService);
	const debug = resources.add(services.createInstance(DebugService));
	services.registerInstance(IDebugService, debug);
	const identity = resources.add(new TestUriIdentityServices());
	const uriIdentity = identity.get(IUriIdentityService);
	resources.add(services.createInstance(DebugContentProvider));
	const stackEvents: JsonValue[] = [];
	const stackCleared = new DeferredPromise<void>();
	services.registerInstance(IExtensionHostApi, { ...createDisconnectedRendererApi().extensionHost, invoke: async invocation => { stackEvents.push(invocation.payload); if ((invocation.payload as { type: string; item?: unknown; }).type === 'stackItem' && (invocation.payload as { item: unknown; }).item === null) void stackCleared.complete(undefined); return null; } });
	const bridge = resources.add(services.createInstance(MainThreadDebugService, 5000, (error: unknown) => { throw error; }));
	bridge.update({ generation: 1, extensions: [{ id: 'observer', version: '1', packageDigest: 'digest', runtimeApiVersion: 1, activationGeneration: 1, incarnation: 1, lifecycle: 'ready', failure: undefined, stderr: '', outputEvents: [], registrations: [{ registrationId: 'events', kind: 'debugEvents' }] }] });
	const session = await debug.startDebugging({ id: 'inline', name: 'Inline', type: 'inline', request: 'launch', arguments: {} });
	assert.equal(processes.started.length, 0);
	assert.equal(debug.session, session);
	peer.requestHandler = request => request.command === 'threads' ? { threads: [{ id: 0, name: 'main' }, { id: -1, name: 'worker' }] }
		: request.command === 'stackTrace' ? { stackFrames: [{ id: 0, name: 'main', line: 1, column: 1 }] } : {};
	const stopped = new DeferredPromise<void>();
	resources.add(session.onDidChangeState(state => { if (state === 'stopped') void stopped.complete(undefined); }));
	peer.event(io, 'stopped', { threadId: 0 });
	await stopped.p;
	const frame = (await session.stackTrace(0))[0]!;
	assert.equal(frame.threadId, 0);
	debug.focusStackFrame(frame);
	session.selectThread(-1);
	assert.equal(debug.focusedStackFrame, undefined);
	const nextFrame = (await session.stackTrace(-1))[0]!;
	debug.focusStackFrame(nextFrame);
	peer.event(io, 'continued', { threadId: -1 });
	await stackCleared.p;
	assert.equal(session.state, 'running');
	assert.deepEqual(stackEvents.filter(event => (event as { type: string; }).type === 'stackItem').map(event => {
		const item = (event as { item: { kind: string; threadId: number; frameId?: number; } | null; }).item;
		return item === null ? null : [item.kind, item.threadId, item.frameId ?? null];
	}), [['thread', 0, null], ['frame', 0, 0], ['thread', -1, null], ['frame', -1, 0], null]);
	const sourceReply = new DeferredPromise<unknown>();
	peer.sourceHandler = request => {
		assert.equal((request.arguments as { sourceReference: number; }).sourceReference, 33);
		return sourceReply.p;
	};
	const resource = getUriFromSource({ name: 'generated?#.ts', path: '/adapter-only/generated?#.ts', sourceReference: 33 }, '/adapter-only/generated?#.ts', session.id, uriIdentity, services.get(ILogService));
	assert.equal(resource.scheme, 'debug');
	for (const [path, address] of [['C:\\project\\main.ts', 'file:///C:/project/main.ts'], ['/project/main\\part.ts', 'file:///project/main%5Cpart.ts']]) {
		assert.equal(getUriFromSource({ path }, path, session.id, uriIdentity, services.get(ILogService)).toString(), address);
	}
	const textModels = services.get(ITextModelService);
	const first = textModels.createModelReference(resource);
	const second = textModels.createModelReference(URI.parse(resource.toString()));
	await sourceReply.complete({ content: 'const generated = true;', mimeType: 'text/typescript' });
	const references = await Promise.all([first, second]);
	assert.equal(peer.requests.filter(request => request.command === 'source').length, 1);
	assert.equal(references[0]!.object.textEditorModel, references[1]!.object.textEditorModel);
	assert.equal(references[0]!.object.textEditorModel.getValue(), 'const generated = true;');
	references[0]!.dispose();
	assert.equal(services.get(IModelService).getModel(resource), references[1]!.object.textEditorModel);
	references[1]!.dispose();
	assert.equal(services.get(IModelService).getModel(resource), null);
	const lateSource = new DeferredPromise<unknown>();
	const requested = new DeferredPromise<void>();
	peer.sourceHandler = () => { void requested.complete(undefined); return lateSource.p; };
	const lateResource = resource.with({ path: '/late-source.ts' });
	const late = assert.rejects(textModels.createModelReference(lateResource));
	await requested.p;
	assert.deepEqual(await session.customRequest('custom:echo', { literal: '$HOME' }), { literal: '$HOME' });
	let ended = false;
	resources.add(debug.onDidEndSession(() => { ended = true; }));
	const stopping = debug.stop(session);
	await peer.closeRequested.p;
	assert.equal(ended, false);
	assert.equal(closed, 0);
	await peer.closeBarrier.complete(undefined);
	await stopping;
	assert.equal(ended, true);
	await lateSource.complete({ content: 'obsolete' });
	await late;
	assert.equal(services.get(IModelService).getModel(lateResource), null);
	initializeTestLocalization('zh-CN');
	try { await assert.rejects(textModels.createModelReference(resource), { message: '调试会话已结束，无法加载此源文件。' }); }
	finally { resetNlsResolver(); }
	assert.equal(closed, 1);
	assert.equal(processes.started.length, 0);
	assert.deepEqual(peer.requests.slice(0, 2).map(message => message.command), ['initialize', 'launch']);
});


test('extension debug session options retain parent identity, inherit noDebug, merge consoles, and route managed lifecycle', async () => {
	using resources = new DisposableStore();
	const root = URI.file('/workspace');
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	processes.requestHandler = request => request.command === 'initialize'
		? { supportsConfigurationDoneRequest: true, supportsRestartRequest: true, supportsFunctionBreakpoints: true }
		: request.command === 'evaluate' ? { result: 'child answer', variablesReference: 0 } : {};
	using adapters = new DebugAdapterFactoryRegistry();
	const descriptorParents: Array<string | undefined> = [];
	const trackerParents: Array<string | undefined> = [];
	resources.add(adapters.registerFactories([createExtensionHostDebugAdapterFactory('example', 'host', async (_operation, payload) => {
		descriptorParents.push((payload as { session: { parentSessionId?: string; }; }).session.parentSessionId);
		return { program: '/adapter', arguments: [] };
	}, workspace)]));
	using debug = createDebugService(resources, new FakeFileService(root), workspace, processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	resources.add(debug.registerDebugAdapterTrackerFactories([createExtensionHostDebugAdapterTrackerFactory('example', 'tracker', async (_operation, payload) => {
		trackerParents.push((payload as { session: { parentSessionId?: string; }; }).session.parentSessionId);
		return null;
	}, workspace)]));
	using consoleService = new DebugConsoleService(debug);
	using services = new InstantiationService(new ServiceCollection([IDebugService, debug], [IWorkspaceContextService, workspace], [IExtensionHostApi, createDisconnectedRendererApi().extensionHost]));
	using bridge = services.createInstance(MainThreadDebugService, 5000, (error: unknown) => { throw error; });
	debug.toggleBreakpoint(URI.file('/workspace/main.ts'), 3);
	debug.addFunctionBreakpoint({ name: 'main' });
	const launch = async (name: string, options?: { parentSessionId?: string; noDebug?: boolean; consoleMode?: number; lifecycleManagedByParent?: boolean; }) => {
		await bridge.handle({ operation: 'startDebugging', folder: root.toString(), configuration: { name, type: 'example', request: 'launch' }, options }, new AbortController().signal);
		return debug.session!;
	};
	const parent = await launch('Parent', { noDebug: true });
	const child = await launch('Child', { parentSessionId: parent.id, consoleMode: DebugConsoleMode.MergeWithParent, lifecycleManagedByParent: true });
	assert.equal(child.parentSession, parent);
	assert.equal(child.resolvedConfiguration?.arguments.noDebug, true);
	const childRequests = processes.requestsBySession.get('debug-2')!;
	assert.equal((childRequests.find(request => request.command === 'launch')!.arguments as { noDebug: boolean; }).noDebug, true);
	assert.equal(childRequests.some(request => request.command === 'setBreakpoints' || request.command === 'setFunctionBreakpoints'), false);
	assert.deepEqual(childRequests.find(request => request.command === 'setExceptionBreakpoints')!.arguments, { filters: [] });
	const listed = await bridge.handle({ operation: 'listDebugSessions' }, new AbortController().signal);
	assert.equal(listed.result, 'debugSessions');
	if (listed.result === 'debugSessions') assert.equal((listed.sessions[1] as { parentSessionId: string; }).parentSessionId, parent.id);
	assert.deepEqual(consoleService.sessions.map(console => console.id), [parent.id]);
	const receivedOutput = new DeferredPromise<void>();
	const receivedParent = new DeferredPromise<void>();
	resources.add(consoleService.onDidChange(() => {
		if (consoleService.activeSession?.output.includes('parent output\n')) void receivedParent.complete(undefined);
		if (consoleService.activeSession?.output.includes('parent output\nchild output\n')) void receivedOutput.complete(undefined);
	}));
	processes.event('debug-1', 'output', { output: 'parent output\n' });
	await receivedParent.p;
	processes.event('debug-2', 'output', { output: 'child output\n' });
	await receivedOutput.p;
	await consoleService.evaluate('answer');
	assert.match(consoleService.activeSession!.output, /child answer/);
	assert.equal(childRequests.filter(request => request.command === 'evaluate').length, 1);
	assert.equal(processes.requestsBySession.get('debug-1')!.filter(request => request.command === 'evaluate').length, 0);
	assert.equal(await debug.restart(child), parent);
	assert.equal(processes.requestsBySession.get('debug-1')!.filter(request => request.command === 'restart').length, 1);
	assert.equal(childRequests.filter(request => request.command === 'restart').length, 0);
	const separate = await launch('Separate', { parentSessionId: parent.id, noDebug: false, consoleMode: DebugConsoleMode.Separate });
	assert.equal(separate.resolvedConfiguration?.arguments.noDebug, false);
	assert.equal(processes.requestsBySession.get('debug-3')!.some(request => request.command === 'setBreakpoints'), true);
	assert.deepEqual(consoleService.sessions.map(console => console.id), [parent.id, separate.id]);
	await debug.stop(separate);
	assert.deepEqual(debug.sessions.map(session => session.id), [parent.id, child.id]);
	consoleService.selectSession(parent.id);
	await bridge.handle({ operation: 'stopDebugging', sessionId: child.id }, new AbortController().signal);
	assert.deepEqual(debug.sessions, []);
	assert.equal(consoleService.sessions.find(console => console.id === parent.id)!.canEvaluate, false);
	assert.match(consoleService.sessions.find(console => console.id === parent.id)!.output, /parent output\nchild output/);
	using localization = toDisposable(resetNlsResolver);
	initializeTestLocalization('zh-CN');
	await assert.rejects(debug.startDebugging({ id: 'late', name: 'Late', type: 'example', request: 'launch', adapter: { program: '/adapter', arguments: [] }, arguments: {} }, { parentSession: parent }), { message: '父调试会话已结束。' });
	assert.equal(processes.started.length, 3);
	assert.deepEqual(descriptorParents, [undefined, parent.id, parent.id]);
	assert.deepEqual(trackerParents, [undefined, parent.id, parent.id]);
});

test('a parent ending during child descriptor preparation cancels the child and releases a late inline resource', async () => {
	using resources = new DisposableStore();
	const root = URI.file('/workspace');
	using tasks = new FakeTaskService();
	using processes = new FakeDebugAdapterProcessService();
	using adapters = new DebugAdapterFactoryRegistry();
	using debug = createDebugService(resources, new FakeFileService(root), workspaceService(root), processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
	const parent = await debug.startDebugging({ id: 'parent', name: 'Parent', type: 'example', request: 'launch', adapter: { program: '/adapter', arguments: [] }, arguments: {} });
	const entered = new DeferredPromise<AbortSignal>();
	const descriptor = new DeferredPromise<NonNullable<IDebugConfiguration['adapter']>>();
	const released = new DeferredPromise<void>();
	let releases = 0;
	resources.add(adapters.registerFactories([{ type: 'pending-child', label: 'Pending child', sourceId: 'host', createDebugAdapterDescriptor: (_configuration, signal) => { void entered.complete(signal); return descriptor.p; } }]));
	const ended: string[] = [];
	resources.add(debug.onDidEndSession(session => ended.push(session.name)));
	const starting = assert.rejects(debug.startDebugging({ id: 'child', name: 'Child', type: 'pending-child', request: 'launch', arguments: {} }, { parentSession: parent, lifecycleManagedByParent: true }), error => isCancellationError(error));
	const signal = await entered.p;
	await debug.stop(parent);
	await starting;
	assert.equal(signal.aborted, true);
	await descriptor.complete({
		arguments: [], inline: {
			async send() { throw new Error('A retired child cannot send DAP messages'); },
			async read() { throw new Error('A retired child cannot read DAP messages'); },
			async close() { releases++; void released.complete(undefined); },
		}
	});
	await released.p;
	assert.deepEqual({ sessions: debug.sessions, spawned: processes.started.length, ended: ended.sort(), releases }, { sessions: [], spawned: 1, ended: ['Child', 'Parent'], releases: 1 });
});

for (const hasOpenFolder of [true, false]) {
	test(`extension folderless launches retain no workspace binding with an open folder ${hasOpenFolder}`, async () => {
		using resources = new DisposableStore();
		const root = URI.file('/workspace');
		using workspace = new WorkspaceContextService(hasOpenFolder ? { id: 'workspace', uri: root } : { id: 'empty' });
		using tasks = new FakeTaskService();
		using processes = new FakeDebugAdapterProcessService();
		processes.requestHandler = request => request.command === 'initialize' ? { supportsConfigurationDoneRequest: true }
			: request.command === 'stackTrace' ? { stackFrames: [{ id: 0, name: 'main', line: 1, column: 1, source: { path: 'C:\\outside\\app.ts' } }] } : {};
		using adapters = new DebugAdapterFactoryRegistry();
		const factoryFolders: unknown[] = [];
		resources.add(adapters.registerFactories([createExtensionHostDebugAdapterFactory('example', 'host', async (_operation, payload) => {
			const value = payload as { configuration: { program: string; }; session: { workspaceFolder: unknown; }; };
			factoryFolders.push(value.session.workspaceFolder);
			assert.equal(value.configuration.program, '/execution/home/app');
			return { program: '/execution/home/adapter', arguments: [] };
		}, workspace)]));
		using debug = createDebugService(resources, new FakeFileService(root), workspace, processes, {} as ITerminalService, new TestStorageService(), tasks, adapters);
		const providerFolders: unknown[] = [];
		resources.add(debug.registerDebugConfigurationProviders([{
			id: 'provider', type: 'example', triggerKind: DebugConfigurationProviderTriggerKind.Initial,
			resolveDebugConfiguration: (folder, configuration) => { providerFolders.push(folder); return configuration; },
			resolveDebugConfigurationWithSubstitutedVariables: (folder, configuration) => { providerFolders.push(folder); return configuration; },
		}]));
		using services = new InstantiationService(new ServiceCollection([IDebugService, debug], [IWorkspaceContextService, workspace], [IExtensionHostApi, createDisconnectedRendererApi().extensionHost]));
		using bridge = services.createInstance(MainThreadDebugService, 5000, (error: unknown) => { throw error; });
		const signal = new AbortController().signal;
		await bridge.handle({ operation: 'startDebugging', folder: null, configuration: { name: 'Folderless', type: 'example', request: 'launch', program: '${env:HOME}/app' } }, signal);
		const session = debug.session!;
		assert.equal(session.configuration.dirId, null);
		assert.deepEqual(processes.started, [{ program: '/execution/home/adapter', arguments: [] }]);
		assert.deepEqual(providerFolders, [undefined, undefined]);
		assert.deepEqual(factoryFolders, [null]);
		const listed = await bridge.handle({ operation: 'listDebugSessions' }, signal);
		if (listed.result !== 'debugSessions') throw new Error('Session snapshot is unavailable');
		assert.equal((listed.sessions[0] as { workspaceFolder: unknown; }).workspaceFolder, null);
		assert.equal((await session.stackTrace(1))[0].source?.resource?.toString(), 'file:///C:/outside/app.ts');
		const restarted = await debug.restart(session);
		assert.equal(restarted.configuration.dirId, null);
		assert.deepEqual(factoryFolders, [null, null]);
		await debug.stop(restarted);
		using localization = toDisposable(resetNlsResolver);
		initializeTestLocalization('zh-CN');
		await assert.rejects(bridge.handle({ operation: 'startDebugging', folder: null, configuration: { name: 'Needs folder', type: 'example', request: 'launch', program: '${workspaceFolder}/app' } }, signal), { message: '无法解析“workspaceFolder”：请打开或选择所引用的工作区文件夹。' });
		assert.equal(processes.started.length, 2);
		assert.deepEqual(debug.sessions, []);
	});
}

suite('DAP reverse startDebugging through the real session owner', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const scenario of ['child starts', 'child fails', 'parent fails'] as const) {
		test(`${scenario} while the parent launch awaits the reverse response`, async () => {
			using resources = new DisposableStore();
			using localization = toDisposable(resetNlsResolver);
			initializeTestLocalization('zh-CN');
			const services = workbenchInstantiationService(resources);
			const root = URI.file('/workspace');
			const workspace = services.get(IWorkspaceContextService);
			services.registerInstance(IFileService, resources.add(createTestFileService(new FakeFileService(root))));
			services.registerInstance(IPathService, new BrowserPathService(createDisconnectedRendererApi(), workspace));
			services.registerSingleton(ICommandService, () => new CommandService(services));
			services.registerInstance(ILogService, new NullLoggerService());
			services.registerInstance(IContextKeyService, resources.add(new ContextKeyService()));
			services.registerInstance(IMarkerService, resources.add(new MarkerService()));
			registerTestExtensionService(resources, services);
			registerTestWorkbenchInteractionServices(resources, services);
			services.registerInstance(ITerminalProcessService, createDisconnectedRendererApi().terminal);
			services.registerInstance(IConfigurationResolverService, resources.add(services.createInstance(ConfigurationResolverService)));
			services.registerInstance(ITerminalService, resources.add(services.createInstance(TerminalService)));
			services.registerInstance(ITaskService, resources.add(services.createInstance(TaskService)));
			const peer = resources.add(new FakeDebugAdapterProcessService());
			services.registerInstance(IDebugAdapterProcessService, peer);
			services.registerInstance(IDebugAdapterFactorySource, resources.add(new DebugAdapterFactoryRegistry()));
			if (!services.has(IEditorService)) services.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async () => { }, focusActiveEditor() { } });
			if (!services.has(IEditorGroupsService)) services.registerInstance(IEditorGroupsService, {} as IEditorGroupsService);
			const debug = resources.add(services.createInstance(DebugService));
			const ended: string[] = [];
			resources.add(debug.onDidEndSession(session => ended.push(session.name)));
			const reply = new DeferredPromise<Record<string, unknown>>();
			resources.add(peer.reverseResponses.event(({ sessionId, response }) => {
				assert.equal(sessionId, 'debug-1');
				if (!reply.isSettled) void reply.complete(response);
			}));
			peer.requestHandler = async request => {
				if (request.command === 'initialize') return { supportsConfigurationDoneRequest: true };
				const args = request.arguments as Record<string, unknown> | undefined;
				if (request.command === 'launch' && args?.marker === 'parent') {
					peer.reverseRequest('debug-1', { request: 'attach', configuration: { type: 'wrong', name: 'Child', marker: 'child', literal: '$HOME' } });
					await reply.p;
					if (scenario === 'parent fails') throw new Error('parent launch failed');
				}
				if (request.command === 'attach' && scenario === 'child fails') throw new Error('child attach failed');
				return {};
			};
			const starting = debug.startDynamicDebugging(root, { name: 'Parent', type: 'example', request: 'launch', debugAdapter: { program: 'adapter' }, marker: 'parent' }, { noDebug: true });
			if (scenario === 'parent fails') {
				await assert.rejects(starting, /parent launch failed/);
				assert.deepEqual({ sessions: debug.sessions, processes: peer.started.length - peer.closed.length, ended }, { sessions: [], processes: 0, ended: ['Child', 'Parent'] });
			} else {
				const parent = await starting;
				const child = debug.sessions.find(session => session !== parent);
				assert.equal(Boolean(child), scenario === 'child starts');
				if (child) {
					assert.equal(child.parentSession, parent);
					assert.deepEqual(child.sessionOptions, { parentSession: parent });
					assert.equal(child.configuration.dirId, null);
					assert.equal(child.resolvedConfiguration?.type, 'example');
					assert.deepEqual(peer.requestsBySession.get('debug-2')!.find(request => request.command === 'attach')!.arguments, { marker: 'child', literal: '$HOME', noDebug: true });
					await debug.stop(child);
					assert.deepEqual(debug.sessions, [parent], 'child lifecycle uses the public independent default');
				}
				const invalid = new DeferredPromise<Record<string, unknown>>();
				resources.add(peer.reverseResponses.event(({ response }) => { if (!invalid.isSettled) void invalid.complete(response); }));
				peer.reverseRequest('debug-1', { request: 'invalid', configuration: {} });
				const invalidResponse = await invalid.p;
				assert.deepEqual({ success: invalidResponse.success, message: invalidResponse.message }, { success: false, message: 'startDebugging 请求必须指定 launch 或 attach。' });
				assert.equal(peer.started.length, 2);
				await debug.stop(parent);
				assert.equal(peer.started.length - peer.closed.length, 0);
				assert.deepEqual([...peer.closed].sort(), ['debug-1', 'debug-2']);
			}
			const response = await reply.p;
			assert.deepEqual({ command: response.command, sequence: response.request_seq, success: response.success, body: response.body }, { command: 'startDebugging', sequence: 11, success: scenario !== 'child fails', body: undefined });
			assert.equal(peer.requestsBySession.get('debug-1')!.find(request => request.command === 'initialize')!.arguments && (peer.requestsBySession.get('debug-1')!.find(request => request.command === 'initialize')!.arguments as Record<string, unknown>).supportsStartDebuggingRequest, true);
		});
	}
});
