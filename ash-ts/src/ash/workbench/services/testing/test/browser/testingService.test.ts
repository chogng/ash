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
	using service = new TestingService(tasks);
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

	const all = await service.runAll();
	assert.equal(all.length, 2);
});

test("TestingService owns dynamic Test Profile providers and maps profiles to test tasks", async () => {
	using tasks = new FakeTaskService([task("unit", "Unit", "test"), task("build", "Build", "build")]);
	using service = new TestingService(tasks);
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
	using service = new TestingService(tasks);
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
