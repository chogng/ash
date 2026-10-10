import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IFileSearchService, type FileSearchResult } from '../../../../../platform/search/common/fileSearch.js';
import { BrowserFileSearchService } from '../../../../../platform/search/browser/browserFileSearchService.js';
import { MainThreadTask } from '../../../../api/browser/mainThreadTask.js';
import { IExtensionHostApi, type ExtensionHostFleetSnapshot, type JsonValue } from '../../../../../platform/extensionHost/common/extensionHostApi.js';
import { registerTestExtensionService } from '../../../../test/common/testExtensionServices.js';
import { ExtensionResourceLoaderService } from '../../../../../platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { WorkbenchConfigurationService } from '../../../configuration/browser/configurationService.js';
import { createHash } from 'node:crypto';
import { IExtensionService } from '../../../extensions/common/extensionService.js';
import type { IExtensionApi } from '../../../../../platform/extensions/common/extensionApi.js';
import { IPathService } from '../../../../../platform/path/common/pathService.js';
import { BrowserPathService } from '../../../path/browser/pathService.js';
import { createDisconnectedRendererApi } from '../../../../../platform/agentHost/browser/rendererApi.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { createExtensionHostTaskProvider } from '../../../../api/browser/extensionHostWorkflowBridge.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { CommandService } from '../../../commands/common/commandService.js';
import { WorkspaceContextService } from '../../../workspaces/browser/workspaceContextService.js';
import { ConfigurationResolverService } from '../../../configurationResolver/browser/configurationResolverService.js';
import { IConfigurationResolverService } from '../../../configurationResolver/common/configurationResolver.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { type IFileSystemProvider, type IFileWriteOptions, type IFileChangeEvent, FileSystemProviderCapabilities } from '../../../../../platform/files/common/files.js';
import { createTestFileService } from '../../../../test/common/testEditorServices.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { registerTestWorkbenchInteractionServices, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { DisposableStore, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { IOutputService } from '../../../output/common/output.js';
import assert from "node:assert/strict";
import { suite, test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { ITerminalProcessService, type IShellLaunchConfig, type ITerminalProcessReadResult, type TerminalProcessExecution } from '../../../../../platform/terminal/common/terminal.js';
import { TerminalService } from '../../../../contrib/terminal/browser/terminalService.js';
import { initializeTestLocalization } from '../../../localization/test/common/localizationTestUtils.js';
import { Emitter, Event } from "../../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import { URI } from "../../../../../base/common/uri.js";
import { FileKind, FileNotFoundError, type IFileBytes, IFileService, type IFileStat, type IFileWriteResult } from "../../../../../platform/files/common/files.js";
import { IWorkspaceContextService } from "../../../../../platform/workspace/common/workspace.js";
import { type ITerminalCommandStatusEvent, type ITerminalCreateOptions, type ITerminalDimensions, type ITerminalInstance, type ITerminalProfile, ITerminalService, type TerminalInstanceState } from "../../../../contrib/terminal/browser/terminal.js";
import { TaskService } from "../../../../contrib/tasks/browser/taskService.js";
import '../../../../contrib/accessibilitySignals/browser/accessibilitySignal.contribution.js';
import { IAccessibilitySignalService } from '../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { ITaskService, type ITaskRun, type TaskProviderTask } from '../../common/taskService.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import { mock } from 'node:test';

suite('Workspace task progress signals', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('shares a delayed cue across tasks and stops on completion, cancellation, and window disposal', async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		using resources = new DisposableStore();
		try {
			const root = URI.file('/project');
			const workspace: IWorkspaceContextService = {
				onDidChangeWorkspace: Event.None,
				getWorkspace: () => ({ id: 'workspace', folders: [{ id: 'workspace', uri: root, name: 'project', index: 0 }] }),
				getWorkbenchState: () => 2, getWorkspaceFolder: () => null,
			};
			const terminals = resources.add(new FakeTerminalService());
			const services = taskServices(resources, new FakeFileService(root, {}), workspace, terminals);
			const tasks = resources.add(services.createInstance(TaskService));
			services.registerInstance(ITaskService, tasks);
			const cues: string[] = [];
			const results: string[] = [];
			services.registerInstance(IAccessibilitySignalService, {
				playSignal: async signal => { results.push(signal.settingsKey); },
				playSignalLoop: () => { cues.push('started'); return toDisposable(() => cues.push('stopped')); },
			});
			using provider = tasks.registerTaskProvider({ id: 'progress-test', provideTasks: () => [{ id: 'watch', label: 'Watch', command: 'watch', group: 'build' }, { id: 'watch-second', label: 'Watch second', command: 'watch', group: 'build' }] });
			await tasks.refresh();
			using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.taskProgressAccessibility']);
			host.advance(WorkbenchPhase.AfterRestored);
			assert.deepEqual(cues, [], 'discovery is quiet');
			const first = await tasks.run(tasks.tasks[0]);
			mock.timers.tick(4999);
			assert.deepEqual(cues, []);
			const second = await tasks.run(tasks.tasks[1]);
			mock.timers.tick(1);
			assert.deepEqual(cues, ['started']);
			terminals.instances[0].command({ commandId: 'first', status: 'running', exitCode: undefined });
			terminals.instances[0].command({ commandId: 'first', status: 'succeeded', exitCode: 0 });
			assert.equal(first.status, 'succeeded');
			assert.deepEqual(results, ['accessibility.signals.taskCompleted']);
			assert.deepEqual(cues, ['started'], 'the other task retains the cue');
			await tasks.terminate(second);
			assert.deepEqual(cues, ['started', 'stopped']);
			const quick = await tasks.run(tasks.tasks[0]);
			await tasks.terminate(quick);
			mock.timers.tick(10000);
			assert.deepEqual(cues, ['started', 'stopped'], 'short tasks never start a cue');
			assert.deepEqual(results, ['accessibility.signals.taskCompleted'], 'cancellation does not announce success or failure');
			const failed = await tasks.run(tasks.tasks[0]);
			const failedTerminal = terminals.instances.find(terminal => terminal.id === failed.terminalId)!;
			failedTerminal.command({ commandId: 'failed', status: 'running', exitCode: undefined });
			failedTerminal.command({ commandId: 'failed', status: 'failed', exitCode: 1 });
			assert.deepEqual(results, ['accessibility.signals.taskCompleted', 'accessibility.signals.taskFailed']);
			await tasks.run(tasks.tasks[0]);
			mock.timers.tick(5000);
			host.dispose();
			mock.timers.tick(10000);
			assert.deepEqual(cues, ['started', 'stopped', 'started', 'stopped']);
		} finally { mock.timers.reset(); }
	});
});

import { IMarkerService, MarkerService } from '../../../../../platform/markers/common/markers.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { waitForTask } from '../../common/taskService.js';
import { JSDOM } from 'jsdom';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { WorkbenchQuickInputService } from '../../../quickinput/browser/quickInputService.js';

