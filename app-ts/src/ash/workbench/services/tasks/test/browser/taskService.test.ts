import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter, Event } from "../../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import { URI } from "../../../../../base/common/uri.js";
import { FileKind, FileNotFoundError, type IFileBytes, type IFileService, type IFileStat, type IFileWriteResult } from "../../../../../platform/files/common/files.js";
import { type IWorkspaceContextService } from "../../../../../platform/workspace/common/workspace.js";
import { type ITerminalCommandStatusEvent, type ITerminalCreateOptions, type ITerminalDimensions, type ITerminalInstance, type ITerminalProfile, type ITerminalService, type TerminalInstanceState } from "../../../../services/terminal/common/terminal.js";
import { TaskService } from "../../browser/taskService.js";
import { OutputService } from "../../../output/browser/outputService.js";

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
	};
	using terminals = new FakeTerminalService();
	using output = new OutputService();
	using service = new TaskService(files, workspace, terminals, output);
	const tasks = await service.refresh();
	assert.deepEqual(tasks.map(task => task.id), ["cargo:build", "cargo:check", "vscode:0:lint", "cargo:test", "pnpm:test", "cargo:run"]);

	const task = tasks.find(candidate => candidate.id === "vscode:0:lint")!;
	const run = await service.run(task);
	const terminal = terminals.instances[0] as FakeTerminalInstance;
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
	const workspace: IWorkspaceContextService = { onDidChangeWorkspace: Event.None, getWorkspace: () => ({ id: "workspace", folders: [{ id: "workspace", uri: root, name: "project", index: 0 }] }), getWorkbenchState: () => 2 };
	using terminals = new FakeTerminalService();
	using service = new TaskService(files, workspace, terminals);
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
	const workspace: IWorkspaceContextService = { onDidChangeWorkspace: Event.None, getWorkspace: () => ({ id: "workspace", folders: [{ id: "workspace", uri: root, name: "project", index: 0 }] }), getWorkbenchState: () => 2 };
	using terminals = new FakeTerminalService();
	using service = new TaskService(new FakeFileService(root, {}), workspace, terminals);
	let fail = false;
	using registration = service.registerTaskProvider({ id: "stable", provideTasks: () => { if (fail) throw new Error("provider failed"); return [{ id: "test", label: "Test", command: "test", group: "test" }]; } });
	await service.refresh();
	const previous = service.tasks;

	fail = true;
	await assert.rejects(service.refresh(), /provider failed/);

	assert.equal(service.tasks, previous);
	assert.deepEqual(service.tasks.map(task => task.id), ["extension:stable:test"]);
});

class FakeFileService implements IFileService {
	readonly onDidChangeFiles = Event.None;
	constructor(private readonly root: URI, private readonly files: Readonly<Record<string, string>>) {}
	async stat(resource: URI) { const path = this.relative(resource); if (!(path in this.files)) throw new FileNotFoundError(resource); return { resource, kind: FileKind.File, sizeBytes: this.files[path]!.length, readonly: false, modifiedAtMillis: undefined }; }
	async readFile(resource: URI) { const path = this.relative(resource); if (!(path in this.files)) throw new FileNotFoundError(resource); return { resource, content: this.files[path]!, revision: "1" }; }
	async readDirectory() { return []; }
	async readFileBytes(): Promise<IFileBytes> { throw new Error("unused"); }
	async writeFile(): Promise<IFileWriteResult> { throw new Error("unused"); }
	async createFile(): Promise<IFileStat> { throw new Error("unused"); }
	async rename() { throw new Error("unused"); }
	async delete() { throw new Error("unused"); }
	private relative(resource: URI): string { return decodeURIComponent(resource.path).slice(decodeURIComponent(this.root.path).length + 1); }
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
	async relaunchTerminal() {}
	setActiveInstance(instance: ITerminalInstance | undefined) { this.activeInstance = instance; }
	moveTerminal() {}
	async closeTerminal(instance: ITerminalInstance) { await instance.close(); }
}

class FakeTerminalInstance extends Disposable implements ITerminalInstance {
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
	write(data: string): void { this.writes.push(data); }
	resize(_dimensions: ITerminalDimensions): void {}
	async close(): Promise<void> { this.state = "exited"; }
	command(event: ITerminalCommandStatusEvent): void { this.commandEmitter.fire(event); }
}
