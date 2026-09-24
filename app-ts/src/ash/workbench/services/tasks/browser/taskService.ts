import { Emitter, type Event } from "../../../../base/common/event.js";
import { getErrorMessage } from "../../../../base/common/errors.js";
import { Disposable, toDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
import { FileKind, FileNotFoundError, type IFileService } from "../../../../platform/files/common/files.js";
import type { ILogService } from "../../../../platform/log/common/log.js";
import { type IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { type ITerminalCommandStatusEvent, type ITerminalInstance, type ITerminalService } from "../../terminal/common/terminal.js";
import { type ITaskRun, type ITaskService, type IWorkspaceTask, type TaskProvider, type TaskProviderRegistration, type TaskProviderTask, type TaskRunStatus } from "../common/taskService.js";
import type { IOutputChannel, IOutputService, OutputEntrySeverity } from "../../output/common/outputService.js";
import { cargoWorkspaceTasks, parsePackageTasks, parseWorkspaceTasks } from "../common/workspaceTasks.js";

const TASK_TERMINAL_DIMENSIONS = Object.freeze({ rows: 24, cols: 80 });

interface OwnedTaskProvider {
	readonly owner: object;
	readonly provider: TaskProvider;
}

/** Workspace task discovery and integrated-Terminal execution. */
export class TaskService extends Disposable implements ITaskService {
	private readonly changeTasksEmitter = this._register(new Emitter<readonly IWorkspaceTask[]>());
	private readonly startTaskEmitter = this._register(new Emitter<ITaskRun>());
	private readonly changeTaskRunEmitter = this._register(new Emitter<ITaskRun>());
	private readonly runs = new Set<TaskRun>();
	private readonly providers = new Map<string, OwnedTaskProvider>();
	private currentTasks: readonly IWorkspaceTask[] = Object.freeze([]);
	private activeRefresh: AbortController | undefined;
	private refreshGeneration = 0;
	private loaded = false;
	private _lastRun: TaskRun | undefined;
	private readonly output: IOutputChannel | undefined;

	readonly onDidChangeTasks: Event<readonly IWorkspaceTask[]> = this.changeTasksEmitter.event;
	readonly onDidStartTask: Event<ITaskRun> = this.startTaskEmitter.event;
	readonly onDidChangeTaskRun: Event<ITaskRun> = this.changeTaskRunEmitter.event;

	constructor(private readonly fileService: IFileService, private readonly workspace: IWorkspaceContextService, private readonly terminalService: ITerminalService, outputService?: IOutputService, private readonly logService?: ILogService) {
		super();
		this.output = outputService ? this._register(outputService.createChannel({ id: "tasks", label: "Tasks", kind: "log", source: "core" })) : undefined;
		this._register(fileService.onDidChangeFiles(event => {
			if (this.loaded && affectsTaskConfiguration(event.resources)) void this.refresh().catch(error => this.reportError(error));
		}));
		this._register(workspace.onDidChangeWorkspace(() => {
			this.activeRefresh?.abort();
			this.refreshGeneration += 1;
			this.loaded = false;
			this.setTasks(Object.freeze([]));
		}));
		this._register(toDisposable(() => {
			for (const run of this.runs) run.dispose();
			this.runs.clear();
			this.activeRefresh?.abort();
			this.activeRefresh = undefined;
			this.providers.clear();
		}));
	}

	get tasks(): readonly IWorkspaceTask[] { return this.currentTasks; }
	get activeRuns(): readonly ITaskRun[] { return [...this.runs].filter(run => run.status === "running"); }
	get lastRun(): ITaskRun | undefined { return this._lastRun; }

	registerTaskProvider(provider: TaskProvider): IDisposable {
		return this.registerTaskProviders([provider]);
	}

	registerTaskProviders(providers: readonly TaskProvider[]): TaskProviderRegistration {
		this.assertNotDisposed();
		const owner = Object.freeze({});
		this.replaceProviders(owner, providers);
		let disposed = false;
		const registration = toDisposable(() => {
			if (disposed) return;
			disposed = true;
			const removed = this.deleteProviderOwner(owner);
			if (removed.length > 0) this.providersChanged(removed);
		}) as TaskProviderRegistration;
		registration.replace = replacement => {
			if (disposed) throw new ReferenceError("Task provider registration is already disposed");
			this.assertNotDisposed();
			this.replaceProviders(owner, replacement);
		};
		return registration;
	}

	async refresh(): Promise<readonly IWorkspaceTask[]> {
		this.assertNotDisposed();
		this.activeRefresh?.abort();
		const controller = new AbortController();
		this.activeRefresh = controller;
		const generation = ++this.refreshGeneration;
		const folders = this.workspace.getWorkspace().folders;
		const multiRoot = folders.length > 1;
		const providerSnapshot = [...this.providers.values()].map(entry => entry.provider);
		this.log("debug", "discovery", `Refreshing workspace tasks from configuration and ${providerSnapshot.length} provider(s).`);
		try {
			const [folderGroups, providerGroups] = await Promise.all([
				Promise.all(folders.map(async folder => {
					const tasks = await this.discoverWorkspaceTasks(folder.uri);
					return tasks.map(task => Object.freeze({
						...task,
						id: multiRoot ? `${folder.id}:${task.id}` : task.id,
						dirId: folder.id,
					}));
				})),
				Promise.all(providerSnapshot.map(provider => this.provideTasks(provider, controller.signal))),
			]);
			const discovered = folderGroups.flat();
			const providerTasks = providerGroups.flat();
			if (controller.signal.aborted || generation !== this.refreshGeneration || this.isDisposed) return this.currentTasks;
			this.loaded = true;
			this.setTasks(mergeTasks(discovered, providerTasks));
			this.log("information", "discovery", `Discovered ${this.currentTasks.length} workspace task(s).`);
			return this.currentTasks;
		} catch (error) {
			if (controller.signal.aborted || generation !== this.refreshGeneration || this.isDisposed) return this.currentTasks;
			this.log("error", "discovery", `Task discovery failed: ${errorMessage(error)}`);
			throw error;
		} finally {
			if (this.activeRefresh === controller) this.activeRefresh = undefined;
		}
	}

	async run(task: IWorkspaceTask): Promise<ITaskRun> {
		const currentTask = resolveKnownTask(task, this.currentTasks);
		const workspaceFolder = currentTask.dirId
			? this.workspace.getWorkspace().folders.find(folder => folder.id === currentTask.dirId)
			: this.workspace.getWorkspace().folders[0];
		if (!workspaceFolder) throw new Error(`Task '${currentTask.label}' has no available workspace folder`);
		this.log("information", "execution", `Starting task '${currentTask.label}' (${currentTask.id}).`);
		let terminal: ITerminalInstance;
		try { terminal = await this.terminalService.createTerminal({ dirId: workspaceFolder.id, dimensions: TASK_TERMINAL_DIMENSIONS, profile: { type: "default" }, title: `Task: ${currentTask.label}` }); }
		catch (error) { this.log("error", "execution", `Could not create a terminal for task '${currentTask.label}': ${errorMessage(error)}`); throw error; }
		const run = this._register(new TaskRun(currentTask, terminal, current => {
			const exit = current.exitCode === undefined ? "" : ` (exit code ${current.exitCode})`;
			this.log(current.status === "failed" ? "error" : current.status === "canceled" ? "warning" : "information", "execution", `Task '${current.task.label}' ${current.status}${exit}.`);
			this.changeTaskRunEmitter.fire(current);
			if (current.status !== "running") this.runs.delete(current);
		}));
		this.runs.add(run);
		this._lastRun = run;
		this.startTaskEmitter.fire(run);
		const command = substituteWorkspaceVariables(currentTask.command, workspaceFolder.uri);
		terminal.write(`${taskTerminalCommand(command, terminal.profile.profileId)}\r`);
		this.log("debug", "execution", `Task '${currentTask.label}' is running in terminal '${terminal.id}'.`);
		return run;
	}

	async terminate(run: ITaskRun): Promise<void> {
		if (!this.runs.has(run as TaskRun)) return;
		this.log("warning", "execution", `Terminating task '${run.task.label}'.`);
		(run as TaskRun).cancel();
		await this.terminalService.closeTerminal(run.terminal);
	}

	private setTasks(tasks: readonly IWorkspaceTask[]): void {
		if (taskListsEqual(this.currentTasks, tasks)) return;
		this.currentTasks = tasks;
		this.changeTasksEmitter.fire(tasks);
	}

	private replaceProviders(owner: object, providers: readonly TaskProvider[]): void {
		if (!Array.isArray(providers)) throw new TypeError("Task providers must be an array");
		const normalized = providers.map(normalizeTaskProvider);
		const ids = new Set<string>();
		for (const provider of normalized) {
			const existing = this.providers.get(provider.id);
			if (ids.has(provider.id) || existing && existing.owner !== owner) throw new Error(`Task provider '${provider.id}' is already registered`);
			ids.add(provider.id);
		}
		const changed = new Set(this.deleteProviderOwner(owner));
		for (const provider of normalized) this.providers.set(provider.id, { owner, provider });
		for (const provider of normalized) changed.add(provider.id);
		if (changed.size > 0) this.providersChanged(changed);
	}

	private deleteProviderOwner(owner: object): readonly string[] {
		const removed: string[] = [];
		for (const [id, entry] of this.providers) {
			if (entry.owner !== owner) continue;
			this.providers.delete(id);
			removed.push(id);
		}
		return removed;
	}

	private providersChanged(providerIds: ReadonlySet<string> | readonly string[]): void {
		if (this.isDisposed) return;
		const changedProviders = new Set(providerIds);
		const refresh = this.loaded || this.activeRefresh !== undefined;
		if (this.loaded) this.setTasks(Object.freeze(this.currentTasks.filter(task => {
			const providerId = taskProviderId(task);
			return providerId === undefined || !changedProviders.has(providerId);
		})));
		this.activeRefresh?.abort();
		this.refreshGeneration += 1;
		if (refresh) void this.refresh().catch(error => this.reportError(error));
	}

	private async provideTasks(provider: TaskProvider, signal: AbortSignal): Promise<readonly IWorkspaceTask[]> {
		let contributions: readonly TaskProviderTask[];
		try { contributions = await provider.provideTasks(signal); }
		catch (error) { this.log("error", "provider", `Task provider '${provider.id}' failed: ${errorMessage(error)}`); throw error; }
		if (signal.aborted) return Object.freeze([]);
		if (!Array.isArray(contributions)) throw new TypeError(`Task provider '${provider.id}' must return an array`);
		const ids = new Set<string>();
		return Object.freeze(contributions.map(contribution => {
			const task = projectProviderTask(provider.id, contribution);
			if (ids.has(task.id)) throw new Error(`Task provider '${provider.id}' returned duplicate task '${contribution.id}'`);
			ids.add(task.id);
			return task;
		}));
	}


	private log(severity: OutputEntrySeverity, category: string, text: string): void {
		this.output?.appendLine({ severity, category, text });
		const logCategory = `tasks.${category}`;
		if (severity === "error") this.logService?.error(logCategory, text);
		else if (severity === "warning") this.logService?.warn(logCategory, text);
		else if (severity === "debug") this.logService?.debug(logCategory, text);
		else this.logService?.info(logCategory, text);
	}

	private reportError(error: unknown): void {
		this.logService?.error("tasks.discovery", "Could not refresh workspace tasks", error);
	}

	private async packageManager(root: URI): Promise<"npm" | "pnpm" | "yarn"> {
		if (await this.exists(childResource(root, "pnpm-lock.yaml"))) return "pnpm";
		if (await this.exists(childResource(root, "yarn.lock"))) return "yarn";
		return "npm";
	}

	private async discoverWorkspaceTasks(root: URI): Promise<readonly IWorkspaceTask[]> {
		const discovered: IWorkspaceTask[] = [];
		const tasksJson = await this.readOptional(childResource(root, ".vscode/tasks.json"));
		if (tasksJson !== undefined) discovered.push(...parseWorkspaceTasks(tasksJson));
		const packageJson = await this.readOptional(childResource(root, "package.json"));
		if (packageJson !== undefined) discovered.push(...parsePackageTasks(packageJson, await this.packageManager(root)));
		if (await this.exists(childResource(root, "Cargo.toml"))) discovered.push(...cargoWorkspaceTasks());
		return Object.freeze(discovered);
	}

	private async exists(resource: URI): Promise<boolean> {
		try { return (await this.fileService.stat(resource)).kind === FileKind.File; }
		catch (error) { if (error instanceof FileNotFoundError) return false; throw error; }
	}

	private async readOptional(resource: URI): Promise<string | undefined> {
		if (!await this.exists(resource)) return undefined;
		return (await this.fileService.readFile(resource)).content;
	}
}

function taskProviderId(task: IWorkspaceTask): string | undefined {
	if (task.source !== "extension" || !task.id.startsWith("extension:")) return undefined;
	const encoded = task.id.slice("extension:".length).split(":", 1)[0];
	if (!encoded) return undefined;
	try { return decodeURIComponent(encoded); }
	catch { return undefined; }
}

class TaskRun extends Disposable implements ITaskRun {
	private readonly changeStatusEmitter = this._register(new Emitter<TaskRunStatus>());
	private commandId: string | undefined;
	private _status: TaskRunStatus = "running";
	private _exitCode: number | undefined;
	readonly onDidChangeStatus: Event<TaskRunStatus> = this.changeStatusEmitter.event;

	constructor(readonly task: IWorkspaceTask, readonly terminal: ITerminalInstance, private readonly onChange: (run: TaskRun) => void) {
		super();
		this._register(terminal.onDidChangeCommandStatus(event => this.acceptCommandStatus(event)));
		this._register(terminal.onDidExit(exitCode => {
			if (this._status === "running") this.setStatus(exitCode === 0 ? "succeeded" : "failed", exitCode);
		}));
		this._register(terminal.onDidChangeState(state => {
			if (this._status === "running" && (state === "disconnected" || state === "error")) this.setStatus(state === "error" ? "failed" : "canceled", undefined);
		}));
	}

	get status(): TaskRunStatus { return this._status; }
	get exitCode(): number | undefined { return this._exitCode; }

	cancel(): void {
		this.setStatus("canceled", undefined);
	}

	private acceptCommandStatus(event: ITerminalCommandStatusEvent): void {
		if (!this.commandId && event.status === "running") this.commandId = event.commandId;
		if (event.commandId !== this.commandId || event.status === "running") return;
		this.setStatus(event.status, event.exitCode);
	}

	private setStatus(status: TaskRunStatus, exitCode: number | undefined): void {
		if (this._status !== "running") return;
		this._status = status;
		this._exitCode = exitCode;
		this.changeStatusEmitter.fire(status);
		this.onChange(this);
	}
}

function childResource(root: URI, relativePath: string): URI {
	const base = root.path.endsWith("/") ? root.path.slice(0, -1) : root.path;
	return root.withPath(`${base}/${relativePath.split("/").map(encodeURIComponent).join("/")}`);
}

function affectsTaskConfiguration(resources: readonly URI[] | undefined): boolean {
	return resources === undefined || resources.some(resource => /\/(?:tasks\.json|package\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.toml)$/i.test(resource.path));
}

function deduplicateTasks(tasks: readonly IWorkspaceTask[]): readonly IWorkspaceTask[] {
	const unique = new Map<string, IWorkspaceTask>();
	for (const task of tasks) if (!unique.has(task.id)) unique.set(task.id, task);
	return Object.freeze([...unique.values()].sort((left, right) => taskOrder(left.group) - taskOrder(right.group) || left.label.localeCompare(right.label)));
}

function mergeTasks(discovered: readonly IWorkspaceTask[], provided: readonly IWorkspaceTask[]): readonly IWorkspaceTask[] {
	const merged = new Map(deduplicateTasks(discovered).map(task => [task.id, task]));
	for (const task of provided) {
		if (merged.has(task.id)) throw new Error(`Workspace task '${task.id}' is already registered`);
		merged.set(task.id, task);
	}
	return Object.freeze([...merged.values()].sort((left, right) => taskOrder(left.group) - taskOrder(right.group) || left.label.localeCompare(right.label)));
}

function normalizeTaskProvider(provider: TaskProvider): TaskProvider {
	if (!provider || typeof provider !== "object") throw new TypeError("Task provider must be an object");
	const id = normalizeText(provider.id, "Task provider ID", 256);
	if (typeof provider.provideTasks !== "function") throw new TypeError(`Task provider '${id}' must implement provideTasks`);
	return Object.freeze({ id, provideTasks: (signal: AbortSignal) => provider.provideTasks.call(provider, signal) });
}

function projectProviderTask(providerId: string, contribution: TaskProviderTask): IWorkspaceTask {
	if (!contribution || typeof contribution !== "object") throw new TypeError(`Task provider '${providerId}' returned an invalid task`);
	const id = normalizeText(contribution.id, `Task provider '${providerId}' task ID`, 256);
	const label = normalizeText(contribution.label, `Task provider '${providerId}' task label`, 256);
	const command = normalizeText(contribution.command, `Task provider '${providerId}' task command`, 32768, false);
	if (!(["build", "test", "run", "other"] as const).includes(contribution.group)) throw new TypeError(`Task provider '${providerId}' task '${id}' has an invalid group`);
	const detail = contribution.detail === undefined ? undefined : normalizeText(contribution.detail, `Task provider '${providerId}' task detail`, 4096, false);
	return Object.freeze({ id: `extension:${encodeURIComponent(providerId)}:${encodeURIComponent(id)}`, label, command, source: "extension", group: contribution.group, ...(detail === undefined ? {} : { detail }) });
}

function normalizeText(value: string, owner: string, maximum: number, trim = true): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || value.includes("\0")) throw new TypeError(`${owner} must contain 1 to ${maximum} characters without NUL`);
	return trim ? value.trim() : value;
}

