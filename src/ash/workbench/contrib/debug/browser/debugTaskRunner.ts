import { raceCancellationError } from '../../../../base/common/async.js';
import { CancellationToken, throwIfCancelled } from '../../../../base/common/cancellation.js';
import { AbstractDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import type { IWorkspace, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { ITaskService } from '../../tasks/common/taskService.js';
import { waitForTask, type ITaskRun, type TaskRunStatus } from '../../tasks/common/tasks.js';

interface IRunnerTaskSummary {
	readonly run: ITaskRun;
	/** Readiness can succeed while the borrowed execution is still running. */
	readonly status: TaskRunStatus;
}

/** Owns Debug's task waits; task execution and terminal resources stay with Tasks. */
export class DebugTaskRunner extends AbstractDisposable {
	private readonly pending = new Set<AbortController>();

	constructor(@ITaskService private readonly tasks: ITaskService) {
		super();
	}

	public cancel(): void {
		for (const controller of this.pending) {
			controller.abort();
		}
	}

	public async runTask(root: IWorkspace | IWorkspaceFolder | undefined, taskId: string | undefined, token = CancellationToken.None): Promise<IRunnerTaskSummary | null> {
		this.assertNotDisposed();
		throwIfCancelled(token);
		if (!taskId) {
			return null;
		}
		if (!root) {
			throw new Error(localize('debug.taskFolderMissing', "The workspace folder for debug task '{0}' is no longer available.", taskId));
		}
		const controller = new AbortController();
		this.pending.add(controller);
		using cancellation = token.onCancellationRequested(() => controller.abort());
		let run: ITaskRun | undefined;
		try {
			throwIfCancelled(token);
			// Refresh has no per-caller cancellation. Retire this wait before it can
			// select a task from a replacement workspace's catalog.
			await raceCancellationError(this.tasks.refresh(), controller.signal);
			throwIfCancelled(controller.signal);
			const folderId = 'folders' in root ? undefined : root.id;
			const matches = this.tasks.tasks.filter(task => (task.id === taskId || task.label === taskId) && (folderId === undefined || task.dirId === undefined || task.dirId === folderId));
			if (matches.length === 0) {
				throw new Error(localize('debug.taskNotFound', "Debug task '{0}' was not found", taskId));
			}
			if (matches.length > 1) {
				throw new Error(localize('debug.taskAmbiguous', "Debug task '{0}' is ambiguous", taskId));
			}
			run = await this.tasks.run(matches[0]!, controller.signal);
			throwIfCancelled(controller.signal);
			const status = await waitForTask(run, controller.signal);
			throwIfCancelled(controller.signal);
			return { run, status };
		} catch (error) {
			if (run?.status === 'running') {
				await this.tasks.terminate(run);
			}
			throw error;
		} finally {
			this.pending.delete(controller);
		}
	}

	protected override disposeCore(): void {
		this.cancel();
	}
}
