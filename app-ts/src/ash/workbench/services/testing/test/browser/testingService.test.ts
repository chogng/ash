import { URI } from '../../../../../base/common/uri.js';
import { TestExecutionService } from '../common/testExecutionService.js';
import { Event } from '../../../../../base/common/event.js';
import { WorkspaceContextService } from '../../../../services/workspaces/browser/workspaceContextService.js';
import { BrowserWorkingCopyService } from '../../../../services/workingCopy/browser/browserWorkingCopyService.js';
import { NullLoggerService } from '../../../../../platform/log/common/log.js';
import { type ITestExecutionService } from '../../../../../platform/testing/common/testExecutionService.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter } from "../../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import { type ITaskRun, type ITaskService, type IWorkspaceTask, type TaskProvider, type TaskProviderRegistration, type TaskRunStatus } from "../../../../services/tasks/common/taskService.js";
import { type ITerminalInstance } from "../../../../services/terminal/common/terminal.js";
import { TestingService } from "../../browser/testingService.js";

test("TestingService exposes only test tasks and projects passed and failed runs", async () => {
	using tasks = new FakeTaskService([
		task("build", "Build", "build"),
		task("unit", "Unit", "test"),
		task("integration", "Integration", "test"),
	]);
	using workspace = new WorkspaceContextService({ id: 'empty', folders: [] });
	using copies = new BrowserWorkingCopyService();
	using service = new TestingService(tasks, noExecution, workspace, copies, new NullLoggerService());
	assert.deepEqual(service.profiles.map(profile => profile.label), ["Unit", "Integration"]);

	const run = await service.run(service.profiles[0]!);
	assert.equal(tasks.runs.length, 1);
	assert.equal(run.status, "running");
	tasks.runs[0]!.finish("succeeded");
	assert.equal(run.status, "passed");

	const rerun = await service.rerun(run);
	tasks.runs[1]!.finish("failed");
	assert.equal(rerun.status, "failed");
	assert.equal(service.runs.length, 2);

	const all = await service.runAllScripts();
	assert.equal(all.length, 2);
});

test("TestingService owns dynamic Test Profile providers and maps profiles to test tasks", async () => {
	using tasks = new FakeTaskService([task("unit", "Unit", "test"), task("build", "Build", "build")]);
	using workspace = new WorkspaceContextService({ id: 'empty', folders: [] });
	using copies = new BrowserWorkingCopyService();
	using service = new TestingService(tasks, noExecution, workspace, copies, new NullLoggerService());
	const registration = service.registerTestProfileProviders([{ id: "demo.tests", provideTestProfiles: () => [{ id: "focused", label: "Focused", taskId: "unit", detail: "Extension profile" }] }]);

	await service.refresh();
	const profile = service.profiles.find(candidate => candidate.id === "extension-profile:demo.tests:focused")!;
	assert.deepEqual(profile, { id: "extension-profile:demo.tests:focused", label: "Focused", source: "demo.tests", taskId: "unit", detail: "Extension profile" });
	const run = await service.run(profile);
	assert.equal(run.taskRun.task.id, "unit");

	assert.throws(() => service.registerTestProfileProvider({ id: "demo.tests", provideTestProfiles: () => [] }), /already registered/);
	registration.dispose();
	assert.deepEqual(service.profiles.map(candidate => candidate.id), ["unit"]);
	await assert.rejects(service.run(profile), /no longer present/);
	await service.refresh();
	assert.deepEqual(service.profiles.map(candidate => candidate.id), ["unit"]);
});

test("TestingService rejects profiles that do not reference a current test task", async () => {
	using tasks = new FakeTaskService([task("unit", "Unit", "test")]);
	using workspace = new WorkspaceContextService({ id: 'empty', folders: [] });
	using copies = new BrowserWorkingCopyService();
	using service = new TestingService(tasks, noExecution, workspace, copies, new NullLoggerService());
	using registration = service.registerTestProfileProvider({ id: "invalid", provideTestProfiles: () => [{ id: "missing", label: "Missing", taskId: "missing" }] });

	await assert.rejects(service.refresh(), /unavailable test task/);

	assert.deepEqual(service.profiles.map(candidate => candidate.id), ["unit"]);
});

function task(id: string, label: string, group: IWorkspaceTask["group"]): IWorkspaceTask {
	return Object.freeze({ id, label, group, command: `run ${id}`, source: "vscode" });
}

