import { type Event } from "../../../../base/common/event.js";
import { type IDisposable } from "../../../../base/common/lifecycle.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import { type ITerminalInstance } from "../../terminal/common/terminal.js";

export type WorkspaceTaskSource = "vscode" | "npm" | "pnpm" | "yarn" | "cargo" | "extension";
export type WorkspaceTaskGroup = "build" | "test" | "run" | "other";

/** One explicitly selectable workspace command. Tasks are never executed during discovery. */
export interface IWorkspaceTask {
	readonly id: string;
	readonly dirId?: string;
	readonly label: string;
	readonly command: string;
	readonly source: WorkspaceTaskSource;
	readonly group: WorkspaceTaskGroup;
	readonly detail?: string;
}

/** One task returned by a dynamic provider before TaskService assigns its canonical identity. */
export interface TaskProviderTask {
	readonly id: string;
	readonly label: string;
	readonly command: string;
	readonly group: WorkspaceTaskGroup;
	readonly detail?: string;
}

/** Dynamic task producer owned by one extension or other runtime caller. */
export interface TaskProvider {
	readonly id: string;
	provideTasks(signal: AbortSignal): readonly TaskProviderTask[] | PromiseLike<readonly TaskProviderTask[]>;
}

/** One caller-owned provider set that can be atomically replaced. */
export interface TaskProviderRegistration extends IDisposable {
	replace(providers: readonly TaskProvider[]): void;
}

export type TaskRunStatus = "running" | "completed" | "succeeded" | "failed" | "canceled";

/** One task execution projected through an integrated Terminal instance. */
export interface ITaskRun {
	readonly task: IWorkspaceTask;
	readonly terminal: ITerminalInstance;
	readonly status: TaskRunStatus;
	readonly exitCode: number | undefined;
	readonly onDidChangeStatus: Event<TaskRunStatus>;
}

/** Discovers workspace tasks and executes only a caller-selected task. */
export interface ITaskService extends IDisposable {
	readonly tasks: readonly IWorkspaceTask[];
	readonly activeRuns: readonly ITaskRun[];
	readonly lastRun: ITaskRun | undefined;
	readonly onDidChangeTasks: Event<readonly IWorkspaceTask[]>;
	readonly onDidStartTask: Event<ITaskRun>;
	readonly onDidChangeTaskRun: Event<ITaskRun>;

	registerTaskProvider(provider: TaskProvider): IDisposable;
	registerTaskProviders(providers: readonly TaskProvider[]): TaskProviderRegistration;
	refresh(): Promise<readonly IWorkspaceTask[]>;
	run(task: IWorkspaceTask): Promise<ITaskRun>;
	terminate(run: ITaskRun): Promise<void>;
}

export const ITaskService = createServiceIdentifier<ITaskService>("taskService");
