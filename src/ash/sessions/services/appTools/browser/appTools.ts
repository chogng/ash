import type { ITaskDescription, ITaskOutput, TaskRunStatus } from '../../../../workbench/contrib/tasks/common/tasks.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import type { UpdateCheckResult } from '../../../../platform/update/common/updateService.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { ModelReasoningEffort, ModelRef } from '../../../../platform/models/common/agentModels.js';
import type { SessionGroup } from '../../sessions/browser/sessionGroupsService.js';
import type { AutomationSessionsListMode, ISessionsListTreeNode, SessionSortMode, SessionsListMode } from '../../sessions/browser/sessionsListModelService.js';

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

export interface ISessionsListTools {
	listSections(): readonly SessionGroup[];
	readTree(): {
		readonly mode: SessionsListMode;
		readonly sort: SessionSortMode;
		readonly automationSessions: AutomationSessionsListMode;
		readonly sections: readonly ISessionsListTreeNode[];
	} | undefined;
	createSection(name: string, signal: AbortSignal): Promise<SessionGroup>;
	renameSection(sectionId: string, name: string, signal: AbortSignal): Promise<void>;
	deleteSection(sectionId: string, signal: AbortSignal): Promise<void>;
	moveSession(sessionId: string, sectionId: string | null, signal: AbortSignal): Promise<void>;
	reorderSection(sectionId: string, sessionIds: readonly string[], signal: AbortSignal): Promise<void>;
}

export interface IAppToolsTaskRunner {
	listTasks(directory: string, signal: AbortSignal): Promise<TaskCatalog>;
	describeTask(directory: string, taskId: string, revision: string, signal: AbortSignal): Promise<ITaskDescription>;
	runTask(directory: string, taskId: string, revision: string, signal: AbortSignal): Promise<TaskRunSummary>;
	taskStatus(directory: string, runId: string): TaskRunSummary;
	taskOutput(directory: string, runId: string, cursor: number, maxCharacters: number): ITaskOutput;
	cancelTask(directory: string, runId: string): Promise<TaskRunSummary>;
}

type ComparisonWorkspaceMode = 'worktree' | 'folderless';

export interface ModelEvaluationSelection {
	readonly sourceId: string;
	readonly agent: string;
	readonly model: ModelRef;
	readonly reasoningEffort: ModelReasoningEffort | null;
}

export type ModelEvaluationOperation =
	| { readonly type: 'getComparisonModels'; readonly workspaceMode: ComparisonWorkspaceMode; }
	| {
		readonly type: 'createModelComparison';
		readonly workspaceMode: ComparisonWorkspaceMode;
		readonly prompt: string;
		readonly attempts: readonly ModelEvaluationSelection[];
		readonly judge: ModelEvaluationSelection | null;
		readonly synthesizer: ModelEvaluationSelection | null;
	}
	| {
		readonly type: 'listModelComparisons';
		readonly includeArchived: boolean;
		readonly workspace: string | null;
		readonly comparisonIds: readonly string[];
		readonly cursor: string | null;
	}
	| { readonly type: 'readModelComparison'; readonly comparisonId: string; };

export interface ModelEvaluationCaller {
	readonly sessionId: string;
	readonly threadId: string;
	readonly turnId: string;
}

export interface IModelEvaluationTools {
	execute(caller: ModelEvaluationCaller, operation: ModelEvaluationOperation, signal: AbortSignal): Promise<unknown>;
}

export const IModelEvaluationTools = createServiceIdentifier<IModelEvaluationTools>('modelEvaluationTools');

/** Window-owned capabilities used by application tools; transport details stay in the adapter. */
export interface IAppToolsHost extends IDisposable {
	readonly taskRunner: IAppToolsTaskRunner;
	readonly modelEvaluation: IModelEvaluationTools;
	openFile(resource: URI, line?: number): Promise<void>;
	openReview(original: URI, modified: URI): Promise<void>;
	openBrowser(resource: URI): Promise<boolean>;
	openTerminal(signal: AbortSignal): Promise<string>;
	navigate(sessionId: string, threadId: string): Promise<void>;
	readonly sessionsList: ISessionsListTools;
	checkUpdate(): Promise<UpdateCheckResult>;
	fireConfetti(): boolean;
	clearTransientState(): void;
}
