import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type {
	ITaskDescription,
	ITaskRun,
	IWorkspaceTask,
	TaskProvider,
	TaskProviderRegistration,
	TaskProviderTask,
} from './tasks.js';

/** Discovers workspace tasks and executes only a caller-selected task. */
export interface ITaskService extends IDisposable {
	readonly tasks: readonly IWorkspaceTask[];
	readonly activeRuns: readonly ITaskRun[];
	readonly lastRun: ITaskRun | undefined;
	readonly runs: readonly ITaskRun[];
	readonly onDidChangeTasks: Event<readonly IWorkspaceTask[]>;
	readonly onDidStartTask: Event<ITaskRun>;
	readonly onDidChangeTaskRun: Event<ITaskRun>;

	registerTaskProvider(provider: TaskProvider): IDisposable;
	registerTaskProviders(providers: readonly TaskProvider[]): TaskProviderRegistration;
	refresh(): Promise<readonly IWorkspaceTask[]>;
	/** Returns immediately while dependencies and execution are prepared by the same owner. */
	start(task: IWorkspaceTask, signal: AbortSignal, expectedRevision: string): ITaskRun;
	describe(task: IWorkspaceTask): Promise<ITaskDescription>;
	getRun(runId: string): ITaskRun | undefined;
	run(task: IWorkspaceTask, signal?: AbortSignal): Promise<ITaskRun>;
	/** Reruns an owned execution through current catalog validation and its retained variable policy. */
	rerun(terminalInstanceId: string): Promise<ITaskRun | undefined>;
	/** Validates an explicit extension task and uses the same dispatch and rollback owner. */
	runProvidedTask(ownerId: string, task: TaskProviderTask, signal: AbortSignal): Promise<ITaskRun>;
	terminate(run: ITaskRun): Promise<void>;
}

export const ITaskService = createServiceIdentifier<ITaskService>('taskService');