function taskOrder(group: IWorkspaceTask["group"]): number {
	return group === "build" ? 0 : group === "test" ? 1 : group === "run" ? 2 : 3;
}

function taskListsEqual(left: readonly IWorkspaceTask[], right: readonly IWorkspaceTask[]): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function resolveKnownTask(task: IWorkspaceTask, tasks: readonly IWorkspaceTask[]): IWorkspaceTask {
	const current = tasks.find(candidate => candidate.id === task.id);
	if (!current || current.command !== task.command) throw new Error("Task is no longer present in the current workspace configuration");
	return current;
}

function substituteWorkspaceVariables(command: string, root: URI | undefined): string {
	if (!root) return command;
	const workspaceFolder = root.scheme === "file" ? root.fsPath : decodeURIComponent(root.path);
	const basename = workspaceFolder.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? "";
	return command.replaceAll("${workspaceFolder}", workspaceFolder).replaceAll("${workspaceFolderBasename}", basename);
}

function taskTerminalCommand(command: string, profileId: string): string {
	if (profileId === "fish") return `${command}; set __ash_task_exit $status; exit $__ash_task_exit`;
	if (profileId === "bash" || profileId === "zsh" || profileId === "sh" || profileId === "git-bash" || profileId === "default") return `${command}; __ash_task_exit=$?; exit $__ash_task_exit`;
	return command;
}

function errorMessage(error: unknown): string {
	return getErrorMessage(error).slice(0, 4096);
}
