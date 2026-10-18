import type { URI } from '../../../../base/common/uri.js';
import { type Event } from "../../../../base/common/event.js";
import { type IDisposable } from "../../../../base/common/lifecycle.js";
import { CancellationError } from '../../../../base/common/errors.js';
import { localize } from '../../../../nls.js';
import { isHighSurrogate, isLowSurrogate } from '../../../../base/common/strings.js';

export const RUN_TASK_COMMAND_ID = "workbench.action.tasks.runTask";
export const RUN_BUILD_TASK_COMMAND_ID = "workbench.action.tasks.build";
export const RUN_TEST_TASK_COMMAND_ID = "workbench.action.tasks.test";
export const RERUN_LAST_TASK_COMMAND_ID = "workbench.action.tasks.reRunTask";
export const TERMINATE_TASK_COMMAND_ID = "workbench.action.tasks.terminate";

export type WorkspaceTaskSource = "vscode" | "npm" | "pnpm" | "yarn" | "cargo" | "extension";
export type WorkspaceTaskGroup = "build" | "test" | "clean" | "rebuild" | "run" | "other";

export interface TaskDefinition {
	readonly type: string;
	readonly [name: string]: unknown;
}

export interface RunOptions {
	readonly runOn?: 'default' | 'folderOpen';
	readonly reevaluateOnRerun?: boolean;
	readonly instanceLimit?: number;
	/** The configured capacity policy; omitted policies prompt for an instance to terminate. */
	readonly instancePolicy?: 'terminateNewest' | 'terminateOldest' | 'prompt' | 'warn' | 'silent';
}

export interface TaskPresentationOptions {
	/** Tasks in the same folder and named group share a split terminal panel. */
	readonly group?: string;
	/** Echo the resolved command to the terminal by default. */
	readonly echo?: boolean;
	/** Show the terminal reuse notice after exit. Defaults to true. */
	readonly showReuseMessage?: boolean;
	readonly reveal?: 'always' | 'silent' | 'never';
	readonly revealProblems?: 'always' | 'onProblem' | 'never';
	readonly focus?: boolean;
	/** Sequential tasks share an idle terminal by default. */
	readonly panel?: 'shared' | 'dedicated' | 'new';
	readonly clear?: boolean;
	readonly close?: boolean;
}

export interface TaskPseudoterminal {
	/** Brokered PTYs acknowledge asynchronous release; local PTYs close synchronously. */
	readonly releaseCompletion?: Promise<void>;
	readonly onDidWrite: Event<string>;
	readonly onDidClose?: Event<number | void>;
	readonly onDidChangeName?: Event<string>;
	open(initialDimensions: { readonly columns: number; readonly rows: number; } | undefined): void;
	close(): void;
	handleInput?(data: string): void;
	setDimensions?(dimensions: { readonly columns: number; readonly rows: number; }): void;
}

export enum ShellQuoting {
	Escape = 1,
	Strong = 2,
	Weak = 3,
}

export interface ShellQuotedString {
	readonly value: string;
	readonly quoting: ShellQuoting;
}

/** Task-owned shell options are resolved before the existing process owner spawns. */
export interface ShellExecutionOptions {
	readonly executable?: string;
	readonly shellArgs?: readonly string[];
	readonly shellQuoting?: {
		readonly escape?: string | { readonly escapeChar: string; readonly charsToEscape: string; };
		readonly strong?: string;
		readonly weak?: string;
	};
}

export type TaskShellExecution = { readonly type: 'shell'; readonly options?: ShellExecutionOptions; } & (
	| { readonly commandLine: string; readonly command?: never; readonly args?: never; }
	| { readonly command: string | ShellQuotedString; readonly args: readonly (string | ShellQuotedString)[]; readonly commandLine?: never; }
);

export type TaskExecution =
	| { readonly type: 'process'; readonly program: string; readonly args: readonly string[]; }
	| TaskShellExecution
	| { readonly type: 'custom'; readonly callback: (definition: TaskDefinition) => TaskPseudoterminal | PromiseLike<TaskPseudoterminal>; };

/** Original JSON configuration retained for extension metadata and future capability resolution. */
export interface IWorkspaceTaskConfiguration {
	readonly version: string;
	readonly defaults: Readonly<Record<string, unknown>>;
	/** Presence after platform selection; an explicit group also owns its optional default. */
	readonly groupIsConfigured: boolean;
	readonly task: Readonly<Record<string, unknown>>;
}

/** One explicitly selectable workspace command. Tasks are never executed during discovery. */
export interface IWorkspaceTask {
	/** The extension-visible scope; URI selects an exact current workspace folder. */
	readonly scope?: 1 | 2 | URI;
	readonly extensionSource?: string;
	/** Originating transient Task identity, used to correlate an extension request with start events. */
	readonly extensionTaskId?: string;
	readonly id: string;
	/** Callback owner, including tasks resolved from workspace configuration. */
	readonly providerId?: string;
	readonly dirId?: string;
	readonly label: string;
	readonly command: string;
	readonly source: WorkspaceTaskSource;
	readonly group: WorkspaceTaskGroup;
	/** Configured glob defaults match the active file; extension TaskGroup exposes only booleans. */
	readonly groupIsDefault?: boolean | string;
	readonly runOptions?: RunOptions;
	readonly presentation?: TaskPresentationOptions;
	readonly detail?: string;
	readonly configuration?: IWorkspaceTaskConfiguration;
	readonly environment?: Readonly<Record<string, string | null>>;
	readonly definition?: TaskDefinition;
	readonly execution?: TaskExecution;
	readonly cwd?: string;
	readonly dependsOn?: readonly string[];
	readonly dependsOrder?: 'sequence' | 'parallel';
	readonly isBackground?: boolean;
	readonly problemMatchers?: readonly unknown[];
	/** Known execution settings that cannot be honored by the current Tasks runtime. */
	readonly unsupportedFeatures?: readonly string[];
}

