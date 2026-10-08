import { type IFileSystemProvider, type IFileWriteOptions, FileSystemProviderCapabilities } from '../../../../../platform/files/common/files.js';
import { createTestFileService } from '../../../../test/common/testEditorServices.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { DisposableStore, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { IOutputService } from '../../../output/common/output.js';
import assert from "node:assert/strict";
import { suite, test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { ITerminalProcessService } from '../../../../../platform/terminal/common/terminal.js';
import { TerminalService } from '../../../../contrib/terminal/browser/terminalService.js';
import { initializeTestLocalization } from '../../../localization/test/common/localizationTestUtils.js';
import { Emitter, Event } from "../../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import { URI } from "../../../../../base/common/uri.js";
import { FileKind, FileNotFoundError, type IFileBytes, IFileService, type IFileStat, type IFileWriteResult } from "../../../../../platform/files/common/files.js";
import { IWorkspaceContextService } from "../../../../../platform/workspace/common/workspace.js";
import { type ITerminalCommandStatusEvent, type ITerminalCreateOptions, type ITerminalDimensions, type ITerminalInstance, type ITerminalProfile, ITerminalService, type TerminalInstanceState } from "../../../../contrib/terminal/browser/terminal.js";
import { TaskService } from "../../../../contrib/tasks/browser/taskService.js";

test("TaskService discovers tasks, writes one terminal command, and tracks its exit", async () => {
	const root = URI.file("C:\\project");
	const files = new FakeFileService(root, {
		".vscode/tasks.json": '{"version":"2.0.0","tasks":[{"label":"Lint","command":"cargo lint","group":"build"}]}',
		"package.json": '{"scripts":{"test":"node --test"}}',
		"pnpm-lock.yaml": "lockfileVersion: 9",
		"Cargo.toml": "[workspace]",
	});
	const workspace: IWorkspaceContextService = {
		onDidChangeWorkspace: Event.None,
		getWorkspace: () => ({ id: "workspace", folders: [{ id: "workspace", uri: root, name: "project", index: 0 }] }),
		getWorkbenchState: () => 2,
		getWorkspaceFolder: () => null,
	};
	using terminals = new FakeTerminalService();
	using outputResources = new DisposableStore();
	const services = taskServices(outputResources, files, workspace, terminals);
	const output = services.get(IOutputService);
	using service = services.createInstance(TaskService);
	const tasks = await service.refresh();
	assert.deepEqual(tasks.map(task => task.id), ["cargo:build", "cargo:check", "vscode:0:lint", "cargo:test", "pnpm:test", "cargo:run"]);

	const task = tasks.find(candidate => candidate.id === "vscode:0:lint")!;
	const run = await service.run(task);
	const terminal = terminals.instances[0] as FakeTerminalInstance;
	assert.equal(run.terminalId, terminal.id);
	assert.equal(terminal.title, "Task: Lint");
	assert.deepEqual(terminal.writes, ["cargo lint\r"]);
	assert.equal(run.status, "running");
	terminal.command({ commandId: "command-1", status: "running", exitCode: undefined });
	terminal.command({ commandId: "command-1", status: "failed", exitCode: 2 });
	assert.equal(run.status, "failed");
	assert.equal(run.exitCode, 2);
	assert.equal(service.activeRuns.length, 0);
	assert.equal(service.lastRun, run);
	assert.match(output.getChannel("tasks")?.getText() ?? "", /Discovered 6 workspace task/);
	assert.match(output.getChannel("tasks")?.getText() ?? "", /Task 'Lint' failed \(exit code 2\)/);
	assert.doesNotMatch(output.getChannel("tasks")?.getText() ?? "", /cargo lint/);

	const secondRun = await service.run(task);
	await service.terminate(secondRun);
	assert.equal(secondRun.status, "canceled");
});

test("TaskService atomically owns dynamic providers and merges their tasks on refresh", async () => {
	const root = URI.file("C:\\project");
	const files = new FakeFileService(root, { ".vscode/tasks.json": '{"version":"2.0.0","tasks":[{"label":"Build","command":"build","group":"build"}]}' });
	const workspace: IWorkspaceContextService = {
		onDidChangeWorkspace: Event.None,
		getWorkspace: () => ({ id: "workspace", folders: [{ id: "workspace", uri: root, name: "project", index: 0 }] }),
		getWorkbenchState: () => 2,
		getWorkspaceFolder: () => null,
	};
	using terminals = new FakeTerminalService();
	using resources = new DisposableStore();
	using service = taskServices(resources, files, workspace, terminals).createInstance(TaskService);
	const registration = service.registerTaskProviders([{ id: "demo.provider", provideTasks: () => [{ id: "verify", label: "Verify", command: "demo --verify", group: "test" }] }]);

	assert.deepEqual((await service.refresh()).map(task => [task.id, task.source]), [["vscode:0:build", "vscode"], ["extension:demo.provider:verify", "extension"]]);
	const revokedTask = service.tasks.find(task => task.source === "extension")!;
	registration.replace([{ id: "demo.provider", provideTasks: () => [{ id: "run", label: "Run", command: "demo", group: "run" }] }]);
	assert.deepEqual(service.tasks.map(task => task.id), ["vscode:0:build"]);
	await assert.rejects(service.run(revokedTask), /no longer present/);
	await service.refresh();
	assert.deepEqual(service.tasks.map(task => task.id), ["vscode:0:build", "extension:demo.provider:run"]);

	assert.throws(() => service.registerTaskProvider({ id: "demo.provider", provideTasks: () => [] }), /already registered/);
	assert.deepEqual(service.tasks.map(task => task.id), ["vscode:0:build", "extension:demo.provider:run"]);
	const disposedTask = service.tasks.find(task => task.source === "extension")!;
	registration.dispose();
	assert.deepEqual(service.tasks.map(task => task.id), ["vscode:0:build"]);
	await assert.rejects(service.run(disposedTask), /no longer present/);
	await service.refresh();
	assert.deepEqual(service.tasks.map(task => task.id), ["vscode:0:build"]);
});

test("TaskService retains the last good task set when a provider refresh fails", async () => {
	const root = URI.file("C:\\project");
	const workspace: IWorkspaceContextService = {
		onDidChangeWorkspace: Event.None,
		getWorkspace: () => ({ id: "workspace", folders: [{ id: "workspace", uri: root, name: "project", index: 0 }] }),
		getWorkbenchState: () => 2,
		getWorkspaceFolder: () => null,
	};
	using terminals = new FakeTerminalService();
	using resources = new DisposableStore();
	using service = taskServices(resources, new FakeFileService(root, {}), workspace, terminals).createInstance(TaskService);
	let fail = false;
	using registration = service.registerTaskProvider({ id: "stable", provideTasks: () => { if (fail) throw new Error("provider failed"); return [{ id: "test", label: "Test", command: "test", group: "test" }]; } });
	await service.refresh();
	const previous = service.tasks;

	fail = true;
	await assert.rejects(service.refresh(), /provider failed/);

	assert.equal(service.tasks, previous);
	assert.deepEqual(service.tasks.map(task => task.id), ["extension:stable:test"]);
});

class FakeFileService implements IFileSystemProvider {
	public readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy;
	public readonly onDidChangeCapabilities = Event.None;
	public watch(): IDisposable { return Disposable.None; }

	readonly onDidChangeFiles = Event.None;
	constructor(private readonly root: URI, private readonly files: Readonly<Record<string, string>>) { }
	async stat(resource: URI) { const path = this.relative(resource); if (!(path in this.files)) throw new FileNotFoundError(resource); return { resource, kind: FileKind.File, sizeBytes: this.files[path]!.length, readonly: false, modifiedAtMillis: undefined }; }
	async readDirectory() { return []; }
	async readFile(resource: URI): Promise<IFileBytes> { const path = this.relative(resource); if (!(path in this.files)) throw new FileNotFoundError(resource); return { resource, bytes: new TextEncoder().encode(this.files[path]!), revision: "1" }; }
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
	private relative(resource: URI): string { return resource.path.slice(this.root.path.length + 1); }
}

class FakeTerminalService extends Disposable implements ITerminalService {
	private readonly createEmitter = this._register(new Emitter<ITerminalInstance>());
	readonly instances: FakeTerminalInstance[] = [];
	activeInstance: ITerminalInstance | undefined;
	readonly onDidCreateInstance = this.createEmitter.event;
	readonly onDidDisposeInstance = Event.None;
	readonly onDidChangeInstances = Event.None;
	readonly onDidChangeActiveInstance = Event.None;
	async getProfiles(): Promise<readonly ITerminalProfile[]> { return [{ profileId: "command-prompt", title: "Command Prompt", isDefault: true }]; }
	async createTerminal(options: ITerminalCreateOptions): Promise<ITerminalInstance> { const terminal = this._register(new FakeTerminalInstance(`terminal-${this.instances.length + 1}`, options.dirId ?? "folder", options.title ?? "Terminal")); this.instances.push(terminal); this.activeInstance = terminal; this.createEmitter.fire(terminal); return terminal; }
	async relaunchTerminal() { }
	setActiveInstance(instance: ITerminalInstance | undefined) { this.activeInstance = instance; }
	moveTerminal() { }
	async closeTerminal(instance: ITerminalInstance) { await instance.close(); }
}

class FakeTerminalInstance extends Disposable implements ITerminalInstance {
	readonly processId = 1234;
	readonly initialCwd = '/backend/workspace';
	async processBinary(): Promise<void> { throw new Error('Binary input is not used in task tests'); }
	readonly profile = { profileId: "command-prompt", title: "Command Prompt", isDefault: true };
	readonly writes: string[] = [];
	state: TerminalInstanceState = "running";
	exitCode: number | undefined;
	private readonly commandEmitter = this._register(new Emitter<ITerminalCommandStatusEvent>());
	readonly onDidWriteData = Event.None;
	readonly onDidChangeCommandStatus = this.commandEmitter.event;
	readonly onDidExit = Event.None;
	readonly onDidChangeState = Event.None;
	constructor(readonly id: string, readonly dirId: string, readonly title: string) { super(); }
	async sendText(data: string, shouldExecute: boolean): Promise<void> { this.writes.push(data + (shouldExecute ? '\r' : '')); }
	readonly xterm = undefined;
	readonly xtermReadyPromise = Promise.resolve(undefined);
	getContribution(): null { return null; }
	attachToElement(): void { throw new Error('Task test has no terminal view'); }
	detachFromElement(): void { }
	resize(_dimensions: ITerminalDimensions): void { }
	async close(): Promise<void> { this.state = "exited"; }
	command(event: ITerminalCommandStatusEvent): void { this.commandEmitter.fire(event); }
}

function taskServices(owner: DisposableStore, files: IFileSystemProvider, workspace: IWorkspaceContextService, terminals: ITerminalService): InstantiationService {
	return workbenchInstantiationService(owner).createChild(new ServiceCollection([IFileService, owner.add(createTestFileService(files))], [IWorkspaceContextService, workspace], [ITerminalService, terminals], [ILogService, new NullLoggerService()]), owner);
}

test('TaskService rejects a missing terminal registration before opening its Output channel', () => {
	using resources = new DisposableStore();
	const parent = workbenchInstantiationService(resources);
	const services = parent.createChild(new ServiceCollection([IFileService, resources.add(createTestFileService(new FakeFileService(URI.file('/workspace'), {})))], [ILogService, new NullLoggerService()]), resources);
	assert.throws(() => services.createInstance(TaskService), /Unknown service: terminalService/);
	assert.equal(parent.get(IOutputService).getChannel('tasks'), undefined);
});

suite('TaskService terminal availability', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const outcome of ['acknowledge', 'reject', 'cancel'] as const) {
		test(`task dispatch waits for process input and handles ${outcome}`, async () => {
			using localization = toDisposable(resetNlsResolver);
			initializeTestLocalization(outcome === 'reject' ? 'zh-CN' : 'en');
			using resources = new DisposableStore();
			const acknowledgement = new DeferredPromise<void>();
			const submitted = new DeferredPromise<void>();
			const root = URI.file('/workspace');
			const calls: string[] = [];
			const processes: ITerminalProcessService = {
				getConnectionState: async () => 'ready', onConnectionState: Event.None,
				listProfiles: async () => [{ profileId: 'shell', title: 'Shell', isDefault: true }],
				create: async () => ({ ready: { pid: 1234, cwd: '/workspace' }, terminalId: 'task-process', profile: { profileId: 'shell', title: 'Shell', isDefault: true }, connectionPersistence: 'connectionOwned' }),
				read: async () => ({ terminalId: 'task-process', commandEventGap: false, chunks: [], nextSequence: 0, commandEvents: [], nextCommandSequence: 0, exited: false, exitCode: undefined, outputGap: false }),
				write: async () => { calls.push('write'); void submitted.complete(undefined); await acknowledgement.p; },
				resize: async () => { }, close: async () => { calls.push('close'); if (outcome === 'reject') throw new Error('task close rejected'); },
			};
			const workspace: IWorkspaceContextService = { onDidChangeWorkspace: Event.None, getWorkspace: () => ({ id: 'workspace', folders: [{ id: 'workspace', uri: root, name: 'Workspace', index: 0 }] }), getWorkbenchState: () => 2, getWorkspaceFolder: () => null };
			const logs: string[] = [];
			const output = { createChannel: () => ({ ...Disposable.None, appendLine: (entry: { text: string; }) => { logs.push(entry.text); } }) } as unknown as IOutputService;
			const services = resources.add(new InstantiationService(new ServiceCollection(
				[IFileService, resources.add(createTestFileService(new FakeFileService(root, {})))], [IWorkspaceContextService, workspace],
				[ITerminalProcessService, processes], [IOutputService, output], [ILogService, new NullLoggerService()],
			)));
			const terminals = resources.add(services.createInstance(TerminalService));
			services.registerInstance(ITerminalService, terminals);
			const tasks = resources.add(services.createInstance(TaskService));
			resources.add(tasks.registerTaskProvider({ id: 'test', provideTasks: () => [{ id: 'check', label: 'Check', command: 'check', group: 'build' }] }));
			await tasks.refresh();
			let finished = false;
			const run = tasks.run(tasks.tasks[0]).finally(() => { finished = true; });
			const failure = new Error('task input rejected');
			const result = outcome === 'acknowledge' ? run : assert.rejects(run, outcome === 'cancel' ? isCancellationError : error => error === failure);
			await submitted.p;
			assert.equal(finished, false);
			if (outcome === 'acknowledge') void acknowledgement.complete(undefined);
			else if (outcome === 'reject') void acknowledgement.error(failure);
			else await tasks.terminate(tasks.activeRuns[0]);
			await result;
			assert.deepEqual({ status: tasks.lastRun?.status, active: tasks.activeRuns.length, terminals: terminals.instances.length, calls }, {
				status: outcome === 'acknowledge' ? 'running' : outcome === 'reject' ? 'failed' : 'canceled',
				active: outcome === 'acknowledge' ? 1 : 0, terminals: outcome === 'acknowledge' ? 1 : 0,
				calls: outcome === 'acknowledge' ? ['write'] : ['write', 'close'],
			});
			if (outcome === 'reject') {
				assert.deepEqual(logs.slice(-2), ['无法发送任务“Check”：task input rejected', '无法关闭任务终端：task close rejected']);
			}
			if (outcome === 'cancel') void acknowledgement.complete(undefined);
		});
	}

	for (const persistence of ['connectionOwned', 'reconnectable'] as const) {
		test(`rejects a ${persistence} terminal that cannot accept the task command`, async () => {
			using localization = toDisposable(resetNlsResolver);
			initializeTestLocalization(persistence === 'reconnectable' ? 'zh-CN' : 'en');
			using resources = new DisposableStore();
			const root = URI.file('/workspace');
			const calls: string[] = [];
			const processes: ITerminalProcessService = {
				getConnectionState: async () => 'crashed',
				onConnectionState: () => Disposable.None,
				listProfiles: async () => [{ profileId: 'shell', title: 'Shell', isDefault: true }],
				create: async () => ({ ready: { pid: 1234, cwd: '/backend/workspace' }, terminalId: 'task-process', profile: { profileId: 'shell', title: 'Shell', isDefault: true }, connectionPersistence: persistence }),
				read: async () => { throw new Error('Disconnected terminal must not poll'); },
				write: async () => { calls.push('write'); },
				resize: async () => { },
				close: async options => { calls.push(`close:${options.terminalId}`); },
			};
			const workspace: IWorkspaceContextService = {
				onDidChangeWorkspace: Event.None,
				getWorkspace: () => ({ id: 'workspace', folders: [{ id: 'workspace', uri: root, name: 'Workspace', index: 0 }] }),
				getWorkbenchState: () => 2,
				getWorkspaceFolder: () => null,
			};
			const output = { createChannel: () => ({ ...Disposable.None, appendLine: () => { } }) } as unknown as IOutputService;
			const services = resources.add(new InstantiationService(new ServiceCollection(
				[IFileService, resources.add(createTestFileService(new FakeFileService(root, {})))],
				[IWorkspaceContextService, workspace],
				[ITerminalProcessService, processes],
				[IOutputService, output],
				[ILogService, new NullLoggerService()],
			)));
			const terminals = resources.add(services.createInstance(TerminalService));
			services.registerInstance(ITerminalService, terminals);
			const tasks = resources.add(services.createInstance(TaskService));
			resources.add(tasks.registerTaskProvider({ id: 'test', provideTasks: () => [{ id: 'check', label: 'Check', command: 'check', group: 'build' }] }));
			await tasks.refresh();
			let starts = 0;
			resources.add(tasks.onDidStartTask(() => { starts++; }));
			await assert.rejects(tasks.run(tasks.tasks[0]), {
				message: persistence === 'reconnectable' ? '终端不可用，任务尚未启动。请重新运行任务。' : 'The terminal is unavailable. The task was not started. Run the task again.',
			});
			assert.deepEqual({ calls, starts, active: tasks.activeRuns, last: tasks.lastRun, terminals: terminals.instances }, {
				calls: ['close:task-process'], starts: 0, active: [], last: undefined, terminals: [],
			});
		});
	}
});