class FakeTaskService extends Disposable implements ITaskService {
	private readonly tasksEmitter = this._register(new Emitter<readonly IWorkspaceTask[]>());
	readonly startEmitter = this._register(new Emitter<ITaskRun>());
	readonly runEmitter = this._register(new Emitter<ITaskRun>());
	readonly onDidChangeTasks = this.tasksEmitter.event;
	readonly onDidStartTask = this.startEmitter.event;
	readonly onDidChangeTaskRun = this.runEmitter.event;
	readonly runs: FakeTaskRun[] = [];
	lastRun: ITaskRun | undefined;
	constructor(readonly tasks: readonly IWorkspaceTask[]) { super(); }
	get activeRuns(): readonly ITaskRun[] { return this.runs.filter(run => run.status === "running"); }
	registerTaskProvider(_provider: TaskProvider) { return toDisposable(() => undefined); }
	registerTaskProviders(_providers: readonly TaskProvider[]): TaskProviderRegistration { const registration = toDisposable(() => undefined) as TaskProviderRegistration; registration.replace = () => undefined; return registration; }
	async refresh() { return this.tasks; }
	async run(task: IWorkspaceTask): Promise<ITaskRun> { const run = this._register(new FakeTaskRun(task)); this.runs.push(run); this.lastRun = run; this.startEmitter.fire(run); return run; }
	async terminate(run: ITaskRun) { (run as FakeTaskRun).finish("canceled"); }
}

class FakeTaskRun extends Disposable implements ITaskRun {
	private readonly emitter = this._register(new Emitter<TaskRunStatus>());
	readonly onDidChangeStatus = this.emitter.event;
	readonly terminal = {} as ITerminalInstance;
	status: TaskRunStatus = "running";
	exitCode: number | undefined;
	constructor(readonly task: IWorkspaceTask) { super(); }
	finish(status: TaskRunStatus): void { this.status = status; this.exitCode = status === "failed" ? 1 : status === "succeeded" ? 0 : undefined; this.emitter.fire(status); }
}

const noExecution: ITestExecutionService = {
	onDidUpdate: Event.None, onDidDisconnect: Event.None,
	discover: async () => { throw new Error('Unexpected test discovery'); },
	run: async () => { throw new Error('Unexpected test execution'); },
	read: async () => { throw new Error('Unexpected test read'); },
	cancel: async () => { throw new Error('Unexpected test cancellation'); },
	release: async () => { throw new Error('Unexpected test release'); },
};

test('TestingService consumes completion before start responses and releases exact runs once', async () => {
	using tasks = new FakeTaskService([]);
	using backend = new TestExecutionService();
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	using copies = new BrowserWorkingCopyService();
	using service = new TestingService(tasks, backend, workspace, copies, new NullLoggerService());
	await service.refreshTests();
	const passes = service.tests.find(test => test.name.endsWith('passes'))!;
	await service.runTests([passes.key]);
	assert.deepEqual(backend.runs[0]!.tests, [passes.id]);
	assert.deepEqual(service.testResults.map(result => result.state), ['passed']);
	assert.equal(backend.released.filter(id => id === backend.runs[0]!.id).length, 1);
	assert.equal(service.isRunningTests, false);
});

test('TestingService ignores old sequences, cancels a run, and keeps scripts independent', async () => {
	using tasks = new FakeTaskService([task('script', 'Script', 'test')]);
	using backend = new TestExecutionService();
	backend.holdRuns = true;
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	using copies = new BrowserWorkingCopyService();
	using service = new TestingService(tasks, backend, workspace, copies, new NullLoggerService());
	await service.refreshTests();
	const run = service.runTests(service.tests.map(test => test.key));
	await waitFor(() => backend.runs.length === 1);
	const id = backend.runs[0]!.id;
	backend.updates.fire({ operationId: id, sequence: 1, status: 'completed', tests: null, result: null, error: null });
	assert.equal(service.isRunningTests, true);
	await service.cancelTests();
	await run;
	assert.deepEqual(service.testResults.map(result => result.state), ['cancelled', 'cancelled']);
	assert.equal(tasks.runs.length, 0);
});

test('TestingService releases an accepted discovery after workspace replacement and ignores late data', async () => {
	using tasks = new FakeTaskService([]);
	using backend = new TestExecutionService();
	let finish!: () => void;
	backend.pendingDiscovery = new Promise<void>(resolve => { finish = resolve; });
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	using copies = new BrowserWorkingCopyService();
	using service = new TestingService(tasks, backend, workspace, copies, new NullLoggerService());
	const discovery = service.refreshTests();
	const rejected = assert.rejects(discovery, /cancelled/);
	await waitFor(() => backend.snapshots.size === 1);
	workspace.updateWorkspace({ id: 'empty', folders: [] });
	finish();
	await rejected;
	assert.deepEqual(service.tests, []);
	assert.equal(backend.snapshots.size, 0);
	assert.equal(backend.released.length, 1);
});

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (predicate()) { return; }
		await new Promise(resolve => setTimeout(resolve, 0));
	}
	assert.fail('Test operation did not reach the boundary');
}

test('TestingService runs scripts independently of backend test discovery', async () => {
	using tasks = new FakeTaskService([task('script', 'Script', 'test')]);
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	using copies = new BrowserWorkingCopyService();
	using service = new TestingService(tasks, noExecution, workspace, copies, new NullLoggerService());
	const runs = await service.runAllScripts();
	assert.deepEqual(runs.map(run => run.profile.id), ['script']);
	assert.deepEqual(service.tests, []);
});