/** One task returned by a dynamic provider before TaskService assigns its canonical identity. */
export interface TaskProviderTask {
	readonly scope?: 1 | 2 | URI;
	readonly source?: string;
	readonly isBackground?: boolean;
	readonly problemMatchers?: readonly unknown[];
	readonly execution?: TaskExecution;
	readonly definition?: TaskDefinition;
	readonly cwd?: string;
	readonly environment?: Readonly<Record<string, string | null>>;
	readonly id: string;
	readonly label: string;
	readonly command?: string;
	readonly group: WorkspaceTaskGroup;
	readonly groupIsDefault?: boolean;
	readonly runOptions?: RunOptions;
	readonly presentation?: TaskPresentationOptions;
	readonly detail?: string;
}

/** Dynamic task producer owned by one extension or other runtime caller. */
export interface TaskProvider {
	readonly id: string;
	readonly type?: string;
	provideTasks(signal: AbortSignal): readonly TaskProviderTask[] | PromiseLike<readonly TaskProviderTask[]>;
	resolveTask?(task: IWorkspaceTask, signal: AbortSignal): TaskProviderTask | undefined | PromiseLike<TaskProviderTask | undefined>;
}

/** One caller-owned provider set that can be atomically replaced. */
export interface TaskProviderRegistration extends IDisposable {
	replace(providers: readonly TaskProvider[]): void;
}

export type TaskRunStatus = "running" | "completed" | "succeeded" | "failed" | "canceled";

/** One task execution projected through an integrated Terminal instance. */
export interface ITaskRun {
	readonly runId: string;
	readonly task: IWorkspaceTask;
	readonly terminalId: string;
	/** Custom executions have no operating-system process. */
	readonly processId?: number;
	/** Cancellation status may precede the process owner's asynchronous release. */
	readonly processCompletion?: Promise<number | undefined>;
	/** Completes when the execution owner has released process or custom PTY resources. */
	readonly completion?: Promise<number | undefined>;
	readonly status: TaskRunStatus;
	readonly exitCode: number | undefined;
	/** Background tasks become ready without finishing their process. */
	readonly isReady?: boolean;
	readonly hasBackgroundMatcher?: boolean;
	readonly hasErrors?: boolean;
	readonly onDidBecomeReady?: Event<void>;
	readonly onDidChangeStatus: Event<TaskRunStatus>;
	/** Cursors count UTF-16 code units; use nextCursor because pages preserve complete code points. */
	readOutput(cursor: number, maxCharacters: number): ITaskOutput;
}

export interface ITaskOutput {
	readonly text: string;
	readonly cursor: number;
	readonly nextCursor: number;
	readonly truncated: boolean;
	readonly hasMore: boolean;
}

/** Keeps output pages serializable as UTF-8 strings across the application host boundary. */
export function readTaskOutput(text: string, offset: number, cursor: number, maxCharacters: number): ITaskOutput {
	const outputEnd = offset + text.length;
	if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > outputEnd || !Number.isSafeInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > 65_536) throw new RangeError(localize('tasks.invalidOutputRange', 'Invalid task output cursor or limit. Start with cursor=0 and use a limit between 1 and 65536.'));
	let start = Math.max(cursor, offset) - offset;
	if (isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) start--;
	let end = Math.min(text.length, start + maxCharacters);
	if (isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
		// A one-unit budget must still make progress through a two-unit code point.
		end += end - start === 1 ? 1 : -1;
	}
	return { text: text.slice(start, end), cursor: offset + start, nextCursor: offset + end, truncated: cursor < offset, hasMore: offset + end < outputEnd };
}

/** Static execution recipe reviewed before an Agent starts a configured task. */
export interface ITaskDescription {
	readonly taskId: string;
	readonly label: string;
	readonly directory: string;
	readonly revision: string;
	readonly commands: readonly { readonly command: string; readonly cwd: string; }[];
}

/** Completes on foreground exit or the first background compilation becoming ready. */
export function waitForTask(run: ITaskRun, signal?: AbortSignal): Promise<TaskRunStatus> {
	if (signal?.aborted) {
		return Promise.reject(new CancellationError());
	}
	if (run.status !== 'running' || run.isReady) {
		return Promise.resolve(run.isReady && run.status === 'running' ? 'succeeded' : run.status);
	}
	if (run.task.isBackground && run.hasBackgroundMatcher === false) {
		return Promise.reject(new Error(localize('tasks.backgroundMatcherRequired', "Background task '{0}' needs a problem matcher with begin and end patterns.", run.task.label)));
	}
	return new Promise((resolve, reject) => {
		let statusListener: IDisposable | undefined;
		let readyListener: IDisposable | undefined;
		let settled = false;
		const abort = (): void => { if (!settled) { settled = true; cleanup(); reject(new CancellationError()); } };
		function cleanup(): void {
			statusListener?.dispose();
			readyListener?.dispose();
			signal?.removeEventListener('abort', abort);
		}
		function finish(status: TaskRunStatus): void { if (!settled) { settled = true; cleanup(); resolve(status); } }
		statusListener = run.onDidChangeStatus(status => {
			if (status !== 'running') finish(status);
		});
		if (!settled) readyListener = run.onDidBecomeReady?.(() => finish('succeeded'));
		if (settled) { cleanup(); return; }
		signal?.addEventListener('abort', abort, { once: true });
		// A producer may deliver its retained ready/exit state during subscription.
		if (signal?.aborted) abort();
		else if (run.status !== 'running' || run.isReady) finish(run.isReady && run.status === 'running' ? 'succeeded' : run.status);
	});
}
