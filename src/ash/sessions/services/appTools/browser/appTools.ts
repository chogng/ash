import type { ITaskDescription, ITaskOutput, TaskRunStatus } from '../../../../workbench/services/tasks/common/taskService.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import type { UpdateCheckResult } from '../../../../platform/update/common/updateService.js';
import type { SessionGroup } from '../../sessions/browser/sessionGroupsService.js';

export interface TaskRunSummary {
	readonly runId: string;
	readonly taskId: string;
	readonly label: string;
	readonly terminalId: string;
	readonly status: TaskRunStatus;
	readonly exitCode: number | null;
	readonly ready: boolean;
	readonly hasErrors: boolean;
}

export interface TaskCatalog {
	readonly tasks: readonly { taskId: string; label: string; source: string; group: string; revision: string | null; unavailableReason: string | null; }[];
	readonly runs: readonly TaskRunSummary[];
}

/** Window-owned capabilities used by application tools; transport details stay in the adapter. */
export interface IAppToolsHost extends IDisposable {
	listTasks(directory: string, signal: AbortSignal): Promise<TaskCatalog>;
	describeTask(directory: string, taskId: string, revision: string, signal: AbortSignal): Promise<ITaskDescription>;
	runTask(directory: string, taskId: string, revision: string, signal: AbortSignal): Promise<TaskRunSummary>;
	taskStatus(directory: string, runId: string): TaskRunSummary;
	taskOutput(directory: string, runId: string, cursor: number, maxCharacters: number): ITaskOutput;
	cancelTask(directory: string, runId: string): Promise<TaskRunSummary>;
	openFile(resource: URI, line?: number): Promise<void>;
	openReview(original: URI, modified: URI): Promise<void>;
	openBrowser(resource: URI): Promise<boolean>;
	openTerminal(signal: AbortSignal): Promise<string>;
	navigate(sessionId: string, threadId: string): Promise<void>;
	listSections(): readonly SessionGroup[];
	createSection(name: string, signal: AbortSignal): Promise<SessionGroup>;
	renameSection(sectionId: string, name: string, signal: AbortSignal): Promise<void>;
	deleteSection(sectionId: string, signal: AbortSignal): Promise<void>;
	moveSession(sessionId: string, sectionId: string | null, signal: AbortSignal): Promise<void>;
	reorderSection(sectionId: string, sessionIds: readonly string[], signal: AbortSignal): Promise<void>;
	checkUpdate(): Promise<UpdateCheckResult>;
	fireConfetti(): boolean;
	clearTransientState(): void;
}
