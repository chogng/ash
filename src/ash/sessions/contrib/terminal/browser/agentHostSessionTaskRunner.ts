import { raceCancellationError } from '../../../../base/common/async.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IWorkspaceContextService, type IWorkspace } from '../../../../platform/workspace/common/workspace.js';
import { ITaskService } from '../../../../workbench/contrib/tasks/common/taskService.js';
import type { ITaskDescription, ITaskOutput, ITaskRun, IWorkspaceTask } from '../../../../workbench/contrib/tasks/common/tasks.js';
import type { IAppToolsTaskRunner, TaskCatalog, TaskRunSummary } from '../../../services/appTools/browser/appTools.js';

/** Routes agent requests to the window's Tasks service and tracks which runs the agent started. */
export class AgentHostSessionTaskRunner extends Disposable implements IAppToolsTaskRunner {
	private readonly agentTaskRuns = new Set<ITaskRun>();

	constructor(
		@ITaskService private readonly tasks: ITaskService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super();
		this._register(toDisposable(() => this.cancelOwnedRuns()));
	}

	private assertCurrent(workspace: IWorkspace, signal: AbortSignal): void {
		throwIfCancelled(signal);
		if (this.isDisposed || this.workspace.getWorkspace() !== workspace) throw new CancellationError();
	}

	private taskFolder(directory: string): string {
		const folder = this.workspace.getWorkspace().folders.find(folder => extUriBiasedIgnorePathCase.isEqual(folder.uri, URI.file(directory)));
		if (!folder) throw new Error(localize('tasks.agentDirectoryUnavailable', 'The task directory is not a folder in this window.'));
		return folder.id;
	}
	private findTask(directory: string, taskId: string): IWorkspaceTask {
		const dirId = this.taskFolder(directory);
		const task = this.tasks.tasks.find(task => task.id === taskId && task.dirId === dirId);
		if (!task) throw new Error(localize('tasks.agentTaskNotFound', 'The selected task is no longer available. Discover workspace tasks again.'));
		return task;
	}
	private findRun(directory: string, runId: string): ITaskRun {
		const dirId = this.taskFolder(directory);
		const run = this.tasks.getRun(runId);
		if (!run || run.task.dirId !== dirId) throw new Error(localize('tasks.agentRunNotFound', 'The task run was not found in this folder. It may have expired or belonged to a previous workspace.'));
		return run;
	}
	public async listTasks(directory: string, signal: AbortSignal): Promise<TaskCatalog> {
		const workspace = this.workspace.getWorkspace();
		const dirId = this.taskFolder(directory);
		await raceCancellationError(this.tasks.getWorkspaceTasks(), signal);
		this.assertCurrent(workspace, signal);
		const tasks = await Promise.all(this.tasks.tasks.filter(task => task.dirId === dirId).map(async task => {
			let revision: string | null = null;
			let unavailableReason: string | null = null;
			try { revision = (await this.tasks.describe(task)).revision; }
			catch (error) { unavailableReason = error instanceof Error ? error.message : String(error); }
			return { taskId: task.id, label: task.label, source: task.source, group: task.group, revision, unavailableReason };
		}));
		this.assertCurrent(workspace, signal);
		return { tasks, runs: this.tasks.runs.filter(run => run.task.dirId === dirId).map(taskSummary) };
	}
	public async describeTask(directory: string, taskId: string, revision: string, signal: AbortSignal): Promise<ITaskDescription> {
		const workspace = this.workspace.getWorkspace();
		this.taskFolder(directory);
		await raceCancellationError(this.tasks.refresh(), signal);
		this.assertCurrent(workspace, signal);
		const description = await raceCancellationError(this.tasks.describe(this.findTask(directory, taskId)), signal);
		this.assertCurrent(workspace, signal);
		if (description.revision !== revision) throw new Error(localize('tasks.agentRevisionChanged', 'The task configuration changed after review. Discover the task again before running it.'));
		return description;
	}
	public async runTask(directory: string, taskId: string, revision: string, signal: AbortSignal): Promise<TaskRunSummary> {
		const workspace = this.workspace.getWorkspace();
		await this.describeTask(directory, taskId, revision, signal);
		this.assertCurrent(workspace, signal);
		const priorRuns = new Set(this.tasks.runs.map(run => run.runId));
		const run = this.tasks.start(this.findTask(directory, taskId), signal, revision);
		if (!priorRuns.has(run.runId)) this.agentTaskRuns.add(run);
		void run.completion?.finally(() => this.agentTaskRuns.delete(run)).catch(() => undefined);
		return taskSummary(run);
	}
	public taskStatus(directory: string, runId: string): TaskRunSummary { return taskSummary(this.findRun(directory, runId)); }
	public taskOutput(directory: string, runId: string, cursor: number, maxCharacters: number): ITaskOutput { return this.findRun(directory, runId).readOutput(cursor, maxCharacters); }
	public async cancelTask(directory: string, runId: string): Promise<TaskRunSummary> {
		const run = this.findRun(directory, runId);
		await this.tasks.terminate(run);
		return taskSummary(run);
	}
	public cancelOwnedRuns(): void {
		for (const run of this.agentTaskRuns) void this.tasks.terminate(run).catch(() => undefined);
		this.agentTaskRuns.clear();
	}
}

function taskSummary(run: ITaskRun): TaskRunSummary {
	return { runId: run.runId, taskId: run.task.id, label: run.task.label, terminalId: run.terminalId, status: run.status, exitCode: run.exitCode ?? null, ready: run.isReady === true, hasErrors: run.hasErrors === true };
}