test("TaskService discovers tasks, creates a shell execution, and tracks its exit", async () => {
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
	assert.deepEqual({ execution: terminal.execution, writes: terminal.writes }, { execution: { type: 'shell', commandLine: 'cargo lint' }, writes: [] });
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

test('concurrent dispatch shares one pending task and a canceled joiner does not stop its owner', async () => {
	using resources = new DisposableStore();
	using terminals = new FakeTerminalService();
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	using service = taskServices(resources, new FakeFileService(URI.file('/workspace'), { '.vscode/tasks.json': '{"version":"2.0.0","tasks":[{"label":"Check","command":"check","runOptions":{"instancePolicy":"silent"}}]}' }), workspace, terminals).createInstance(TaskService);
	const task = (await service.refresh())[0];
	const creating = new DeferredPromise<void>();
	const release = new DeferredPromise<void>();
	const create = terminals.createTerminal.bind(terminals);
	let creations = 0;
	terminals.createTerminal = async options => {
		creations++;
		void creating.complete(undefined);
		await release.p;
		return create(options);
	};
	const owner = service.run(task);
	await creating.p;
	const cancellation = new AbortController();
	const canceled = assert.rejects(service.run(task, cancellation.signal), isCancellationError);
	const joined = service.run(task);
	// Let all in-memory discovery and validation continuations reach the held
	// process request before releasing it; no elapsed-time assumption is needed.
	await new Promise<void>(resolve => setImmediate(resolve));
	cancellation.abort();
	await canceled;
	assert.equal(creations, 1);
	void release.complete(undefined);
	const [first, second] = await Promise.all([owner, joined]);
	assert.equal(first, second);
	assert.deepEqual({ terminals: terminals.instances.length, status: first.status, execution: terminals.instances[0].execution }, { terminals: 1, status: 'running', execution: { type: 'shell', commandLine: 'check' } });
	await service.terminate(first);
});

test('a failed current refresh rejects a superseded dispatch instead of using the retained catalog', async () => {
	using resources = new DisposableStore();
	using terminals = new FakeTerminalService();
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	using service = taskServices(resources, new FakeFileService(URI.file('/workspace'), { '.vscode/tasks.json': '{"version":"2.0.0","tasks":[{"label":"Check","command":"check"}]}' }), workspace, terminals).createInstance(TaskService);
	const release = new DeferredPromise<void>();
	const discovering = new DeferredPromise<void>();
	let calls = 0;
	resources.add(service.registerTaskProvider({
		id: 'delayed', provideTasks: async () => {
			calls++;
			if (calls === 2) { void discovering.complete(undefined); await release.p; }
			if (calls === 3) throw new Error('current discovery failed');
			return [];
		}
	}));
	const task = (await service.refresh())[0];
	const dispatch = assert.rejects(service.run(task), /current discovery failed/);
	await discovering.p;
	await assert.rejects(service.refresh(), /current discovery failed/);
	void release.complete(undefined);
	await dispatch;
	assert.equal(terminals.instances.length, 0);
});

class FakeFileService implements IFileSystemProvider {
	public readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy;
	public readonly onDidChangeCapabilities = Event.None;
	public watch(): IDisposable { return Disposable.None; }

	constructor(private readonly root: URI, private readonly files: Readonly<Record<string, string>>, readonly onDidChangeFiles: Event<IFileChangeEvent> = Event.None) { }
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
	async createTerminal(options: ITerminalCreateOptions): Promise<ITerminalInstance> { const terminal = this._register(new FakeTerminalInstance(`terminal-${this.instances.length + 1}`, options.dirId ?? "folder", options.title ?? "Terminal")); terminal.execution = options.execution; this.instances.push(terminal); this.activeInstance = terminal; this.createEmitter.fire(terminal); return terminal; }
	async relaunchTerminal() { }
	setActiveInstance(instance: ITerminalInstance | undefined) { this.activeInstance = instance; }
	moveTerminal() { }
	async closeTerminal(instance: ITerminalInstance) { await instance.close(); }
}

class FakeTerminalInstance extends Disposable implements ITerminalInstance {
	clearBuffer(): void { }
	async reuseTerminal(config: IShellLaunchConfig): Promise<void> { this.title = config.name ?? this.title; this.execution = config.execution; this.state = 'running'; this.exitCode = undefined; }
	execution: TerminalProcessExecution | undefined;
	start(): void { }
	readonly processId = 1234;
	readonly initialCwd = '/backend/workspace';
	async processBinary(): Promise<void> { throw new Error('Binary input is not used in task tests'); }
	readonly profile = { profileId: "command-prompt", title: "Command Prompt", isDefault: true };
	readonly writes: string[] = [];
	state: TerminalInstanceState = "running";
	exitCode: number | undefined;
	private readonly commandEmitter = this._register(new Emitter<ITerminalCommandStatusEvent>());
	private readonly dataEmitter = this._register(new Emitter<import('../../../../../platform/terminal/common/terminal.js').IProcessDataEvent>());
	private readonly exitEmitter = this._register(new Emitter<number | undefined>());
	readonly onDidWriteData = this.dataEmitter.event;
	readonly onDidChangeCommandStatus = this.commandEmitter.event;
	readonly onDidExit = this.exitEmitter.event;
	readonly onDidChangeState = Event.None;
	constructor(readonly id: string, readonly dirId: string, public title: string) { super(); }
	async sendText(data: string, shouldExecute: boolean): Promise<void> { this.writes.push(data + (shouldExecute ? '\r' : '')); }
	readonly xterm = undefined;
	readonly xtermReadyPromise = Promise.resolve(undefined);
	getContribution(): null { return null; }
	attachToElement(): void { throw new Error('Task test has no terminal view'); }
	detachFromElement(): void { }
	resize(_dimensions: ITerminalDimensions): void { }
	async close(): Promise<void> { this.state = "exited"; }
	command(event: ITerminalCommandStatusEvent): void { this.commandEmitter.fire(event); }
	output(value: string): void { this.dataEmitter.fire({ data: new TextEncoder().encode(value), trackCommit: false }); }
	exit(code: number | undefined): void { this.exitCode = code; this.state = 'exited'; this.exitEmitter.fire(code); }
}


function taskServices(owner: DisposableStore, files: IFileSystemProvider, workspace: IWorkspaceContextService, terminals: ITerminalService): InstantiationService {
	const parent = workbenchInstantiationService(owner);
	registerTestWorkbenchInteractionServices(owner, parent);
	const services = parent.createChild(new ServiceCollection([IFileService, owner.add(createTestFileService(files))], [IWorkspaceContextService, workspace], [IPathService, new BrowserPathService(createDisconnectedRendererApi(), workspace)], [IConfigurationResolverService, new SyncDescriptor(ConfigurationResolverService)], [ITerminalProcessService, { getEnvironment: async () => ({ HOME: '/execution/home' }) }], [ITerminalService, terminals], [ILogService, new NullLoggerService()]), owner);
	services.registerSingleton(ICommandService, () => new CommandService(services));
	services.registerInstance(IFileSearchService, services.createInstance(BrowserFileSearchService));
	services.registerInstance(IMarkerService, owner.add(new MarkerService()));
	registerTestExtensionService(owner, services);
	return services;
}

for (const canceled of [false, true]) {
	test(`search matcher completion waits for resource lookup and cancellation acknowledgment ${canceled}`, async () => {
		using resources = new DisposableStore();
		using terminals = new FakeTerminalService();
		const root = URI.file('/workspace');
		using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
		const document = { version: '2.0.0', tasks: [{ label: 'Search', type: 'process', command: 'compiler', problemMatcher: { fileLocation: ['search', { include: '${workspaceFolder}/search[work]', exclude: '${workspaceFolder}/search[work]/ignored' }], pattern: { regexp: '^(.+):(\\d+):(\\d+) (.+)$', file: 1, line: 2, column: 3, message: 4 } } }] };
		const baseServices = taskServices(resources, new FakeFileService(root, { '.vscode/tasks.json': JSON.stringify(document) }), workspace, terminals);
		const requested = new DeferredPromise<void>();
		const reply = new DeferredPromise<FileSearchResult>();
		let searchSignal: AbortSignal | undefined;
		const search: IFileSearchService = {
			glob: async (directory, query, signal) => {
				assert.deepEqual(directory, { resource: root, target: { type: 'workspace', dirId: 'workspace' } });
				assert.deepEqual(query, { includePatterns: ['search[[]work]/**/*main.ts'], excludePatterns: ['search[[]work]/ignored'], maxResults: 5000 });
				searchSignal = signal;
				void requested.complete(undefined);
				return reply.p;
			},
			fuzzy: async () => { throw new Error('Problem search requires an exact suffix glob'); },
		};
		const services = baseServices.createChild(new ServiceCollection([IFileSearchService, search]), resources);
		using tasks = services.createInstance(TaskService);
		const [task] = await tasks.refresh();
		const run = await tasks.run(task!);
		terminals.instances[0].output('main.ts:2:3 nested diagnostic\n');
		await requested.p;
		let completed = false;
		void run.completion!.then(() => { completed = true; });
		let termination: Promise<void> | undefined;
		if (canceled) {
			termination = tasks.terminate(run);
			assert.equal(searchSignal?.aborted, true);
		} else {
			terminals.instances[0].exit(0);
			assert.equal(run.status, 'running');
			assert.equal(tasks.activeRuns.length, 1);
		}
		assert.equal(completed, false);
		void reply.complete({ matches: [{ path: 'search[work]/nested/main.ts', resource: URI.file('/workspace/search[work]/nested/main.ts') }], totalMatches: 1 });
		await termination;
		await run.completion;
		assert.deepEqual({ status: run.status, diagnostics: services.get(IMarkerService).getAll().map(marker => ({ path: marker.resource.path, message: marker.message })) }, {
			status: canceled ? 'canceled' : 'succeeded', diagnostics: canceled ? [] : [{ path: '/workspace/search[work]/nested/main.ts', message: 'nested diagnostic' }],
		});
	});
}

test('background search readiness waits for diagnostics before launching a dependency', async () => {
	using resources = new DisposableStore();
	using terminals = new FakeTerminalService();
	const root = URI.file('/workspace');
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
	const document = { version: '2.0.0', tasks: [
		{ label: 'Watch', type: 'process', command: 'compiler', isBackground: true, problemMatcher: { fileLocation: 'search', severity: 'warning', pattern: { regexp: '^(.+):(\\d+):(\\d+) (.+)$', file: 1, line: 2, column: 3, message: 4 }, background: { activeOnStart: true, beginsPattern: '^BUILD$', endsPattern: '^READY$' } } },
		{ label: 'After search', command: 'after', dependsOn: 'Watch' },
	] };
	const baseServices = taskServices(resources, new FakeFileService(root, { '.vscode/tasks.json': JSON.stringify(document) }), workspace, terminals);
	const requested = new DeferredPromise<void>();
	const reply = new DeferredPromise<FileSearchResult>();
	const search: IFileSearchService = { glob: async () => { void requested.complete(undefined); return reply.p; }, fuzzy: async () => { throw new Error('unused'); } };
	const services = baseServices.createChild(new ServiceCollection([IFileSearchService, search]), resources);
	using tasks = services.createInstance(TaskService);
	await tasks.refresh();
	const started = new DeferredPromise<void>();
	using listener = tasks.onDidStartTask(run => { if (run.task.label === 'Watch') void started.complete(undefined); });
	const launching = tasks.run(tasks.tasks.find(task => task.label === 'After search')!);
	await started.p;
	terminals.instances[0].output('BUILD\nmain.ts:2:3 diagnostic\nREADY\n');
	await requested.p;
	assert.equal(terminals.instances.length, 1);
	assert.equal(tasks.activeRuns[0].isReady, false);
	void reply.complete({ matches: [{ path: 'nested/main.ts', resource: URI.file('/workspace/nested/main.ts') }], totalMatches: 1 });
	const dependent = await launching;
	assert.deepEqual({ terminals: terminals.instances.map(value => value.title), diagnostics: services.get(IMarkerService).getAll().map(value => value.resource.path) }, { terminals: ['Task: Watch', 'Task: After search'], diagnostics: ['/workspace/nested/main.ts'] });
	await tasks.terminate(dependent);
});

test('search failure waits for terminal release before completing a failed task', async () => {
	using resources = new DisposableStore();
	using terminals = new FakeTerminalService();
	const root = URI.file('/workspace');
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
	const document = { version: '2.0.0', tasks: [{ label: 'Search', type: 'process', command: 'compiler', problemMatcher: { fileLocation: 'search', pattern: { regexp: '^(.+):(\\d+):(\\d+) (.+)$', file: 1, line: 2, column: 3, message: 4 } } }] };
	const baseServices = taskServices(resources, new FakeFileService(root, { '.vscode/tasks.json': JSON.stringify(document) }), workspace, terminals);
	const lookup = new DeferredPromise<FileSearchResult>();
	const closeRequested = new DeferredPromise<void>();
	const closeAcknowledged = new DeferredPromise<void>();
	const failure = new Error('Workspace search failed');
	const search: IFileSearchService = { glob: async () => lookup.p, fuzzy: async () => { throw new Error('unused'); } };
	const services = baseServices.createChild(new ServiceCollection([IFileSearchService, search]), resources);
	using tasks = services.createInstance(TaskService);
	const [task] = await tasks.refresh();
	const run = await tasks.run(task!);
	terminals.instances[0].close = async () => { void closeRequested.complete(undefined); await closeAcknowledged.p; terminals.instances[0].state = 'exited'; };
	let completed = false;
	const completion = run.completion!.then(() => { completed = true; }, error => { completed = true; return error; });
	terminals.instances[0].output('main.ts:2:3 diagnostic\n');
	terminals.instances[0].exit(0);
	void lookup.error(failure);
	await closeRequested.p;
	assert.equal(run.status, 'failed');
	assert.equal(completed, false);
	assert.deepEqual(services.get(IMarkerService).getAll(), []);
	void closeAcknowledged.complete(undefined);
	assert.equal(await completion, failure);
});

test('search matcher rejects a directory outside the workspace before process creation in the selected locale', async () => {
	using localization = toDisposable(resetNlsResolver);
	initializeTestLocalization('zh-CN');
	using resources = new DisposableStore();
	using terminals = new FakeTerminalService();
	const root = URI.file('/workspace');
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
	const document = { version: '2.0.0', tasks: [{ label: 'Outside', command: 'compiler', problemMatcher: { fileLocation: ['search', { include: '/outside' }], pattern: { regexp: '^(.+):(\\d+):(\\d+) (.+)$', file: 1, line: 2, column: 3, message: 4 } } }] };
	using tasks = taskServices(resources, new FakeFileService(root, { '.vscode/tasks.json': JSON.stringify(document) }), workspace, terminals).createInstance(TaskService);
	const [task] = await tasks.refresh();
	await assert.rejects(tasks.run(task!), { message: '问题匹配器搜索目录“/outside”不在当前工作区内。' });
	assert.equal(terminals.instances.length, 0);
});

test('TaskService selects the execution host platform before resolving command, cwd and environment', async () => {
	using resources = new DisposableStore();
	using terminals = new FakeTerminalService();
	const root = URI.file('/workspace');
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
	const creates: ITerminalCreateOptions[] = [];
	const create = terminals.createTerminal.bind(terminals);
	terminals.createTerminal = async options => { creates.push(options); return create(options); };
	const document = {
		version: '2.0.0', options: { env: { INHERITED: 'base', REMOVED: 'base' } },
		tasks: [{
			label: 'Platform', type: 'process', command: 'wrong-platform', args: ['wrong'],
			linux: { command: '${workspaceFolder}/linux-adapter', args: ['', '${env:HOME}', '$HOME'], options: { cwd: '${workspaceFolder}/linux', env: { PLATFORM: '${env:HOME}', REMOVED: null } } },
			osx: { command: 'wrong-mac' }, windows: { command: 'wrong-windows' },
		}],
	};
	const services = taskServices(resources, new FakeFileService(root, { '.vscode/tasks.json': JSON.stringify(document) }), workspace, terminals);
	const paths = services.get(IPathService);
	const hostPaths = Object.create(paths) as IPathService;
	hostPaths.getOperatingSystem = async resource => { assert.equal(resource.toString(), root.toString()); return OperatingSystem.Linux; };
	const dispatchServices = services.createChild(new ServiceCollection([IPathService, hostPaths]), resources);
	using service = dispatchServices.createInstance(TaskService);
	const task = (await service.refresh())[0];
	assert.equal(terminals.instances.length, 0);
	const run = await service.run(task);
	assert.deepEqual(creates, [{ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' }, title: 'Task: Platform', dirId: 'workspace', env: { INHERITED: 'base', REMOVED: null, PLATFORM: '/execution/home' }, cwd: '/workspace/linux', execution: { type: 'process', program: '/workspace/linux-adapter', args: ['', '/execution/home', '$HOME'] }, initialText: 'Executing task: "/workspace/linux-adapter" "" "/execution/home" "$HOME"', waitOnExit: 'Terminal will be reused by tasks, press any key to close it.', deferStart: true }]);
	assert.deepEqual(terminals.instances[0].writes, []);
	await service.terminate(run);
});

test('TaskService discovers tasks without terminal execution and rejects dispatch when the Terminal owner is missing', async () => {
	using resources = new DisposableStore();
	const parent = workbenchInstantiationService(resources);
	registerTestWorkbenchInteractionServices(resources, parent);
	registerTestExtensionService(resources, parent);
	parent.registerInstance(IPathService, new BrowserPathService(createDisconnectedRendererApi(), parent.get(IWorkspaceContextService)));
	const services = parent.createChild(new ServiceCollection([IFileService, resources.add(createTestFileService(new FakeFileService(URI.file('/workspace'), {})))], [ILogService, new NullLoggerService()], [ITerminalProcessService, createDisconnectedRendererApi().terminal], [IConfigurationResolverService, new SyncDescriptor(ConfigurationResolverService)]), resources);
	services.registerSingleton(ICommandService, () => new CommandService(services));
	const tasks = resources.add(services.createInstance(TaskService));
	const events: ITaskRun[] = [];
	resources.add(tasks.onDidStartTask(run => events.push(run)));
	resources.add(tasks.registerTaskProvider({ id: 'discovery', provideTasks: () => [{ id: 'build', label: 'Build', command: 'build', group: 'build' }] }));
	const [task] = await tasks.refresh();
	assert.deepEqual({ active: tasks.activeRuns, last: tasks.lastRun, tasks: tasks.tasks.map(task => task.label) }, { active: [], last: undefined, tasks: ['Build'] });
	assert.ok(parent.get(IOutputService).getChannel('tasks'));
	await assert.rejects(tasks.run(task!), /Unknown service: terminalService/);
	assert.deepEqual(events, []);
});

suite('TaskService terminal availability', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const outcome of ['acknowledge', 'reject', 'cancel'] as const) {
		test(`task dispatch waits for process creation and handles ${outcome}`, async () => {
			using localization = toDisposable(resetNlsResolver);
			initializeTestLocalization(outcome === 'reject' ? 'zh-CN' : 'en');
			using resources = new DisposableStore();
			const acknowledgement = new DeferredPromise<void>();
			const submitted = new DeferredPromise<void>();
			const root = URI.file('/workspace');
			const calls: string[] = [];
			const processes: ITerminalProcessService = {
				getConnectionState: async () => 'ready', onConnectionState: Event.None,
				getEnvironment: async () => ({}), listProfiles: async () => [{ profileId: 'shell', title: 'Shell', isDefault: true }],
				create: async options => {
					assert.deepEqual(options.execution, { type: 'shell', commandLine: 'check' });
					calls.push('create');
					void submitted.complete(undefined);
					await acknowledgement.p;
					return { ready: { pid: 1234, cwd: '/workspace' }, terminalId: 'task-process', profile: { profileId: 'shell', title: 'Shell', isDefault: true }, connectionPersistence: 'connectionOwned' };
				},
				read: async () => ({ terminalId: 'task-process', commandEventGap: false, chunks: [], nextSequence: 0, commandEvents: [], nextCommandSequence: 0, exited: false, exitCode: undefined, outputGap: false }),
				write: async () => { throw new Error('A configured task must not write shell command input'); },
				resize: async () => { }, close: async () => { calls.push('close'); },
			};
			const workspace: IWorkspaceContextService = { onDidChangeWorkspace: Event.None, getWorkspace: () => ({ id: 'workspace', folders: [{ id: 'workspace', uri: root, name: 'Workspace', index: 0 }] }), getWorkbenchState: () => 2, getWorkspaceFolder: () => null };
			const logs: string[] = [];
			const output = { createChannel: () => ({ ...Disposable.None, appendLine: (entry: { text: string; }) => { logs.push(entry.text); } }) } as unknown as IOutputService;
			const services = resources.add(new InstantiationService(new ServiceCollection([IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)],
				[IMarkerService, resources.add(new MarkerService())], [IModelService, { getModel: () => null }],
				[IFileService, resources.add(createTestFileService(new FakeFileService(root, {})))], [IWorkspaceContextService, workspace], [IConfigurationResolverService, new SyncDescriptor(ConfigurationResolverService)],
				[IPathService, new BrowserPathService(createDisconnectedRendererApi(), workspace)], [ITerminalProcessService, processes], [IOutputService, output], [ILogService, new NullLoggerService()],
			)));
			services.registerSingleton(ICommandService, () => new CommandService(services));
			const terminals = resources.add(services.createInstance(TerminalService));
			services.registerInstance(ITerminalService, terminals);
			registerTestExtensionService(resources, services);
			registerTestWorkbenchInteractionServices(resources, services);
			const tasks = resources.add(services.createInstance(TaskService));
			resources.add(tasks.registerTaskProvider({ id: 'test', provideTasks: () => [{ id: 'check', label: 'Check', command: 'check', group: 'build' }] }));
			await tasks.refresh();
			let finished = false;
			const cancellation = new AbortController();
			const run = tasks.run(tasks.tasks[0], cancellation.signal).finally(() => { finished = true; });
			const failure = new Error('task prepare rejected');
			const result = outcome === 'acknowledge' ? run : assert.rejects(run, outcome === 'cancel' ? isCancellationError : error => error === failure);
			await submitted.p;
			assert.equal(finished, false);
			if (outcome === 'acknowledge') void acknowledgement.complete(undefined);
			else if (outcome === 'reject') void acknowledgement.error(failure);
			else { cancellation.abort(); void acknowledgement.complete(undefined); }
			await result;
			assert.deepEqual({ status: tasks.lastRun?.status, active: tasks.activeRuns.length, terminals: terminals.instances.length, calls }, {
				status: outcome === 'acknowledge' ? 'running' : undefined,
				active: outcome === 'acknowledge' ? 1 : 0, terminals: outcome === 'acknowledge' ? 1 : 0,
				calls: outcome === 'cancel' ? ['create', 'close'] : ['create'],
			});
			if (outcome === 'reject') {
				assert.ok(logs.some(message => message.includes('task prepare rejected')));
			}
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
				getEnvironment: async () => ({}), listProfiles: async () => [{ profileId: 'shell', title: 'Shell', isDefault: true }],
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
			const services = resources.add(new InstantiationService(new ServiceCollection([IConfigurationService, new SyncDescriptor(WorkbenchConfigurationService)],
				[IMarkerService, resources.add(new MarkerService())], [IModelService, { getModel: () => null }],
				[IFileService, resources.add(createTestFileService(new FakeFileService(root, {})))],
				[IWorkspaceContextService, workspace], [IConfigurationResolverService, new SyncDescriptor(ConfigurationResolverService)],
				[IPathService, new BrowserPathService(createDisconnectedRendererApi(), workspace)], [ITerminalProcessService, processes],
				[IOutputService, output],
				[ILogService, new NullLoggerService()],
			)));
			services.registerSingleton(ICommandService, () => new CommandService(services));
			const terminals = resources.add(services.createInstance(TerminalService));
			services.registerInstance(ITerminalService, terminals);
			registerTestExtensionService(resources, services);
			registerTestWorkbenchInteractionServices(resources, services);
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


suite('Task terminal reuse policies', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function assemble(owner: DisposableStore, panel: 'shared' | 'dedicated' | 'new' | undefined, presentation: { reveal?: 'always' | 'silent' | 'never'; close?: boolean; } = {}) {
		const services = workbenchInstantiationService(owner);
		registerTestWorkbenchInteractionServices(owner, services);
		const workspace = services.get(IWorkspaceContextService) as WorkspaceContextService;
		const root = URI.file('/workspace');
		workspace.updateWorkspace({ id: 'workspace', uri: root });
		const document = { version: '2.0.0', tasks: ['First', 'Second'].map(label => ({ label, type: 'process', command: label.toLowerCase(), args: [], options: { cwd: `/workspace/${label.toLowerCase()}`, env: { TASK: label } }, presentation: { panel, ...presentation } })) };
		services.registerInstance(IFileService, owner.add(createTestFileService(new FakeFileService(root, { '.vscode/tasks.json': JSON.stringify(document) }))));
		services.registerInstance(IPathService, new BrowserPathService(createDisconnectedRendererApi(), workspace));
		services.registerSingleton(ICommandService, () => new CommandService(services));
		services.registerInstance(ILogService, new NullLoggerService());
		services.registerInstance(IMarkerService, owner.add(new MarkerService()));
		registerTestExtensionService(owner, services);
		const children = new Map<string, DeferredPromise<ITerminalProcessReadResult>>();
		const created: ITerminalCreateOptions['execution'][] = [];
		const environments: unknown[] = [];
		const closed: string[] = [];
		const closing = { wait: async (_id: string): Promise<void> => { } };
		services.registerInstance(ITerminalProcessService, {
			getConnectionState: async () => 'ready', onConnectionState: Event.None,
			getEnvironment: async () => ({}), listProfiles: async () => [{ profileId: 'shell', title: 'Shell', isDefault: true }],
			create: async options => {
				created.push(options.execution);
				environments.push({ env: options.env, cwd: options.cwd });
				const terminalId = `process-${created.length}`;
				children.set(terminalId, new DeferredPromise());
				return { terminalId, ready: { pid: 1000 + created.length, cwd: options.cwd ?? '/workspace' }, profile: { profileId: 'shell', title: 'Shell', isDefault: true }, connectionPersistence: 'connectionOwned' };
			},
			read: options => children.get(options.terminalId)!.p,
			write: async () => { }, resize: async () => { },
			close: async options => { closed.push(options.terminalId); await closing.wait(options.terminalId); },
		});
		services.registerInstance(IConfigurationResolverService, owner.add(services.createInstance(ConfigurationResolverService)));
		const terminals = owner.add(services.createInstance(TerminalService));
		services.registerInstance(ITerminalService, terminals);
		const tasks = owner.add(services.createInstance(TaskService));
		const finish = async (run: ITaskRun): Promise<void> => {
			const id = `process-${run.processId! - 1000}`;
			void children.get(id)!.complete({ terminalId: id, commandEventGap: false, chunks: [], nextSequence: 0, commandEvents: [], nextCommandSequence: 0, exited: true, exitCode: 0, outputGap: false });
			assert.ok(run.completion);
			await run.completion;
		};
		return { tasks, terminals, finish, created, environments, closed, closing };
	}

	for (const panel of [undefined, 'shared', 'dedicated', 'new'] as const) {
		test(`${panel ?? 'default'} task panels preserve instance policy while replacing the complete child environment`, async () => {
			using owner = new DisposableStore();
			const { tasks, terminals, finish, created, environments, closed } = assemble(owner, panel);
			const effectivePanel = panel ?? 'shared';
			const [first, second] = await tasks.refresh();
			const a = await tasks.run(first!);
			await finish(a);
			const b = await tasks.run(second!);
			await finish(b);
			const c = await tasks.run(first!);
			await finish(c);
			assert.deepEqual({ ids: [a.terminalId, b.terminalId, c.terminalId], pids: [a.processId, b.processId, c.processId], instances: terminals.instances.length, created, environments, closed }, {
				ids: effectivePanel === 'shared' ? ['terminal-instance-1', 'terminal-instance-1', 'terminal-instance-1'] : panel === 'dedicated' ? ['terminal-instance-1', 'terminal-instance-2', 'terminal-instance-1'] : ['terminal-instance-1', 'terminal-instance-2', 'terminal-instance-3'],
				pids: [1001, 1002, 1003], instances: effectivePanel === 'shared' ? 1 : panel === 'dedicated' ? 2 : 3,
				created: [{ type: 'process', program: 'first', args: [] }, { type: 'process', program: 'second', args: [] }, { type: 'process', program: 'first', args: [] }],
				environments: [{ env: { TASK: 'First' }, cwd: '/workspace/first' }, { env: { TASK: 'Second' }, cwd: '/workspace/second' }, { env: { TASK: 'First' }, cwd: '/workspace/first' }],
				closed: effectivePanel === 'shared' ? ['process-1', 'process-2'] : panel === 'dedicated' ? ['process-1'] : [],
			});
		});
	}

	test('concurrent shared tasks reserve separate terminals and leave each process intact', async () => {
		using owner = new DisposableStore();
		const { tasks, terminals, finish, created } = assemble(owner, 'shared');
		const [first, second] = await tasks.refresh();
		const a = await tasks.run(first!);
		await finish(a);
		const b = await tasks.run(second!);
		const c = await tasks.run(first!);
		assert.deepEqual({ ids: [b.terminalId, c.terminalId], processes: created.length, instances: terminals.instances.length, active: tasks.activeRuns.length }, { ids: ['terminal-instance-1', 'terminal-instance-2'], processes: 3, instances: 2, active: 2 });
		await Promise.all([finish(b), finish(c)]);
	});

	test('automatic terminal close waits for process release and excludes the closing screen from shared reuse', async () => {
		using owner = new DisposableStore();
		const { tasks, terminals, finish, closed, closing } = assemble(owner, 'shared', { reveal: 'never', close: true });
		const requested = new DeferredPromise<void>();
		const release = new DeferredPromise<void>();
		closing.wait = async id => { if (id === 'process-1') { void requested.complete(); await release.p; } };
		const catalog = await tasks.refresh();
		const first = await tasks.run(catalog[0]!);
		const firstTerminal = terminals.activeInstance!;
		await finish(first);
		await requested.p;
		assert.deepEqual({ status: first.status, closed, instances: terminals.instances.length }, { status: 'succeeded', closed: ['process-1'], instances: 1 });
		const second = await tasks.run(catalog[1]!);
		const secondTerminal = terminals.activeInstance!;
		assert.notEqual(second.terminalId, first.terminalId);
		void release.complete();
		await firstTerminal.close();
		assert.deepEqual(terminals.instances.map(terminal => terminal.id), [second.terminalId]);
		await finish(second);
		await secondTerminal.close();
		assert.deepEqual({ closed, instances: terminals.instances.length }, { closed: ['process-1', 'process-2'], instances: 0 });
	});

	test('a custom release acknowledgment controls reuse and a retained custom screen can host the next process task', async () => {
		using owner = new DisposableStore();
		const { tasks, terminals, finish, created } = assemble(owner, 'shared');
		const exited = owner.add(new Emitter<number | void>());
		const output = owner.add(new Emitter<string>());
		const release = new DeferredPromise<void>();
		owner.add(tasks.registerTaskProvider({ id: 'custom', provideTasks: () => [{ id: 'custom', label: 'Custom', group: 'other', presentation: { panel: 'shared' }, execution: { type: 'custom', callback: () => ({ onDidWrite: output.event, onDidClose: exited.event, releaseCompletion: release.p, open: () => output.fire('CUSTOM_OUTPUT\n'), close() { } }) } }] }));
		const catalog = await tasks.refresh();
		const custom = await tasks.run(catalog.find(task => task.label === 'Custom')!);
		exited.fire(0);
		assert.equal(custom.status, 'succeeded');
		const first = await tasks.run(catalog.find(task => task.label === 'First')!);
		assert.notEqual(first.terminalId, custom.terminalId, 'a visible custom exit has not released its producer');
		await finish(first);
		void release.complete();
		await custom.completion;
		const second = await tasks.run(catalog.find(task => task.label === 'Second')!);
		assert.deepEqual({ id: second.terminalId, customId: custom.terminalId, customPid: custom.processId, pid: second.processId, processes: created.length, instances: terminals.instances.length }, { id: 'terminal-instance-1', customId: 'terminal-instance-1', customPid: undefined, pid: 1002, processes: 2, instances: 2 });
		await finish(second);
		const customAgain = await tasks.run(catalog.find(task => task.label === 'Custom')!);
		assert.deepEqual({ id: customAgain.terminalId, pid: customAgain.processId, previousPid: second.processId }, { id: custom.terminalId, pid: undefined, previousPid: 1002 });
		exited.fire(0);
		await customAgain.completion;
	});
});

suite('TaskService configuration capabilities', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const configuration of [
		{ type: 'unregistered' },
		{ presentation: { group: 'parallel' }, options: { env: { SECRET_MARKER: 'must-not-appear-in-logs' } } },
		{ runOptions: { runOn: 'folderOpen' } },
	] as const) {
		test(`rejects unsupported ${JSON.stringify(configuration)} before opening a terminal and retries corrected configuration`, async () => {
			using localization = toDisposable(resetNlsResolver);
			initializeTestLocalization('zh-CN');
			using resources = new DisposableStore();
			using terminals = new FakeTerminalService();
			const root = URI.file('/workspace');
			const contents: Record<string, string> = { '.vscode/tasks.json': JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Check', command: 'check', ...configuration }] }) };
			const workspace: IWorkspaceContextService = { onDidChangeWorkspace: Event.None, getWorkspace: () => ({ id: 'workspace', folders: [{ id: 'workspace', uri: root, name: 'Workspace', index: 0 }] }), getWorkbenchState: () => 2, getWorkspaceFolder: () => null };
			const services = taskServices(resources, new FakeFileService(root, contents), workspace, terminals);
			using service = services.createInstance(TaskService);
			await service.refresh();
			let starts = 0;
			resources.add(service.onDidStartTask(() => { starts++; }));
			await assert.rejects(service.run(service.tasks[0]), /任务“Check”尚未启动，因为 Ash 尚不支持/);
			assert.deepEqual({ terminals: terminals.instances, active: service.activeRuns, last: service.lastRun, starts }, { terminals: [], active: [], last: undefined, starts: 0 });
			assert.doesNotMatch(services.get(IOutputService).getChannel('tasks')?.getText() ?? '', /must-not-appear-in-logs/);

			contents['.vscode/tasks.json'] = JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Check', command: 'check', custom: { providerVersion: 3 } }] });
			const run = await service.run((await service.refresh())[0]);
			assert.deepEqual({ status: run.status, terminals: terminals.instances.length, execution: terminals.instances[0].execution, starts }, { status: 'running', terminals: 1, execution: { type: 'shell', commandLine: 'check' }, starts: 1 });
		});
	}

	test('dispatch refreshes unseen changes instead of executing a previously valid task or retained invalid catalog', async () => {
		using resources = new DisposableStore();
		using terminals = new FakeTerminalService();
		const root = URI.file('/workspace');
		const contents: Record<string, string> = { '.vscode/tasks.json': '{"version":"2.0.0","tasks":[{"label":"Check","command":"check"}]}' };
		const workspace: IWorkspaceContextService = { onDidChangeWorkspace: Event.None, getWorkspace: () => ({ id: 'workspace', folders: [{ id: 'workspace', uri: root, name: 'Workspace', index: 0 }] }), getWorkbenchState: () => 2, getWorkspaceFolder: () => null };
		using service = taskServices(resources, new FakeFileService(root, contents), workspace, terminals).createInstance(TaskService);
		const task = (await service.refresh())[0];
		contents['.vscode/tasks.json'] = '{"version":"2.0.0","tasks":[{"label":"Check","command":"check","presentation":{"group":"parallel"}}]}';
		await assert.rejects(service.run(task), /presentation/);
		contents['.vscode/tasks.json'] = '{ invalid json';
		await assert.rejects(service.refresh());
		await assert.rejects(service.run(task));
		assert.equal(terminals.instances.length, 0);
		contents['.vscode/tasks.json'] = '{"version":"2.0.0","tasks":[{"label":"Check","command":"check"}]}';
		assert.equal((await service.run(task)).status, 'running');
		assert.equal(terminals.instances.length, 1);
	});

	test('a superseded dispatch waits for the completed current catalog before execution', async () => {
		using localization = toDisposable(resetNlsResolver);
		initializeTestLocalization('en');
		using resources = new DisposableStore();
		using terminals = new FakeTerminalService();
		const root = URI.file('/workspace');
		const workspace: IWorkspaceContextService = { onDidChangeWorkspace: Event.None, getWorkspace: () => ({ id: 'workspace', folders: [{ id: 'workspace', uri: root, name: 'Workspace', index: 0 }] }), getWorkbenchState: () => 2, getWorkspaceFolder: () => null };
		using service = taskServices(resources, new FakeFileService(root, { '.vscode/tasks.json': '{"version":"2.0.0","tasks":[{"label":"Check","command":"check"}]}' }), workspace, terminals).createInstance(TaskService);
		const delayed = new DeferredPromise<void>();
		const discovering = new DeferredPromise<void>();
		let calls = 0;
		resources.add(service.registerTaskProvider({ id: 'delayed', provideTasks: async () => { calls++; if (calls === 2) { void discovering.complete(undefined); await delayed.p; } return []; } }));
		const task = (await service.refresh())[0];
		const dispatch = service.run(task);
		await discovering.p;
		await service.refresh();
		void delayed.complete(undefined);
		const run = await dispatch;
		assert.deepEqual({ terminals: terminals.instances.length, status: run.status, execution: terminals.instances[0].execution }, { terminals: 1, status: 'running', execution: { type: 'shell', commandLine: 'check' } });
		await service.terminate(run);
	});

});

suite('TaskService configuration resolution', () => {
	for (const root of [URI.file('/workspace/project'), URI.from({ scheme: 'file', path: '/C:/work/project' })]) {
		test(`resolves the dispatched command and retains the source task for ${root.path}`, async () => {
			using resources = new DisposableStore();
			using terminals = new FakeTerminalService();
			const folder = { id: 'workspace', uri: root, name: 'Project', index: 0 };
			const workspace: IWorkspaceContextService = { onDidChangeWorkspace: Event.None, getWorkspace: () => ({ id: 'workspace', folders: [folder] }), getWorkbenchState: () => 2, getWorkspaceFolder: () => folder };
			const command = 'echo "${workspaceFolder:Project}" ${workspaceFolderBasename} "${env:HOME}"';
			using service = taskServices(resources, new FakeFileService(root, { '.vscode/tasks.json': JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Resolve', command }] }) }), workspace, terminals).createInstance(TaskService);
			const task = (await service.refresh())[0]!;
			await service.run(task);
			assert.deepEqual((terminals.instances[0] as FakeTerminalInstance).execution, { type: 'shell', commandLine: `echo "${root.fsPath}" project "/execution/home"` });
			assert.equal(task.command, command);
		});
	}

	test('a missing named folder fails before creating a terminal or run', async () => {
		using resources = new DisposableStore();
		using terminals = new FakeTerminalService();
		const root = URI.file('/workspace');
		const workspace: IWorkspaceContextService = { onDidChangeWorkspace: Event.None, getWorkspace: () => ({ id: 'workspace', folders: [{ id: 'workspace', uri: root, name: 'Project', index: 0 }] }), getWorkbenchState: () => 2, getWorkspaceFolder: () => null };
		using service = taskServices(resources, new FakeFileService(root, { '.vscode/tasks.json': JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Resolve', command: '${workspaceFolder:Missing}/build' }] }) }), workspace, terminals).createInstance(TaskService);
		await assert.rejects(service.run((await service.refresh())[0]!));
		assert.deepEqual({ terminals: terminals.instances, runs: service.activeRuns, last: service.lastRun }, { terminals: [], runs: [], last: undefined });
	});
});

test('TaskService admits only registered contributed variables and resolves them once before process creation', async () => {
	using resources = new DisposableStore();
	using terminals = new FakeTerminalService();
	const root = URI.file('/workspace');
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
	const services = taskServices(resources, new FakeFileService(root, { '.vscode/tasks.json': JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Contributed', type: 'process', command: '${taskTarget}', args: ['${taskTarget}'] }, { label: 'Unknown', type: 'process', command: '${unregisteredTarget}' }, { label: 'Current build', type: 'process', command: '/compiler', group: { kind: 'build', isDefault: true } }] }) }), workspace, terminals);
	const resolver = services.get(IConfigurationResolverService);
	let calls = 0;
	resolver.contributeVariable('taskTarget', async () => { calls++; return '/chosen'; });
	using tasks = services.createInstance(TaskService);
	assert.deepEqual(await resolver.resolveWithInteractionReplace(undefined, { preLaunchTask: '${defaultBuildTask}', repeated: '${defaultBuildTask}' }), { preLaunchTask: 'Current build', repeated: 'Current build' });
	assert.deepEqual({ runs: tasks.activeRuns, terminals: terminals.instances }, { runs: [], terminals: [] });
	const catalog = await tasks.refresh();
	const contributed = catalog.find(task => task.label === 'Contributed');
	const unknown = catalog.find(task => task.label === 'Unknown');
	assert.deepEqual(contributed?.unsupportedFeatures, []);
	assert.deepEqual(unknown?.unsupportedFeatures, ['command']);
	assert.equal(calls, 0);
	const run = await tasks.run(contributed!);
	assert.deepEqual({ execution: terminals.instances[0]?.execution, calls }, { execution: { type: 'process', program: '/chosen', args: ['/chosen'] }, calls: 1 });
	await tasks.terminate(run);
	await assert.rejects(tasks.run(unknown!), /does not yet support: command/);
	assert.equal(terminals.instances.length, 1);
});

for (const retirement of ['workspace', 'dispose'] as const) {
	test(`default build variable closes its real selection and cancels resolution on ${retirement}`, async () => {
		using resources = new DisposableStore();
		using terminals = new FakeTerminalService();
		const root = URI.file('/workspace');
		using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
		const services = taskServices(resources, new FakeFileService(root, { '.vscode/tasks.json': JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Choose build', command: 'build', group: 'build' }] }) }), workspace, terminals);
		using tasks = services.createInstance(TaskService);
		await tasks.refresh();
		const resolver = services.get(IConfigurationResolverService);
		const quickInput = services.get(IQuickInputService);
		const pending = resolver.resolveWithInteractionReplace(undefined, '${defaultBuildTask}');
		// The fixture's catalog operations are microtasks; observe the public window
		// selection after they drain rather than substituting a picker implementation.
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(quickInput.currentQuickInput?.items.map(item => item.label), ['Choose build']);
		if (retirement === 'workspace') workspace.updateWorkspace({ id: 'replacement', uri: URI.file('/replacement') });
		else tasks.dispose();
		assert.equal(await pending, undefined);
		assert.equal(quickInput.currentQuickInput, undefined);
		assert.deepEqual({ terminals: terminals.instances, runs: tasks.activeRuns }, { terminals: [], runs: [] });
	});
}

test('TaskService cancels dispatch when the workspace changes during configuration resolution', async () => {
	using resources = new DisposableStore();
	using terminals = new FakeTerminalService();
	const root = URI.file('/workspace');
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
	const services = taskServices(resources, new FakeFileService(root, { '.vscode/tasks.json': JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Resolve', command: '${workspaceFolder}/build' }] }) }), workspace, terminals);
	const resolver = services.get(IConfigurationResolverService);
	const entered = new DeferredPromise<void>();
	const finish = new DeferredPromise<void>();
	const delayedResolver: IConfigurationResolverService = {
		get resolvableVariables() { return resolver.resolvableVariables; },
		resolveWithEnvironment: (environment, folder, value) => resolver.resolveWithEnvironment(environment, folder, value),
		resolveWithInteraction: async (folder, config, section, variables, target) => {
			const result = await resolver.resolveWithInteraction(folder, config, section, variables, target);
			void entered.complete(undefined);
			await finish.p;
			return result;
		},
		contributeVariable: (variable, resolution) => resolver.contributeVariable(variable, resolution),
		resolveAsync: (folder, config) => resolver.resolveAsync(folder, config),
		resolveWithInteractionReplace: (folder, config, section, variables, target) => resolver.resolveWithInteractionReplace(folder, config, section, variables, target),
	};
	const dispatchServices = services.createChild(new ServiceCollection([IConfigurationResolverService, delayedResolver]), resources);
	using service = dispatchServices.createInstance(TaskService);
	const task = (await service.refresh())[0]!;
	const dispatch = assert.rejects(service.run(task), isCancellationError);
	await entered.p;
	workspace.updateWorkspace({ id: 'replacement', uri: URI.file('/replacement') });
	void finish.complete(undefined);
	await dispatch;
	assert.deepEqual({ terminals: terminals.instances, runs: service.activeRuns }, { terminals: [], runs: [] });
});

test('TaskService resolves command variables once and reevaluates them for a new run', async () => {
	using resources = new DisposableStore();
	using terminals = new FakeTerminalService();
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	const input = { version: '2.0.0', tasks: [{ label: 'Resolve', command: 'build ${command:tasks.test.target} ${command:tasks.test.target}', detail: '${command:tasks.test.unused}' }] };
	let calls = 0;
	using unused = CommandsRegistry.register('tasks.test.unused', () => { throw new Error('Task metadata must not invoke commands'); });
	using command = CommandsRegistry.register('tasks.test.target', (_accessor, value) => {
		assert.deepEqual(value, ['${command:tasks.test.target}']);
		return `target-${++calls}`;
	});
	using service = taskServices(resources, new FakeFileService(URI.file('/workspace'), { '.vscode/tasks.json': JSON.stringify(input) }), workspace, terminals).createInstance(TaskService);
	const task = (await service.refresh())[0]!;
	assert.deepEqual(task.unsupportedFeatures, []);
	const first = await service.run(task);
	await service.terminate(first);
	const second = await service.run(task);
	assert.deepEqual(terminals.instances.map(terminal => terminal.execution), [{ type: 'shell', commandLine: 'build target-1 target-1' }, { type: 'shell', commandLine: 'build target-2 target-2' }]);
	assert.equal(task.command, input.tasks[0]!.command);
	await service.terminate(first);
	await service.terminate(second);
});

test('TaskService does not publish a run or create a terminal when command resolution is canceled', async () => {
	using resources = new DisposableStore();
	using terminals = new FakeTerminalService();
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	using command = CommandsRegistry.register('tasks.test.cancel', () => undefined);
	using service = taskServices(resources, new FakeFileService(URI.file('/workspace'), { '.vscode/tasks.json': '{"version":"2.0.0","tasks":[{"label":"Cancel","command":"${command:tasks.test.cancel}"}]}' }), workspace, terminals).createInstance(TaskService);
	let starts = 0;
	using listener = service.onDidStartTask(() => { starts++; });
	await assert.rejects(service.run((await service.refresh())[0]!), isCancellationError);
	assert.deepEqual({ starts, terminals: terminals.instances.length, runs: service.activeRuns.length, last: service.lastRun }, { starts: 0, terminals: 0, runs: 0, last: undefined });
});

test('TaskService rejects an empty resolved command before terminal creation in the selected language', async () => {
	using resources = new DisposableStore();
	using localization = toDisposable(resetNlsResolver);
	initializeTestLocalization('zh-CN');
	using terminals = new FakeTerminalService();
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	using command = CommandsRegistry.register('tasks.test.empty', () => '');
	using service = taskServices(resources, new FakeFileService(URI.file('/workspace'), { '.vscode/tasks.json': '{"version":"2.0.0","tasks":[{"label":"Empty","command":"${command:tasks.test.empty}"}]}' }), workspace, terminals).createInstance(TaskService);
	await assert.rejects(service.run((await service.refresh())[0]!), { message: '解析后的任务命令为空，或包含无效字符。' });
	assert.deepEqual({ terminals: terminals.instances.length, runs: service.activeRuns.length }, { terminals: 0, runs: 0 });
});

for (const cause of ['workspace', 'dispose'] as const) {
	test(`TaskService closes a terminal created after ${cause} invalidates dispatch`, async () => {
		using resources = new DisposableStore();
		using terminals = new FakeTerminalService();
		using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
		const entered = new DeferredPromise<void>();
		const finish = new DeferredPromise<void>();
		const create = terminals.createTerminal.bind(terminals);
		terminals.createTerminal = async options => { void entered.complete(undefined); await finish.p; return create(options); };
		using service = taskServices(resources, new FakeFileService(URI.file('/workspace'), { '.vscode/tasks.json': '{"version":"2.0.0","tasks":[{"label":"Check","command":"check"}]}' }), workspace, terminals).createInstance(TaskService);
		let starts = 0;
		using listener = service.onDidStartTask(() => { starts++; });
		const dispatch = assert.rejects(service.run((await service.refresh())[0]!), /Task configuration changed/);
		await entered.p;
		if (cause === 'workspace') {
			workspace.updateWorkspace({ id: 'replacement', uri: URI.file('/replacement') });
		} else {
			service.dispose();
		}
		void finish.complete(undefined);
		await dispatch;
		assert.deepEqual({ starts, state: terminals.instances[0]!.state, writes: terminals.instances[0]!.writes, runs: service.activeRuns.length }, { starts: 0, state: 'exited', writes: [], runs: 0 });
	});
}

test('TaskService resolves configured command inputs at dispatch, reevaluates reruns and cancels before terminal creation', async () => {
	using resources = new DisposableStore();
	using terminals = new FakeTerminalService();
	const root = URI.file('/workspace');
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
	const input = {
		version: '2.0.0',
		inputs: [{ id: 'target', type: 'command', command: 'tasks.test.input', args: { target: 'release' } }],
		tasks: [{ label: 'Configured', command: 'build ${input:target} ${input:target}', detail: '${input:unused}' }],
	};
	const services = taskServices(resources, new FakeFileService(root, { '.vscode/tasks.json': JSON.stringify(input) }), workspace, terminals);
	const dom = new JSDOM('<!doctype html><body></body>');
	resources.add(toDisposable(() => dom.window.close()));
	const context = resources.add(new ContextKeyService());
	services.registerInstance(IQuickInputService, resources.add(new WorkbenchQuickInputService({ container: dom.window.document.body, contextKeyService: context })));
	let calls = 0;
	using command = CommandsRegistry.register('tasks.test.input', (_accessor, args) => {
		assert.deepEqual(args, { target: 'release' });
		return ++calls === 3 ? undefined : `release-${calls}`;
	});
	using service = services.createInstance(TaskService);
	const task = (await service.refresh())[0]!;
	assert.equal(calls, 0);
	await service.run(task);
	await service.terminate(service.lastRun!);
	await service.run(task);
	assert.deepEqual(terminals.instances.map(terminal => terminal.execution), ['build release-1 release-1', 'build release-2 release-2'].map(commandLine => ({ type: 'shell', commandLine })));
	const previousRun = service.lastRun;
	await service.terminate(previousRun!);
	await assert.rejects(service.run(task), isCancellationError);
	assert.equal(calls, 3);
	assert.equal(terminals.instances.length, 2);
	assert.equal(service.lastRun, previousRun);
	assert.equal(task.command, input.tasks[0].command);
});


test('TaskService resolves inherited and overridden environment values before terminal creation', async () => {
	using resources = new DisposableStore();
	using terminals = new FakeTerminalService();
	const root = URI.file('/workspace');
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
	const input = { version: '2.0.0', options: { env: { MODE: 'default', HOME_COPY: '${env:HOME}' } }, tasks: [{ label: 'Environment', command: 'build', options: { env: { MODE: 'task', ROOT: '${workspaceFolder}' } } }] };
	const services = taskServices(resources, new FakeFileService(root, { '.vscode/tasks.json': JSON.stringify(input) }), workspace, terminals);
	const creations: ITerminalCreateOptions[] = [];
	const create = terminals.createTerminal.bind(terminals);
	terminals.createTerminal = async options => { creations.push(options); return create(options); };
	using service = services.createInstance(TaskService);
	const task = (await service.refresh())[0]!;
	await service.run(task);
	assert.deepEqual(creations[0]?.env, { MODE: 'task', HOME_COPY: '/execution/home', ROOT: '/workspace' });
	assert.deepEqual((terminals.instances[0] as FakeTerminalInstance).execution, { type: 'shell', commandLine: 'build' });
	assert.equal(task.environment?.HOME_COPY, '${env:HOME}');
});


test('TaskService resolves environments from an Extension Host provider through the shared terminal execution path', async () => {
	using resources = new DisposableStore();
	using terminals = new FakeTerminalService();
	const root = URI.file('/workspace');
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
	const services = taskServices(resources, new FakeFileService(root, {}), workspace, terminals);
	using service = services.createInstance(TaskService);
	const environments: unknown[] = [];
	const create = terminals.createTerminal.bind(terminals);
	terminals.createTerminal = async options => { environments.push(options.env); return create(options); };
	using registration = service.registerTaskProvider(createExtensionHostTaskProvider('hosted', async (operation) => {
		assert.equal(operation, 'provideTasks');
		return { tasks: [{ id: 'build', label: 'Build', command: 'build', group: 'build', env: { HOME_COPY: '${env:HOME}', ROOT: '${workspaceFolder}', LITERAL: '$value' } }] };
	}, workspace));
	await service.run((await service.refresh())[0]!);
	assert.deepEqual(environments, [{ HOME_COPY: '/execution/home', ROOT: '/workspace', LITERAL: '$value' }]);
	assert.deepEqual((terminals.instances[0] as FakeTerminalInstance).execution, { type: 'shell', commandLine: 'build' });
});

test('shell task arguments are quoted after variable resolution and explicit shell options reach the process owner', async () => {
	using resources = new DisposableStore();
	using terminals = new FakeTerminalService();
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	const contents = {
		'.vscode/tasks.json': JSON.stringify({
			version: '2.0.0', tasks: [{
				label: 'Shell arguments', command: '${workspaceFolder}/tool with spaces',
				args: ['', '${command:tasks.test.shellArgument}', { value: '$HOME', quoting: 'strong' }, { value: '$HOME', quoting: 'weak' }, { value: 'two words', quoting: 'escape' }, { value: "one'two", quoting: 'strong' }],
				options: { shell: { executable: '/bin/sh', args: ['-c'] }, cwd: '${workspaceFolder}/child', env: { MODE: '${env:HOME}' } },
			}]
		})
	};
	let calls = 0;
	using command = CommandsRegistry.register('tasks.test.shellArgument', () => { calls++; return 'literal $(touch injected)'; });
	const creations: ITerminalCreateOptions[] = [];
	const create = terminals.createTerminal.bind(terminals);
	terminals.createTerminal = async options => { creations.push(options); return create(options); };
	using service = taskServices(resources, new FakeFileService(URI.file('/workspace'), contents), workspace, terminals).createInstance(TaskService);
	const run = await service.run((await service.refresh())[0]);
	assert.deepEqual({ execution: creations[0].execution, cwd: creations[0].cwd, env: creations[0].env, writes: terminals.instances[0].writes, calls }, {
		execution: { type: 'process', program: '/bin/sh', args: ['-c', "'/workspace/tool with spaces' '' 'literal $(touch injected)' '$HOME' \"$HOME\" two\\ words 'one'\\''two'"] },
		cwd: '/workspace/child', env: { MODE: '/execution/home' }, writes: [], calls: 1,
	});
	await service.terminate(run);
});

test('provider shell execution selects the execution host profile and cancellation releases pending discovery', async () => {
	using resources = new DisposableStore();
	using terminals = new FakeTerminalService();
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	const entered = new DeferredPromise<void>();
	const release = new DeferredPromise<readonly ITerminalProfile[]>();
	terminals.getProfiles = () => { void entered.complete(undefined); return release.p; };
	const creations: ITerminalCreateOptions[] = [];
	const create = terminals.createTerminal.bind(terminals);
	terminals.createTerminal = async options => { creations.push(options); return create(options); };
	using service = taskServices(resources, new FakeFileService(URI.file('/workspace'), {}), workspace, terminals).createInstance(TaskService);
	using provider = service.registerTaskProvider(createExtensionHostTaskProvider('shell-host', async () => ({ tasks: [{ id: 'build', label: 'Build', group: 'build', execution: { type: 'shell', command: 'compiler', args: ['${env:HOME}/two words', { value: '$HOME', quoting: 2 }] } }] }), workspace));
	const task = (await service.refresh())[0];
	const abort = new AbortController();
	const cancelled = assert.rejects(service.run(task, abort.signal), isCancellationError);
	await entered.p;
	abort.abort();
	await cancelled;
	assert.equal(creations.length, 0);
	void release.complete([{ profileId: 'bash', title: 'Bash', isDefault: true }]);
	const run = await service.run(task);
	assert.deepEqual({ profile: creations[0].profile, execution: creations[0].execution, writes: terminals.instances[0].writes }, {
		profile: { type: 'profile', profileId: 'bash' }, execution: { type: 'shell', commandLine: "compiler '/execution/home/two words' '$HOME'" }, writes: [],
	});
	await service.terminate(run);
});

test('missing task shells report the selected locale and create no terminal', async () => {
	using localization = toDisposable(resetNlsResolver);
	initializeTestLocalization('zh-CN');
	using resources = new DisposableStore();
	using terminals = new FakeTerminalService();
	terminals.getProfiles = async () => [];
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	using service = taskServices(resources, new FakeFileService(URI.file('/workspace'), { '.vscode/tasks.json': JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Shell', command: 'compiler', args: ['file name'] }] }) }), workspace, terminals).createInstance(TaskService);
	await assert.rejects(service.run((await service.refresh())[0]), /没有可用于执行此任务的 shell/);
	assert.equal(terminals.instances.length, 0);
});

test('process tasks resolve literal arguments and cwd into a process spawn without terminal command input', async () => {
	using resources = new DisposableStore();
	using terminals = new FakeTerminalService();
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	const input = { version: '2.0.0', tasks: [{ label: 'Process', type: 'process', command: 'node', args: ['', 'two words', '${env:HOME}', '$(touch injected)', '$HOME'], options: { cwd: '${workspaceFolder}/child' }, problemMatcher: { base: '$tsc', fileLocation: ['relative', '${env:HOME}/sources'] } }] };
	const services = taskServices(resources, new FakeFileService(URI.file('/workspace'), { '.vscode/tasks.json': JSON.stringify(input) }), workspace, terminals);
	const creations: ITerminalCreateOptions[] = [];
	const create = terminals.createTerminal.bind(terminals);
	terminals.createTerminal = async options => { creations.push(options); return create(options); };
	using service = services.createInstance(TaskService);
	const run = await service.run((await service.refresh())[0]!);
	assert.deepEqual({ execution: creations[0].execution, cwd: creations[0].cwd, writes: (terminals.instances[0] as FakeTerminalInstance).writes }, {
		execution: { type: 'process', program: 'node', args: ['', 'two words', '/execution/home', '$(touch injected)', '$HOME'] }, cwd: '/workspace/child', writes: [],
	});
	(terminals.instances[0] as FakeTerminalInstance).output('file.ts(1,2): error TS123: Broken\n');
	assert.deepEqual(services.get(IMarkerService).getAll().map(marker => marker.resource.path), ['/execution/home/sources/file.ts']);
	(terminals.instances[0] as FakeTerminalInstance).exit(7);
	assert.deepEqual({ status: run.status, exitCode: run.exitCode, active: service.activeRuns }, { status: 'failed', exitCode: 7, active: [] });
	const unknown = await service.run(service.tasks[0]);
	terminals.instances.find(terminal => terminal.id === unknown.terminalId)!.exit(undefined);
	assert.deepEqual({ status: unknown.status, exitCode: unknown.exitCode, active: service.activeRuns }, { status: 'completed', exitCode: undefined, active: [] });
});

test('background matcher readiness starts a dependent task and termination closes its background process', async () => {
	using resources = new DisposableStore();
	using terminals = new FakeTerminalService();
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	const input = {
		version: '2.0.0', tasks: [
			{ label: 'Watch', type: 'process', command: 'watch', isBackground: true, problemMatcher: { owner: 'compiler', pattern: { regexp: '^(.+):(\\d+):(\\d+): (error|warning): (.+)$', severity: 4, message: 5 }, background: { activeOnStart: true, beginsPattern: '^BUILD$', endsPattern: '^READY$' } } },
			{ label: 'Launch', command: 'launch', dependsOn: 'Watch' },
		]
	};
	const services = taskServices(resources, new FakeFileService(URI.file('/workspace'), { '.vscode/tasks.json': JSON.stringify(input) }), workspace, terminals);
	using service = services.createInstance(TaskService);
	await service.refresh();
	const watchStarted = new DeferredPromise<void>();
	using listener = service.onDidStartTask(run => { if (run.task.label === 'Watch') void watchStarted.complete(undefined); });
	const launch = service.run(service.tasks.find(task => task.label === 'Launch')!);
	await watchStarted.p;
	assert.equal(terminals.instances.length, 1);
	const watch = terminals.instances[0] as FakeTerminalInstance;
	watch.output('BUILD\nfile.ts:2:3: warning: warn');
	watch.output('ing\r\nREA');
	assert.equal(terminals.instances.length, 1);
	watch.output('DY\n');
	const run = await launch;
	assert.deepEqual({ labels: terminals.instances.map(instance => instance.title), markers: services.get(IMarkerService).getAll().map(marker => [marker.resource.path, marker.message, marker.range.start]) }, {
		labels: ['Task: Watch', 'Task: Launch'], markers: [['/workspace/file.ts', 'warning', { lineIndex: 1, columnIndex: 2 }]],
	});
	await service.terminate(run);
	assert.deepEqual(terminals.instances.map(instance => instance.state), ['exited', 'exited']);
});

test('task graph validation rejects cycles before creating any terminal', async () => {
	using resources = new DisposableStore();
	using terminals = new FakeTerminalService();
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	const input = { version: '2.0.0', tasks: [{ label: 'A', command: 'a', dependsOn: 'B' }, { label: 'B', command: 'b', dependsOn: 'A' }] };
	using service = taskServices(resources, new FakeFileService(URI.file('/workspace'), { '.vscode/tasks.json': JSON.stringify(input) }), workspace, terminals).createInstance(TaskService);
	await assert.rejects(service.run((await service.refresh())[0]!), /circular dependency/);
	assert.deepEqual(terminals.instances, []);
});

test('configured provider tasks resolve only at dispatch and preserve their definition and workspace options', async () => {
	using resources = new DisposableStore();
	using terminals = new FakeTerminalService();
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	const input = { version: '2.0.0', tasks: [{ label: 'Extension build', type: 'builder', target: 'app', options: { cwd: '${workspaceFolder}/src', env: { MODE: 'configured' } } }] };
	using service = taskServices(resources, new FakeFileService(URI.file('/workspace'), { '.vscode/tasks.json': JSON.stringify(input) }), workspace, terminals).createInstance(TaskService);
	const creations: ITerminalCreateOptions[] = [];
	const create = terminals.createTerminal.bind(terminals);
	terminals.createTerminal = async options => { creations.push(options); return create(options); };
	let calls = 0;
	using registration = service.registerTaskProvider(createExtensionHostTaskProvider('builder-provider', async (operation, payload): Promise<import('../../../../../platform/extensionHost/common/extensionHostApi.js').JsonValue> => {
		if (operation === 'provideTasks') return { tasks: [] };
		assert.equal(operation, 'resolveTask');
		calls++;
		const definition = (payload as { task: { definition: import('../../../../../platform/extensionHost/common/extensionHostApi.js').JsonValue; }; }).task.definition;
		return { task: { id: 'app', label: 'App', group: 'build', definition, execution: { type: 'process', program: 'builder', args: ['app'] }, env: { MODE: 'provider', EXTRA: 'inherited' } } };
	}, workspace, 'builder'));
	const task = (await service.refresh())[0];
	assert.equal(calls, 0);
	await service.run(task);
	assert.deepEqual({ calls, execution: creations[0].execution, cwd: creations[0].cwd, env: creations[0].env }, { calls: 1, execution: { type: 'process', program: 'builder', args: ['app'] }, cwd: '/workspace/src', env: { MODE: 'configured', EXTRA: 'inherited' } });
});

test('dependency diagnostics prevent the parent task and retain errors in Problems', async () => {
	using resources = new DisposableStore();
	using terminals = new FakeTerminalService();
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	const input = { version: '2.0.0', tasks: [{ label: 'Compile', command: 'compile', problemMatcher: '$tsc' }, { label: 'Launch', command: 'launch', dependsOn: 'Compile' }] };
	const services = taskServices(resources, new FakeFileService(URI.file('/workspace'), { '.vscode/tasks.json': JSON.stringify(input) }), workspace, terminals);
	using service = services.createInstance(TaskService);
	using listener = service.onDidStartTask(run => {
		if (run.task.label === 'Compile') {
			const terminal = terminals.instances[0] as FakeTerminalInstance;
			terminal.output('file.ts(1,2): error TS1000: Broken\n');
			terminal.exit(0);
		}
	});
	await service.refresh();
	await assert.rejects(service.run(service.tasks.find(task => task.label === 'Launch')!), /Dependency 'Compile'.*failed/);
	assert.deepEqual({ terminals: terminals.instances.length, errors: services.get(IMarkerService).getAll().map(marker => [marker.code, marker.message]) }, { terminals: 1, errors: [['1000', 'Broken']] });
});

test('CustomExecution opens after task listeners, receives input and resize, and closes once on termination', async () => {
	using resources = new DisposableStore();
	using placeholderTerminals = new FakeTerminalService();
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	const parent = taskServices(resources, new FakeFileService(URI.file('/workspace'), {}), workspace, placeholderTerminals);
	const services = parent.createChild(new ServiceCollection([ITerminalProcessService, {
		getConnectionState: async () => 'ready', onConnectionState: () => Disposable.None,
		getEnvironment: async () => ({}), listProfiles: async () => [],
		create: async () => { throw new Error('CustomExecution must not spawn a backend shell'); },
		read: async () => { throw new Error('CustomExecution must not poll a backend shell'); },
		write: async () => { throw new Error('CustomExecution must not write to a backend shell'); },
		resize: async () => { throw new Error('CustomExecution must not resize a backend shell'); },
		close: async () => { throw new Error('CustomExecution must not close a backend shell'); },
	}]), resources);
	const terminals = resources.add(services.createInstance(TerminalService));
	services.registerInstance(ITerminalService, terminals);
	using service = services.createInstance(TaskService);
	using writes = new Emitter<string>();
	using exits = new Emitter<number>();
	const calls: unknown[] = [];
	using registration = service.registerTaskProvider({
		id: 'custom', provideTasks: () => [{
			id: 'interactive', label: 'Interactive', group: 'build', definition: { type: 'custom', target: 'app' },
			execution: {
				type: 'custom', callback: definition => {
					assert.deepEqual(definition, { type: 'custom', target: 'app' });
					return {
						onDidWrite: writes.event, onDidClose: exits.event,
						open: dimensions => { calls.push(['open', dimensions]); writes.fire('first line\n'); },
						close: () => { calls.push(['close']); },
						handleInput: data => { calls.push(['input', data]); },
						setDimensions: dimensions => { calls.push(['resize', dimensions]); },
					};
				}
			},
		}]
	});
	const output: string[] = [];
	using start = service.onDidStartTask(run => {
		resources.add(terminals.instances.find(instance => instance.id === run.terminalId)!.onDidWriteData(event => output.push(new TextDecoder().decode(event.data))));
	});
	const run = await service.run((await service.refresh())[0]!);
	const instance = terminals.instances[0];
	await instance.sendText('hello', true);
	instance.resize({ rows: 30, cols: 90 });
	await service.terminate(run);
	await instance.close();
	assert.deepEqual({ calls, output, status: run.status }, { calls: [['open', { columns: 80, rows: 24 }], ['input', 'hello\r'], ['resize', { columns: 90, rows: 30 }], ['close']], output: ['first line\n'], status: 'canceled' });
});

test('Extension Host CustomExecution streams ordered events without a shell and closes when its provider retires', async () => {
	using resources = new DisposableStore();
	using placeholderTerminals = new FakeTerminalService();
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	const parent = taskServices(resources, new FakeFileService(URI.file('/workspace'), {}), workspace, placeholderTerminals);
	const services = parent.createChild(new ServiceCollection([ITerminalProcessService, {
		getConnectionState: async () => 'ready', onConnectionState: () => Disposable.None,
		getEnvironment: async () => ({}), listProfiles: async () => [],
		create: async () => { throw new Error('CustomExecution must not spawn a backend shell'); },
		read: async () => { throw new Error('CustomExecution must not poll a backend shell'); },
		write: async () => { throw new Error('CustomExecution must not write to a backend shell'); },
		resize: async () => { throw new Error('CustomExecution must not resize a backend shell'); },
		close: async () => { throw new Error('CustomExecution must not close a backend shell'); },
	}]), resources);
	const terminals = resources.add(services.createInstance(TerminalService));
	services.registerInstance(ITerminalService, terminals);
	using service = services.createInstance(TaskService);
	const opened = new DeferredPromise<void>();
	const input = new DeferredPromise<void>();
	const closed = new DeferredPromise<void>();
	const operations: string[] = [];
	using registration = service.registerTaskProvider(createExtensionHostTaskProvider('custom-host', async (operation, payload): Promise<import('../../../../../platform/extensionHost/common/extensionHostApi.js').JsonValue> => {
		operations.push(operation);
		if (operation === 'provideTasks') return { tasks: [{ id: 'custom', label: 'Host Custom', group: 'build', definition: { type: 'builder' }, execution: { type: 'custom', id: 'custom' } }] };
		if (operation === 'createTaskTerminal') return { ptyId: 'pty.1', acceptsInput: true };
		assert.equal((payload as { ptyId: string; }).ptyId, 'pty.1');
		if (operation === 'openTaskTerminal') { void opened.complete(undefined); return { events: [{ type: 'data', data: 'first\n' }, { type: 'name', name: 'Provider terminal' }] }; }
		if (operation === 'inputTaskTerminal') { assert.equal((payload as { data: string; }).data, 'hello\r'); void input.complete(undefined); return { events: [{ type: 'data', data: 'echo\n' }] }; }
		if (operation === 'closeTaskTerminal') { void closed.complete(undefined); return null; }
		return { events: [] };
	}, workspace, 'builder'));
	const output: string[] = [];
	using start = service.onDidStartTask(run => resources.add(terminals.instances.find(instance => instance.id === run.terminalId)!.onDidWriteData(event => output.push(new TextDecoder().decode(event.data)))));
	const run = await service.run((await service.refresh())[0]!);
	await opened.p;
	await terminals.instances[0].sendText('hello', true);
	await input.p;
	registration.dispose();
	await closed.p;
	assert.deepEqual({ output, status: run.status, closes: operations.filter(operation => operation === 'closeTaskTerminal').length }, { output: ['first\n', 'echo\n'], status: 'canceled', closes: 1 });
});


test('TaskService awaits the current extension matcher catalog and honors cancellation before dispatch', async () => {
	using resources = new DisposableStore();
	using terminals = new FakeTerminalService();
	const root = URI.file('/workspace');
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
	const services = taskServices(resources, new FakeFileService(root, { '.vscode/tasks.json': JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Contributed', command: 'compiler', problemMatcher: '$task-ready' }] }) }), workspace, terminals).createChild(new ServiceCollection(), resources);
	const manifestJson = JSON.stringify({ name: 'task-ready', publisher: 'acme', version: '1.0.0', contributes: { problemMatchers: [{ name: 'task-ready', owner: 'task-ready', pattern: { regexp: '^(.+):(\\d+) (.+)$', file: 1, line: 2, message: 3 } }] } });
	const catalog = { generation: 2, diagnostics: [], extensions: [{ id: 'acme.task-ready', name: 'task-ready', publisher: 'acme', version: '1.0.0', displayName: 'Task ready', sourceKind: 'plugin' as const, manifestJson, manifestSha256: `sha256:${createHash('sha256').update(manifestJson).digest('hex')}`, packageSha256: 'sha256:' + 'a'.repeat(64) }] };
	const discovered = new DeferredPromise<void>();
	const release = new DeferredPromise<void>();
	registerTestExtensionService(resources, services, { list: async () => { void discovered.complete(undefined); await release.p; return catalog; }, resources: new ExtensionResourceLoaderService(async () => { throw new Error('No matcher resource'); }) });
	using tasks = services.createInstance(TaskService);
	const task = (await tasks.refresh())[0];
	const controller = new AbortController();
	const canceled = assert.rejects(tasks.run(task, controller.signal), isCancellationError);
	await discovered.p;
	assert.equal(terminals.instances.length, 0);
	controller.abort();
	await canceled;
	assert.equal(terminals.instances.length, 0);
	void release.complete(undefined);
	const run = await tasks.run(task);
	assert.equal(terminals.instances.length, 1);
	await tasks.terminate(run);
});

test('first task discovery waits for dormant provider registration without canceling itself', async () => {
	using resources = new DisposableStore();
	const root = URI.file('/workspace');
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
	using terminals = new FakeTerminalService();
	const services = taskServices(resources, new FakeFileService(root, {}), workspace, terminals);
	using tasks = services.createInstance(TaskService);
	const entered = new DeferredPromise<void>();
	const release = new DeferredPromise<void>();
	resources.add(services.get(IExtensionService).registerActivationHandler(async (event, signal) => {
		assert.equal(event, 'onTaskType');
		assert.equal(signal?.aborted, false);
		void entered.complete(undefined);
		await release.p;
		resources.add(tasks.registerTaskProvider({ id: 'lazy', type: 'build', provideTasks: () => [{ id: 'build', label: 'Lazy build', group: 'build', execution: { type: 'process', program: 'builder', args: [] } }] }));
	}));
	const firstDiscovery = tasks.refresh();
	await entered.p;
	assert.equal(tasks.tasks.length, 0);
	void release.complete(undefined);
	assert.deepEqual((await firstDiscovery).map(task => ({ label: task.label, provider: task.providerId })), [{ label: 'Lazy build', provider: 'lazy' }]);
	assert.equal(terminals.instances.length, 0);
});


test('configured task queries retain presentation and expose boolean TaskGroup defaults for globs', async () => {
	using resources = new DisposableStore();
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	using terminals = new FakeTerminalService();
	const document = {
		version: '2.0.0', tasks: [
			{ label: 'TypeScript', command: 'build-ts', group: { kind: 'build', isDefault: '**/*.ts' }, presentation: { panel: 'dedicated', clear: true } },
			{ label: 'Fallback', command: 'build-all', group: { kind: 'build', isDefault: true }, presentation: { panel: 'shared', clear: false } },
		]
	};
	const services = taskServices(resources, new FakeFileService(workspace.getWorkspace().folders[0]!.uri, { '.vscode/tasks.json': JSON.stringify(document) }), workspace, terminals);
	const tasks = resources.add(services.createInstance(TaskService));
	services.registerInstance(ITaskService, tasks);
	services.registerInstance(IExtensionHostApi, { invoke: async () => { throw new Error('Catalog queries must not invoke an extension'); } } as unknown as IExtensionHostApi);
	const bridge = resources.add(services.createInstance(MainThreadTask, 5000, (error: unknown) => { throw error; }));
	const response = await bridge.handle({ operation: 'fetchTasks', taskType: null, version: null }, new AbortController().signal);
	assert.equal(response.result, 'tasks');
	if (response.result !== 'tasks') throw new Error('Expected task catalog');
	assert.deepEqual(tasks.tasks.map(task => [task.label, task.groupIsDefault]), [['Fallback', true], ['TypeScript', '**/*.ts']]);
	assert.deepEqual(response.tasks.map(task => {
		const value = task as { name: string; groupIsDefault: boolean; };
		return [value.name, value.groupIsDefault];
	}), [['Fallback', true], ['TypeScript', false]]);
	assert.deepEqual(response.tasks.map(task => ({ ...(task as { presentation: object; }).presentation })), [{ panel: 'shared', clear: false }, { panel: 'dedicated', clear: true }]);
	assert.equal(terminals.instances.length, 0);
});

for (const placement of ['task', 'taskPlain', 'defaults', 'taskPlatform', 'defaultsPlatform', 'unconfigured', 'provided'] as const) {
	test(`resolving an extension task preserves group precedence through execution (${placement})`, async () => {
		using resources = new DisposableStore();
		const services = workbenchInstantiationService(resources);
		registerTestWorkbenchInteractionServices(resources, services);
		const workspace = services.get(IWorkspaceContextService) as WorkspaceContextService;
		const root = URI.file('/workspace');
		workspace.updateWorkspace({ id: 'workspace', uri: root });
		const group = placement === 'task' ? { kind: 'build', isDefault: '**/*.ts' } : 'build';
		const configuredTask = {
			label: 'TypeScript', type: 'builder', target: 'ts', presentation: { focus: false },
			...(placement === 'task' || placement === 'taskPlain' ? { group } : {}),
			...(placement === 'taskPlatform' ? { linux: { group } } : {}),
		};
		const document = {
			version: '2.0.0', tasks: placement === 'provided' ? [] : [configuredTask],
			...(placement === 'defaults' ? { group } : {}),
			...(placement === 'defaultsPlatform' ? { linux: { group } } : {}),
		};
		services.registerInstance(IFileService, resources.add(createTestFileService(new FakeFileService(root, { '.vscode/tasks.json': JSON.stringify(document) }))));
		services.registerInstance(IPathService, new BrowserPathService({ ...createDisconnectedRendererApi(), hasAppServer: true, appServer: { ...createDisconnectedRendererApi().appServer, operatingSystem: OperatingSystem.Linux } }, workspace));
		services.registerSingleton(ICommandService, () => new CommandService(services));
		services.registerInstance(ILogService, new NullLoggerService());
		services.registerInstance(IMarkerService, resources.add(new MarkerService()));
		registerTestExtensionService(resources, services);
		const created: unknown[] = [];
		const closed: string[] = [];
		services.registerInstance(ITerminalProcessService, {
			getConnectionState: async () => 'ready', onConnectionState: Event.None,
			getEnvironment: async () => ({}), listProfiles: async () => [{ profileId: 'shell', title: 'Shell', isDefault: true }],
			create: async options => {
				created.push(options);
				return { ready: { pid: 100, cwd: '/workspace' }, terminalId: 'resolved-task', profile: { profileId: 'shell', title: 'Shell', isDefault: true }, connectionPersistence: 'connectionOwned' };
			},
			read: async () => ({ terminalId: 'resolved-task', commandEventGap: false, chunks: [], nextSequence: 0, commandEvents: [], nextCommandSequence: 0, exited: false, exitCode: undefined, outputGap: false }),
			write: async () => { }, resize: async () => { }, close: async options => { closed.push(options.terminalId); },
		});
		services.registerInstance(IConfigurationResolverService, resources.add(services.createInstance(ConfigurationResolverService)));
		services.registerInstance(ITerminalService, resources.add(services.createInstance(TerminalService)));
		const tasks = resources.add(services.createInstance(TaskService));
		resources.add(tasks.registerTaskProvider({
			id: 'builder', type: 'builder', provideTasks: () => placement === 'provided' ? [{ id: 'provided', label: 'TypeScript', group: 'build', definition: { type: 'builder', target: 'ts' }, presentation: { focus: false } }] : [],
			resolveTask: task => ({ id: 'resolved', label: 'Suggested name', group: 'test', groupIsDefault: true, definition: task.definition, presentation: { panel: 'dedicated', reveal: 'never', focus: true }, execution: { type: 'process', program: 'compiler', args: [] } }),
		}));
		const [configured] = await tasks.refresh();
		const run = await tasks.run(configured!);
		assert.deepEqual(run.task.presentation, { panel: 'dedicated', reveal: 'never', focus: false });
		assert.deepEqual({ label: run.task.label, group: run.task.group, default: run.task.groupIsDefault, created }, { label: 'TypeScript', group: placement === 'unconfigured' ? 'test' : 'build', default: placement === 'task' ? '**/*.ts' : placement === 'unconfigured' ? true : undefined, created: [{ rows: 24, cols: 80, profile: { type: 'default' }, env: {}, execution: { type: 'process', program: 'compiler', args: [] } }] });
		await tasks.terminate(run);
		assert.deepEqual(closed, ['resolved-task']);
	});
}

suite('Extension task execution lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const provided of [false, true, 'custom', 'resolve', 'edited', 'fetched-custom'] as const) {
		for (const retireObserver of [false, true]) {
			if (provided === 'custom' && retireObserver) continue;
			test(`queries and executes the canonical catalog and waits for process release with observer retirement ${retireObserver} and provided Task ${provided}`, async () => {
				const customExecution = provided === 'custom' || provided === 'fetched-custom';
				const group = provided === 'edited' ? 'rebuild' : provided === 'custom' ? 'clean' : retireObserver ? 'test' : 'build';
				const groupIsDefault = !retireObserver;
				using resources = new DisposableStore();
				const services = workbenchInstantiationService(resources);
				registerTestWorkbenchInteractionServices(resources, services);
				const root = URI.file('/workspace');
				const workspace = services.get(IWorkspaceContextService) as WorkspaceContextService;
				workspace.updateWorkspace({ id: 'workspace', folders: [{ id: 'workspace', uri: root, name: 'Workspace', index: 0 }, { id: 'second', uri: URI.file('/workspace/second'), name: 'Second', index: 1 }] });
				services.registerInstance(IFileService, resources.add(createTestFileService(new FakeFileService(root, {}))));
				services.registerInstance(IPathService, new BrowserPathService(createDisconnectedRendererApi(), workspace));
				services.registerSingleton(ICommandService, () => new CommandService(services));
				services.registerInstance(ILogService, new NullLoggerService());
				services.registerInstance(IMarkerService, resources.add(new MarkerService()));
				registerTestExtensionService(resources, services);
				const releaseRequested = new DeferredPromise<void>();
				const releaseAcknowledged = new DeferredPromise<void>();
				const producerCalls: string[] = [];
				const writes: unknown[] = [];
				const processes: ITerminalProcessService = {
					getConnectionState: async () => 'ready', onConnectionState: Event.None,
					getEnvironment: async () => ({}),
					listProfiles: async () => [{ profileId: 'shell', title: 'Shell', isDefault: true }],
					create: async options => {
						writes.push(options);
						return { ready: { pid: 1234, cwd: '/workspace' }, terminalId: 'task-process', profile: { profileId: 'shell', title: 'Shell', isDefault: true }, connectionPersistence: 'connectionOwned' };
					},
					read: async () => ({ terminalId: 'task-process', commandEventGap: false, chunks: [], nextSequence: 0, commandEvents: [], nextCommandSequence: 0, exited: false, exitCode: undefined, outputGap: false }),
					write: async () => { }, resize: async () => { },
					close: async () => { void releaseRequested.complete(undefined); await releaseAcknowledged.p; },
				};
				services.registerInstance(ITerminalProcessService, processes);
				services.registerInstance(IConfigurationResolverService, resources.add(services.createInstance(ConfigurationResolverService)));
				services.registerInstance(ITerminalService, resources.add(services.createInstance(TerminalService)));
				const tasks = resources.add(services.createInstance(TaskService));
				services.registerInstance(ITaskService, tasks);
				resources.add(tasks.registerTaskProvider(createExtensionHostTaskProvider('builder', async (operation, payload): Promise<JsonValue> => {
					if (provided === 'fetched-custom' && operation !== 'provideTasks' && operation !== 'resolveTask') {
						producerCalls.push(operation);
						if (operation === 'createTaskTerminal') {
							assert.deepEqual(JSON.parse(JSON.stringify((payload as { definition: JsonValue; }).definition)), { type: 'builder', folder: retireObserver ? '/workspace/second' : '/workspace', target: 'edited' });
							return { ptyId: 'producer-custom', acceptsInput: true };
						}
						if (operation === 'closeTaskTerminal') {
							void releaseRequested.complete(undefined);
							await releaseAcknowledged.p;
							return null;
						}
						return { events: [] };
					}
					if (operation === 'resolveTask') {
						const task = (payload as { task: { definition: JsonValue; source: string; scope: JsonValue; execution?: JsonValue; }; }).task;
						assert.equal(task.execution, undefined);
						assert.equal(task.source, 'Builder source');
						assert.deepEqual(JSON.parse(JSON.stringify(task.scope)), retireObserver ? { uri: 'file:///workspace/second', name: 'Second', index: 1 } : 2);
						return { task: { id: 'resolved', label: 'Resolved', group, groupIsDefault, runOptions: { reevaluateOnRerun: false }, definition: task.definition, execution: { type: 'process', program: 'compiler', args: ['$HOME', ''] } } };
					}
					return {
						tasks: [{
							id: 'watch', label: 'Watch', source: 'Builder source', scope: retireObserver ? { uri: 'file:///workspace/second' } : 2,
							group, groupIsDefault, runOptions: { reevaluateOnRerun: false }, definition: { type: 'builder' }, execution: provided === 'fetched-custom' ? { type: 'custom', id: 'watch' } : { type: 'process', program: 'compiler', args: ['$HOME', ''] },
						}]
					};
				}, workspace, 'builder')));
				const finished = new DeferredPromise<void>();
				const events: { readonly incarnation: number; readonly event: JsonValue; }[] = [];
				services.registerInstance(IExtensionHostApi, {
					...createDisconnectedRendererApi().extensionHost,
					invoke: async (invocation): Promise<JsonValue> => {
						if (provided === 'fetched-custom') assert.equal(invocation.operation, 'taskEvent', 'the caller observer never receives the producer PTY callback');
						if (invocation.operation === 'createTaskTerminal') {
							assert.equal((invocation.payload as { definition: { folder: string; }; }).definition.folder, '/workspace');
							return { ptyId: 'custom-1', acceptsInput: true };
						}
						if (invocation.operation === 'closeTaskTerminal') {
							void releaseRequested.complete(undefined);
							await releaseAcknowledged.p;
							return null;
						}
						if (invocation.operation !== 'taskEvent') return { events: [] };
						events.push({ incarnation: invocation.incarnation, event: invocation.payload });
						if ((invocation.payload as { type: string; }).type === 'end') void finished.complete(undefined);
						return null;
					},
				});
				const errors: unknown[] = [];
				const bridge = resources.add(services.createInstance(MainThreadTask, 5000, (error: unknown) => errors.push(error)));
				const snapshot = (incarnation: number): ExtensionHostFleetSnapshot => ({
					generation: incarnation, extensions: [{
						id: 'extension', version: '1', packageDigest: 'digest', runtimeApiVersion: 1, activationGeneration: 1, incarnation,
						lifecycle: 'ready', failure: undefined, stderr: '', outputEvents: [], registrations: [{ registrationId: 'vscode.tasks.events', kind: 'taskEvents' }],
					}]
				});
				bridge.update(snapshot(1));
				const signal = new AbortController().signal;
				const empty = await bridge.handle({ operation: 'fetchTasks', taskType: 'builder', version: '1.0.0' }, signal);
				assert.deepEqual(empty, { result: 'tasks', sequence: 0, tasks: [], executions: [] });
				const catalog = await bridge.handle({ operation: 'fetchTasks', taskType: 'builder', version: null }, signal);
				assert.equal(catalog.result, 'tasks');
				if (catalog.result !== 'tasks') throw new Error('Expected task catalog');
				assert.equal(catalog.tasks.length, 1);
				const returned = catalog.tasks[0] as { scope: JsonValue; source: string; group: string; groupIsDefault: boolean; runOptions: { reevaluateOnRerun: boolean; }; };
				assert.deepEqual({ scope: JSON.parse(JSON.stringify(returned.scope)), source: returned.source }, { scope: retireObserver ? { uri: 'file:///workspace/second', name: 'Second', index: 1 } : 2, source: 'Builder source' });
				assert.equal(returned.group, group);
				assert.equal(returned.groupIsDefault, groupIsDefault);
				assert.deepEqual(JSON.parse(JSON.stringify(returned.runOptions)), { reevaluateOnRerun: false });
				assert.deepEqual(writes, [], 'discovery never spawns a process');
				const source = { extensionId: 'extension', activationGeneration: 1, incarnation: 1 };
				if (provided === 'fetched-custom') {
					const snapshot = { id: 'invalid', label: 'Invalid', group: 'build', execution: { type: 'custom', id: 'invalid' } };
					await assert.rejects(bridge.handle({ operation: 'executeTask', taskId: 'removed-custom', task: snapshot }, signal, source), /current custom catalog execution/);
					await assert.rejects(bridge.handle({ operation: 'executeTask', taskId: (catalog.tasks[0] as { id: string; }).id, task: { ...snapshot, execution: { type: 'process', program: 'compiler', args: [] } } }, signal, source), /current custom catalog execution/);
					await assert.rejects(bridge.handle({ operation: 'executeTask', taskId: (catalog.tasks[0] as { id: string; }).id, task: snapshot }, signal), /authenticated extension owner/);
					assert.deepEqual(producerCalls, [], 'invalid selections never invoke a producer callback');
				}
				const execution = await bridge.handle(provided ? {
					operation: 'executeTask', taskId: provided === 'fetched-custom' ? (catalog.tasks[0] as { id: string; }).id : null, task: {
						id: 'explicit', label: provided === 'edited' ? 'Edited Watch' : 'Explicit', source: 'Builder source', scope: retireObserver ? { uri: 'file:///workspace/second' } : 2,
						group, groupIsDefault, runOptions: { reevaluateOnRerun: false }, definition: { type: 'builder', folder: '${workspaceFolder}', ...(provided === 'fetched-custom' ? { target: 'edited' } : {}) }, ...(provided === 'resolve' ? {} : { execution: customExecution ? { type: 'custom', id: 'explicit' } : { type: 'process', program: 'compiler', args: provided === 'edited' ? ['$HOME', 'two words', ''] : ['$HOME', ''] } }),
					}
				} : { operation: 'executeTask', taskId: (catalog.tasks[0] as { id: string; }).id, task: null }, signal, source);
				assert.equal(execution.result, 'taskExecution');
				if (execution.result !== 'taskExecution') throw new Error('Expected execution');
				if (customExecution) assert.deepEqual(writes, [], 'CustomExecution creates no backend process');
				else assert.equal((writes[0] as { dirId: string; }).dirId, retireObserver ? 'second' : 'workspace');
				if (provided === 'edited') {
					assert.deepEqual((writes[0] as { execution: unknown; }).execution, { type: 'process', program: 'compiler', args: ['$HOME', 'two words', ''] });
					assert.equal(tasks.lastRun?.task.label, 'Edited Watch');
					assert.equal(tasks.tasks[0]!.label, 'Watch');
				}
				assert.equal((execution.execution as { task: { group: string; }; }).task.group, group);
				assert.equal(tasks.lastRun?.task.groupIsDefault, groupIsDefault);
				assert.deepEqual(tasks.lastRun?.task.runOptions, { reevaluateOnRerun: false });
				if (provided === 'fetched-custom') {
					assert.equal(tasks.lastRun?.task.label, 'Explicit');
					assert.equal(tasks.tasks[0]!.label, 'Watch');
					assert.deepEqual(JSON.parse(JSON.stringify(tasks.tasks[0]!.definition)), { type: 'builder' });
					assert.equal(producerCalls.filter(operation => operation === 'createTaskTerminal').length, 1);
				}
				const executionId = (execution.execution as { id: string; }).id;
				const termination = provided && retireObserver ? (bridge.update(snapshot(2)), Promise.resolve({ result: 'done' })) : bridge.handle({ operation: 'terminateTask', executionId }, signal);
				await releaseRequested.p;
				assert.equal(tasks.lastRun?.status, 'canceled');
				assert.equal(events.some(({ event }) => ['processEnd', 'end'].includes((event as { type: string; }).type)), false);
				if (retireObserver) bridge.update(snapshot(2));
				void releaseAcknowledged.complete(undefined);
				await termination;
				// The retired observer cannot deliver completion to the replacement incarnation.
				await Promise.resolve();
				if (retireObserver) {
					assert.equal(events.some(({ event }) => (event as { type: string; }).type === 'end'), false);
				} else {
					await finished.p;
					assert.ok(events.filter(({ event }) => (event as { type: string; }).type !== 'snapshot').every(({ event }) => (event as { execution: { task: { group: string; groupIsDefault: boolean; }; }; }).execution.task.group === group && (event as { execution: { task: { groupIsDefault: boolean; }; }; }).execution.task.groupIsDefault === groupIsDefault));
					assert.deepEqual(events.map(({ incarnation, event }) => [incarnation, (event as { type: string; }).type]), customExecution ? [[1, 'snapshot'], [1, 'start'], [1, 'end']] : [[1, 'snapshot'], [1, 'start'], [1, 'processStart'], [1, 'processEnd'], [1, 'end']]);
					assert.equal((events.at(-1)!.event as { execution: { id: string; active: boolean; }; }).execution.id, executionId);
				}
				assert.deepEqual(errors, []);
				if (provided === 'fetched-custom') assert.equal(producerCalls.filter(operation => operation === 'closeTaskTerminal').length, 1);
				bridge.clear();
			});
		}
	}
});


suite('Task rerun variable policy through the execution owners', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const kind of ['configured', 'provided', 'custom'] as const) {
		for (const reevaluate of [false, true]) {
			test(`${kind} rerun reevaluates variables ${reevaluate} and preserves current literals and authority`, async () => {
				using resources = new DisposableStore();
				const services = workbenchInstantiationService(resources);
				registerTestWorkbenchInteractionServices(resources, services);
				const workspace = services.get(IWorkspaceContextService) as WorkspaceContextService;
				const root = URI.file('/rerun');
				workspace.updateWorkspace({ id: 'rerun', uri: root });
				const runOptions = { reevaluateOnRerun: reevaluate };
				const configured = { label: 'Rerun', type: 'process', command: 'compiler', args: ['old', '${env:MODE}', '${command:rerun.test.value}'], runOptions };
				const documents = { '.vscode/tasks.json': JSON.stringify({ version: '2.0.0', tasks: kind === 'configured' ? [configured] : [] }) };
				const files = resources.add(createTestFileService(new FakeFileService(root, documents)));
				services.registerInstance(IFileService, files);
				services.registerInstance(IPathService, new BrowserPathService(createDisconnectedRendererApi(), workspace));
				services.registerSingleton(ICommandService, () => new CommandService(services));
				services.registerInstance(ILogService, new NullLoggerService());
				services.registerInstance(IMarkerService, resources.add(new MarkerService()));
				registerTestExtensionService(resources, services);
				let environmentReads = 0;
				let commandCalls = 0;
				const commandsSeen: unknown[] = [];
				resources.add(CommandsRegistry.register('rerun.test.value', (_accessor, config) => {
					commandsSeen.push(config);
					return `value-${++commandCalls}-${'${command:rerun.test.value}'}-$HOME`;
				}));
				const launches: unknown[] = [];
				services.registerInstance(ITerminalProcessService, {
					getConnectionState: async () => 'ready', onConnectionState: Event.None,
					getEnvironment: async () => ({ MODE: `mode-${++environmentReads}`, EXTRA: 'new-variable' }),
					listProfiles: async () => [{ profileId: 'shell', title: 'Shell', isDefault: true }],
					create: async options => {
						launches.push(options.execution);
						return { ready: { pid: 1234, cwd: '/rerun' }, terminalId: `process-${launches.length}`, profile: { profileId: 'shell', title: 'Shell', isDefault: true }, connectionPersistence: 'connectionOwned' };
					},
					read: async options => ({ terminalId: options.terminalId, commandEventGap: false, chunks: [], nextSequence: 0, commandEvents: [], nextCommandSequence: 0, exited: false, exitCode: undefined, outputGap: false }),
					write: async () => { }, resize: async () => { }, close: async () => { },
				});
				services.registerInstance(IConfigurationResolverService, resources.add(services.createInstance(ConfigurationResolverService)));
				const terminals = resources.add(services.createInstance(TerminalService));
				services.registerInstance(ITerminalService, terminals);
				const tasks = resources.add(services.createInstance(TaskService));
				const definitions: unknown[] = [];
				const task = {
					id: 'rerun', label: 'Rerun', group: 'build' as const, runOptions,
					definition: { type: 'rerun', mode: '${env:MODE}', value: '${command:rerun.test.value}' },
					execution: kind === 'custom' ? {
						type: 'custom' as const,
						callback: (definition: unknown) => {
							definitions.push(definition);
							const write = resources.add(new Emitter<string>());
							return { onDidWrite: write.event, open() { }, close() { } };
						},
					} : { type: 'process' as const, program: 'compiler', args: configured.args },
				};
				if (kind === 'custom') resources.add(tasks.registerTaskProvider({ id: 'rerun', provideTasks: () => [task] }));
				const authority = new AbortController();
				const first = kind === 'provided' ? await tasks.runProvidedTask('explicit', task, authority.signal)
					: await tasks.run((await tasks.refresh())[0]);
				await tasks.terminate(first);
				if (kind === 'configured') {
					// Current literals and newly introduced variables still come from the
					// current file; retained values apply only to matching references.
					documents['.vscode/tasks.json'] = JSON.stringify({ version: '2.0.0', tasks: [{ ...configured, args: ['updated', '${env:MODE}', '${command:rerun.test.value}', '${env:EXTRA}'] }] });
				}
				const second = await tasks.rerun(first.terminalId);
				assert.ok(second);
				const index = reevaluate ? 2 : 1;
				const literal = `value-${index}-${'${command:rerun.test.value}'}-$HOME`;
				if (kind === 'custom') {
					assert.deepEqual(definitions, [
						{ type: 'rerun', mode: 'mode-1', value: `value-1-${'${command:rerun.test.value}'}-$HOME` },
						{ type: 'rerun', mode: `mode-${index}`, value: literal },
					]);
					assert.equal(launches.length, 0);
				} else {
					assert.deepEqual(launches[1], {
						type: 'process', program: 'compiler', args: kind === 'configured'
							? ['updated', `mode-${index}`, literal, 'new-variable'] : ['old', `mode-${index}`, literal]
					});
				}
				assert.equal(commandCalls, index);
				assert.equal(environmentReads, kind === 'configured' ? 2 : index);
				assert.equal(commandsSeen.length, index);
				await tasks.terminate(second);
				if (kind === 'provided') {
					authority.abort();
					await assert.rejects(tasks.rerun(second.terminalId), isCancellationError);
				} else {
					workspace.updateWorkspace({ id: 'replacement', uri: URI.file('/replacement') });
					assert.equal(await tasks.rerun(second.terminalId), undefined);
				}
				assert.equal(commandCalls, index);
			});
		}
	}
});


suite('Task instance limits through the execution owners', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const kind of ['process', 'custom'] as const) {
		for (const limit of [1, 2]) {
			test(`${kind} reserves ${limit} pending instances, shares at capacity and releases completed slots`, async () => {
				using resources = new DisposableStore();
				const services = workbenchInstantiationService(resources);
				registerTestWorkbenchInteractionServices(resources, services);
				const workspace = services.get(IWorkspaceContextService) as WorkspaceContextService;
				const root = URI.file('/instances');
				workspace.updateWorkspace({ id: 'instances', uri: root });
				const files = resources.add(createTestFileService(new FakeFileService(root, {
					'.vscode/tasks.json': JSON.stringify({ version: '2.0.0', tasks: kind === 'process' ? [{ label: 'Limited', type: 'process', command: 'compiler', runOptions: { instanceLimit: limit, instancePolicy: 'silent' } }] : [] }),
				})));
				services.registerInstance(IFileService, files);
				services.registerInstance(IPathService, new BrowserPathService(createDisconnectedRendererApi(), workspace));
				services.registerInstance(ILogService, new NullLoggerService());
				services.registerSingleton(ICommandService, () => new CommandService(services));
				services.registerInstance(IMarkerService, resources.add(new MarkerService()));
				registerTestExtensionService(resources, services);
				const release = new DeferredPromise<void>();
				const closeRelease = new DeferredPromise<void>();
				let holdClose = false;
				let shouldFail = true;
				const prepared = Array.from({ length: limit }, () => new DeferredPromise<void>());
				let creations = 0;
				const prepare = async (): Promise<number> => {
					if (shouldFail) { shouldFail = false; throw new Error('prepare failed'); }
					const index = creations++;
					void prepared[index]?.complete(undefined);
					await release.p;
					return index;
				};
				services.registerInstance(ITerminalProcessService, {
					getConnectionState: async () => 'ready', onConnectionState: Event.None,
					getEnvironment: async () => ({}), listProfiles: async () => [{ profileId: 'shell', title: 'Shell', isDefault: true }],
					create: async () => ({ ready: { pid: 1234, cwd: '/instances' }, terminalId: `process-${await prepare()}`, profile: { profileId: 'shell', title: 'Shell', isDefault: true }, connectionPersistence: 'connectionOwned' }),
					read: async options => ({ terminalId: options.terminalId, commandEventGap: false, chunks: [], nextSequence: 0, commandEvents: [], nextCommandSequence: 0, exited: false, exitCode: undefined, outputGap: false }),
					write: async () => { }, resize: async () => { }, close: async () => { if (holdClose) await closeRelease.p; },
				});
				services.registerInstance(IConfigurationResolverService, resources.add(services.createInstance(ConfigurationResolverService)));
				const terminals = resources.add(services.createInstance(TerminalService));
				services.registerInstance(ITerminalService, terminals);
				const tasks = resources.add(services.createInstance(TaskService));
				if (kind === 'custom') resources.add(tasks.registerTaskProvider({
					id: 'instances', provideTasks: () => [{
						id: 'limited', label: 'Limited', group: 'build', runOptions: { instanceLimit: limit, instancePolicy: 'silent' }, execution: {
							type: 'custom', callback: async () => {
								await prepare();
								const write = resources.add(new Emitter<string>());
								return { releaseCompletion: closeRelease.p, onDidWrite: write.event, open() { }, close() { } };
							},
						}
					}],
				}));
				const task = (await tasks.refresh())[0];
				await assert.rejects(tasks.run(task), /prepare failed/);
				assert.equal(terminals.instances.length, 0);
				const owners: Promise<ITaskRun>[] = [];
				for (let index = 0; index < limit; index++) {
					owners.push(tasks.run(task));
					await prepared[index].p;
				}
				const cancellation = new AbortController();
				const canceled = assert.rejects(tasks.run(task, cancellation.signal), isCancellationError);
				const joined = tasks.run(task);
				await new Promise<void>(resolve => setImmediate(resolve));
				cancellation.abort();
				await canceled;
				assert.equal(creations, limit);
				void release.complete(undefined);
				const runs = await Promise.all(owners);
				assert.equal(await joined, runs[0]);
				assert.equal(tasks.activeRuns.length, limit);
				assert.equal(terminals.instances.length, limit);
				assert.equal(await tasks.run(task), runs[0]);
				holdClose = true;
				const stopping = tasks.terminate(runs[0]);
				assert.equal(runs[0].status, 'canceled');
				assert.equal(await tasks.run(task), runs[limit === 1 ? 0 : 1]);
				assert.equal(creations, limit, 'release still holds its capacity');
				void closeRelease.complete(undefined);
				await stopping;
				const replacement = await tasks.run(task);
				assert.notEqual(replacement, runs[0]);
				assert.equal(creations, limit + 1);
				assert.equal(tasks.activeRuns.length, limit);
				for (const run of tasks.activeRuns) await tasks.terminate(run);
				assert.equal(terminals.instances.length, 0);
			});
		}
	}
});

suite('Task instance policies through the execution owners', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('refresh follows a replacement provider discovery and never returns the superseded catalog to its caller', async () => {
		using resources = new DisposableStore();
		const { tasks, peer } = executionServices(resources, {});
		const entered = new DeferredPromise<void>();
		const pending = new DeferredPromise<readonly TaskProviderTask[]>();
		const registration = resources.add(tasks.registerTaskProviders([{
			id: 'refresh-owner', provideTasks: () => { void entered.complete(); return pending.p; },
		}]));
		const original = tasks.refresh();
		await entered.p;
		registration.replace([{ id: 'refresh-owner', provideTasks: async () => [{ id: 'fresh', label: 'Current task', group: 'test', execution: { type: 'process', program: 'fresh', args: [] } }] }]);
		const result = await original;
		void pending.complete([{ id: 'stale', label: 'Removed task', group: 'test', execution: { type: 'process', program: 'stale', args: [] } }]);
		assert.deepEqual({ returned: result.map(task => task.label), current: tasks.tasks.map(task => task.label), spawned: peer.creations }, { returned: ['Current task', 'Policy'], current: ['Current task', 'Policy'], spawned: 0 });
	});

	test('configuration changes cancel an initial provider discovery and publish its replacement catalog', async () => {
		using resources = new DisposableStore();
		const changes = resources.add(new Emitter<IFileChangeEvent>());
		const { tasks, peer } = executionServices(resources, {}, changes.event);
		const entered = new DeferredPromise<void>();
		const pending = new DeferredPromise<readonly TaskProviderTask[]>();
		let calls = 0;
		let cancelled = false;
		resources.add(tasks.registerTaskProvider({
			id: 'changing', provideTasks: signal => {
				if (++calls === 1) {
					signal.addEventListener('abort', () => { cancelled = true; }, { once: true });
					void entered.complete();
					return pending.p;
				}
				return [{ id: 'current', label: 'Current task', group: 'test', execution: { type: 'process', program: 'current', args: [] } }];
			}
		}));
		const original = tasks.refresh();
		await entered.p;
		changes.fire({ resources: [URI.file('/policy/.vscode/tasks.json')] });
		const result = await original;
		void pending.complete([]);
		assert.deepEqual({ cancelled, calls, returned: result.map(task => task.label), current: tasks.tasks.map(task => task.label), spawned: peer.creations }, { cancelled: true, calls: 2, returned: ['Current task', 'Policy'], current: ['Current task', 'Policy'], spawned: 0 });
	});

	function executionServices(owner: DisposableStore, runOptions: { instanceLimit?: number; instancePolicy?: 'terminateOldest' | 'terminateNewest' | 'prompt' | 'warn' | 'silent'; }, fileChanges: Event<IFileChangeEvent> = Event.None) {
		const parent = workbenchInstantiationService(owner);
		registerTestWorkbenchInteractionServices(owner, parent);
		const services = parent.createChild(new ServiceCollection(), owner);
		const workspace = services.get(IWorkspaceContextService) as WorkspaceContextService;
		const root = URI.file('/policy');
		workspace.updateWorkspace({ id: 'policy', uri: root });
		services.registerInstance(IFileService, owner.add(createTestFileService(new FakeFileService(root, { '.vscode/tasks.json': JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Policy', type: 'process', command: 'compiler', runOptions }] }) }, fileChanges))));
		services.registerInstance(IFileSearchService, services.createInstance(BrowserFileSearchService));
		services.registerInstance(IPathService, new BrowserPathService(createDisconnectedRendererApi(), workspace));
		services.registerInstance(ILogService, new NullLoggerService());
		services.registerSingleton(ICommandService, () => new CommandService(services));
		services.registerInstance(IMarkerService, owner.add(new MarkerService()));
		registerTestExtensionService(owner, services);
		const dom = new JSDOM('<!doctype html><body></body>');
		owner.add(toDisposable(() => dom.window.close()));
		const quickInput = owner.add(new WorkbenchQuickInputService({ container: dom.window.document.body, contextKeyService: owner.add(new ContextKeyService()) }));
		services.registerInstance(IQuickInputService, quickInput);
		const peer = {
			creations: 0, closed: [] as string[], close: async (_id: string): Promise<void> => { },
		};
		services.registerInstance(ITerminalProcessService, {
			getConnectionState: async () => 'ready', onConnectionState: Event.None,
			getEnvironment: async () => ({}), listProfiles: async () => [{ profileId: 'shell', title: 'Shell', isDefault: true }],
			create: async () => ({ ready: { pid: ++peer.creations, cwd: '/policy' }, terminalId: `policy-${peer.creations}`, profile: { profileId: 'shell', title: 'Shell', isDefault: true }, connectionPersistence: 'connectionOwned' }),
			read: async options => ({ terminalId: options.terminalId, commandEventGap: false, chunks: [], nextSequence: 0, commandEvents: [], nextCommandSequence: 0, exited: false, exitCode: undefined, outputGap: false }),
			write: async () => { }, resize: async () => { }, close: async options => { peer.closed.push(options.terminalId); await peer.close(options.terminalId); },
		});
		services.registerInstance(IConfigurationResolverService, owner.add(services.createInstance(ConfigurationResolverService)));
		const terminals = owner.add(services.createInstance(TerminalService));
		services.registerInstance(ITerminalService, terminals);
		const tasks = owner.add(services.createInstance(TaskService));
		return { services, workspace, tasks, terminals, dom, quickInput, peer };
	}

	async function pickerInput(owner: DisposableStore, dom: JSDOM): Promise<HTMLInputElement> {
		return new Promise(resolve => {
			const find = (): boolean => {
				const input = dom.window.document.querySelector<HTMLInputElement>('.ash-quick-pick input');
				if (!input) return false;
				resolve(input);
				return true;
			};
			const observer = new dom.window.MutationObserver(() => { if (find()) observer.disconnect(); });
			owner.add(toDisposable(() => observer.disconnect()));
			if (!find()) observer.observe(dom.window.document.body, { childList: true, subtree: true });
		});
	}

	for (const instancePolicy of ['terminateOldest', 'terminateNewest'] as const) {
		test(`${instancePolicy} serializes replacement decisions and waits for the selected process release`, async () => {
			using resources = new DisposableStore();
			const { tasks, peer } = executionServices(resources, { instanceLimit: 2, instancePolicy });
			const task = (await tasks.refresh())[0];
			const first = await tasks.run(task);
			const second = await tasks.run(task);
			const closing = new DeferredPromise<void>();
			const release = new DeferredPromise<void>();
			peer.close = async () => { if (!closing.isSettled) { void closing.complete(undefined); await release.p; } };
			const third = tasks.run(task);
			const thirdOutcome = third.then(run => ({ run, error: undefined }), error => ({ run: undefined, error }));
			await closing.p;
			assert.equal(peer.creations, 2, 'replacement cannot spawn before release');
			const canceled = new AbortController();
			const canceledAdmission = assert.rejects(tasks.run(task, canceled.signal), isCancellationError);
			const fourth = tasks.run(task);
			canceled.abort();
			await canceledAdmission;
			void release.complete(undefined);
			const [thirdResult, fourthRun] = await Promise.all([thirdOutcome, fourth]);
			if (instancePolicy === 'terminateOldest') assert.equal(thirdResult.error, undefined);
			else if (thirdResult.run) assert.equal(thirdResult.run.status, 'canceled');
			if (thirdResult.error) assert.ok(isCancellationError(thirdResult.error));
			assert.deepEqual(peer.closed, instancePolicy === 'terminateOldest' ? ['policy-1', 'policy-2'] : ['policy-2', 'policy-3']);
			assert.deepEqual(tasks.activeRuns.map(run => run.terminalId), instancePolicy === 'terminateOldest' ? [thirdResult.run!.terminalId, fourthRun.terminalId] : [first.terminalId, fourthRun.terminalId]);
			assert.equal(peer.creations, 4);
			assert.equal(second.status, 'canceled');
			for (const run of tasks.activeRuns) await tasks.terminate(run);
		});
	}

	for (const instancePolicy of ['warn', 'silent'] as const) {
		test(`${instancePolicy} leaves the running instance intact and only warn creates a localized notification`, async () => {
			using resources = new DisposableStore();
			using localization = toDisposable(resetNlsResolver);
			initializeTestLocalization('zh-CN');
			const { tasks, services, peer } = executionServices(resources, { instancePolicy });
			const task = (await tasks.refresh())[0];
			const run = await tasks.run(task);
			assert.equal(await tasks.run(task), run);
			assert.deepEqual({ created: peer.creations, closed: peer.closed, messages: services.get(INotificationService).getNotifications().map(item => item.message) }, { created: 1, closed: [], messages: instancePolicy === 'warn' ? ['任务“Policy”已达到同时运行 1 个实例的上限。'] : [] });
			await tasks.terminate(run);
		});
	}

	for (const selection of ['accept', 'escape', 'caller cancellation', 'workspace replacement', 'instance completion'] as const) {
		test(`the default policy uses the real keyboard picker and handles ${selection}`, async () => {
			using resources = new DisposableStore();
			using localization = toDisposable(resetNlsResolver);
			initializeTestLocalization('zh-CN');
			const { tasks, workspace, dom, quickInput, peer } = executionServices(resources, { instanceLimit: 2 });
			const task = (await tasks.refresh())[0];
			const first = await tasks.run(task);
			const second = await tasks.run(task);
			const cancellation = new AbortController();
			const next = tasks.run(task, cancellation.signal);
			const rejected = selection === 'escape' || selection === 'caller cancellation' || selection === 'workspace replacement' ? assert.rejects(next, isCancellationError) : undefined;
			const input = await pickerInput(resources, dom);
			assert.equal(input.getAttribute('aria-label'), '任务“Policy”已达到实例上限。请选择要终止并重新启动的实例。');
			assert.equal(peer.creations, 2);
			if (selection === 'accept') {
				input.value = '实例 2';
				input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
				input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
			} else if (selection === 'escape') input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			else if (selection === 'caller cancellation') cancellation.abort();
			else if (selection === 'workspace replacement') workspace.updateWorkspace({ id: 'replacement', uri: URI.file('/replacement') });
			else await tasks.terminate(first);
			if (rejected) await rejected;
			else assert.equal((await next).status, 'running');
			assert.equal(quickInput.currentQuickInput, undefined);
			assert.deepEqual({ created: peer.creations, closed: peer.closed }, selection === 'accept' ? { created: 3, closed: ['policy-2'] } : selection === 'instance completion' ? { created: 3, closed: ['policy-1'] } : selection === 'workspace replacement' ? { created: 2, closed: ['policy-1', 'policy-2'] } : { created: 2, closed: [] });
			assert.equal(second.status, selection === 'accept' || selection === 'workspace replacement' ? 'canceled' : 'running');
			for (const run of tasks.activeRuns) await tasks.terminate(run);
		});
	}

	test('replacement cancels a preparing custom owner and closes its late PTY exactly once', async () => {
		using resources = new DisposableStore();
		const { tasks, peer } = executionServices(resources, {});
		const entered = new DeferredPromise<void>();
		const late = new DeferredPromise<void>();
		const closed = new DeferredPromise<void>();
		let callbacks = 0;
		let closes = 0;
		resources.add(tasks.registerTaskProvider({
			id: 'custom-policy', provideTasks: () => [{
				id: 'prepare', label: 'Prepare', group: 'build', runOptions: { instancePolicy: 'terminateOldest' }, execution: {
					type: 'custom', callback: async () => {
						const first = callbacks++ === 0;
						if (first) { void entered.complete(undefined); await late.p; }
						const writes = resources.add(new Emitter<string>());
						return { onDidWrite: writes.event, open() { }, close() { if (first) { closes++; void closed.complete(undefined); } } };
					}
				}
			}]
		}));
		const task = (await tasks.refresh()).find(task => task.label === 'Prepare')!;
		const owner = assert.rejects(tasks.run(task), isCancellationError);
		await entered.p;
		const replacement = await tasks.run(task);
		await owner;
		assert.equal(callbacks, 2);
		assert.equal(peer.creations, 0);
		void late.complete(undefined);
		await closed.p;
		assert.equal(closes, 1);
		assert.deepEqual(tasks.activeRuns, [replacement]);
		await tasks.terminate(replacement);
	});
});
