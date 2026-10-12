import './media/appToolsHost.css';
import { CancellationError } from '../../../../base/common/errors.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { ITaskService, type ITaskRun, type IWorkspaceTask, type ITaskDescription, type ITaskOutput } from '../../../../workbench/services/tasks/common/taskService.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { URI } from '../../../../base/common/uri.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Range } from '../../../../editor/common/core/range.js';
import type { IAppToolsHost, TaskRunSummary, TaskCatalog } from '../../../services/appTools/browser/appTools.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { ITerminalService } from '../../../../workbench/services/terminal/browser/terminal.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { TERMINAL_VIEW_ID } from '../../../../workbench/contrib/terminal/common/terminal.js';
import { ITerminalProfileResolverService } from '../../../../workbench/services/terminal/common/terminal.js';
import { ITerminalProcessService, type IShellLaunchConfig } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import type { IUpdateService, UpdateCheckResult } from '../../../../platform/update/common/updateService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { createDiffEditorInput } from '../../../../workbench/common/editor/diffEditorInput.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { ISessionGroupsService, type SessionGroup } from '../../../services/sessions/browser/sessionGroupsService.js';

/** Window-owned execution; tool definitions and durable business operations belong to Rust. */
export class AppToolsHost extends Disposable implements IAppToolsHost {
	private readonly celebration = this._register(new MutableDisposable());
	private terminalGeneration = 0;
	private readonly agentTaskRuns = new Set<ITaskRun>();
	constructor(private readonly ownerDocument: Document, private readonly updates: Pick<IUpdateService, 'checkForUpdates'> | undefined,
		@IEditorService private readonly editors: IEditorService,
		@IOpenerService private readonly opener: IOpenerService,
		@ITaskService private readonly tasks: ITaskService,
		@ITerminalService private readonly terminals: ITerminalService,
		@ITerminalProfileResolverService private readonly profiles: ITerminalProfileResolverService,
		@ITerminalProcessService private readonly terminalProcesses: ITerminalProcessService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IViewsService private readonly views: IViewsService,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
		@ISessionGroupsService private readonly groups: ISessionGroupsService,
		@IAccessibilityService private readonly accessibility: IAccessibilityService,
	) {
		super();
		this._register(workspace.onDidChangeWorkspace(() => this.terminalGeneration++));
		this._register(toDisposable(() => this.clearTransientState()));
		this._register(terminalProcesses.onConnectionState(() => this.terminalGeneration++));
		this._register(accessibility.onDidChangeReducedMotion(() => { if (accessibility.isMotionReduced()) this.celebration.clear(); }));
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
		const dirId = this.taskFolder(directory);
		await raceCancellationError(this.tasks.refresh(), signal);
		throwIfCancelled(signal);
		this.taskFolder(directory);
		const tasks = await Promise.all(this.tasks.tasks.filter(task => task.dirId === dirId).map(async task => {
			let revision: string | null = null;
			let unavailableReason: string | null = null;
			try { revision = (await this.tasks.describe(task)).revision; }
			catch (error) { unavailableReason = error instanceof Error ? error.message : String(error); }
			return { taskId: task.id, label: task.label, source: task.source, group: task.group, revision, unavailableReason };
		}));
		throwIfCancelled(signal);
		return { tasks, runs: this.tasks.runs.filter(run => run.task.dirId === dirId).map(taskSummary) };
	}
	public async describeTask(directory: string, taskId: string, revision: string, signal: AbortSignal): Promise<ITaskDescription> {
		this.taskFolder(directory);
		await raceCancellationError(this.tasks.refresh(), signal);
		const description = await raceCancellationError(this.tasks.describe(this.findTask(directory, taskId)), signal);
		if (description.revision !== revision) throw new Error(localize('tasks.agentRevisionChanged', 'The task configuration changed after review. Discover the task again before running it.'));
		return description;
	}
	public async runTask(directory: string, taskId: string, revision: string, signal: AbortSignal): Promise<TaskRunSummary> {
		await this.describeTask(directory, taskId, revision, signal);
		throwIfCancelled(signal);
		const run = this.tasks.start(this.findTask(directory, taskId), signal, revision);
		this.agentTaskRuns.add(run);
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
	public async openFile(resource: URI, line?: number): Promise<void> {
		await this.editors.openEditor({ resource }, { pinned: true, ignoreError: true, ...(line ? { selection: new Range(line, 1, line, 1) } : {}) });
	}
	public async openReview(original: URI, modified: URI): Promise<void> {
		await this.editors.openEditor(createDiffEditorInput({ resource: original }, { resource: modified }), { pinned: true, ignoreError: true });
	}
	public openBrowser(resource: URI): Promise<boolean> {
		return this.opener.open(resource, { openExternal: true, allowContributedOpeners: 'ash.browser.open', allowCommands: false });
	}
	public async openTerminal(signal: AbortSignal): Promise<string> {
		const generation = this.terminalGeneration;
		const assertCurrent = (): void => {
			throwIfCancelled(signal);
			if (this.isDisposed || generation !== this.terminalGeneration) throw new CancellationError();
		};
		assertCurrent();
		const os = this.terminalProcesses.operatingSystem;
		if (os === undefined) throw new Error(localize('terminal.profile.platformUnavailable', 'The terminal execution host is not ready.'));
		const folder = this.workspace.getWorkspace().folders[0];
		const options = { os, remoteAuthority: folder?.uri.authority || undefined, allowAgentHostShell: true };
		const profile = await this.profiles.getDefaultProfile(options);
		assertCurrent();
		const shell: IShellLaunchConfig = { name: profile.profileName, executable: profile.path, args: profile.args, env: profile.env, icon: profile.icon, color: profile.color };
		await this.profiles.resolveShellLaunchConfig(shell, options);
		assertCurrent();
		const terminal = await this.terminals.createTerminal({
			profile: { type: 'custom', name: profile.profileName, path: typeof shell.executable === 'string' ? [shell.executable] : shell.executable!, args: shell.args ?? [] },
			dirId: folder?.id, dimensions: { cols: 80, rows: 24 }, env: shell.env, cwd: shell.cwd, icon: shell.icon, color: shell.color,
		});
		try {
			assertCurrent();
			this.terminals.setActiveInstance(terminal);
			await this.views.openView(TERMINAL_VIEW_ID, true);
			assertCurrent();
		} catch (error) {
			// The request owns a late PTY even after cancellation or view failure.
			await this.terminals.closeTerminal(terminal).catch(() => { });
			throw error;
		}
		return terminal.id;
	}
	public async navigate(sessionId: string, threadId: string): Promise<void> {
		await this.navigation.openConversation(sessionId, threadId);
	}
	public listSections(): readonly SessionGroup[] {
		return this.groups.groups;
	}
	public createSection(name: string, signal: AbortSignal): Promise<SessionGroup> {
		return this.groups.create(name, signal);
	}
	public renameSection(sectionId: string, name: string, signal: AbortSignal): Promise<void> {
		return this.groups.rename(sectionId, name, signal);
	}
	public deleteSection(sectionId: string, signal: AbortSignal): Promise<void> {
		return this.groups.delete(sectionId, signal);
	}
	public moveSession(sessionId: string, sectionId: string | null, signal: AbortSignal): Promise<void> {
		return this.groups.move(sessionId, sectionId, signal);
	}
	public reorderSection(sectionId: string, sessionIds: readonly string[], signal: AbortSignal): Promise<void> {
		return this.groups.reorder(sectionId, sessionIds, signal);
	}
	public async checkUpdate(): Promise<UpdateCheckResult> {
		if (!this.updates) throw new Error('Desktop updates are unavailable in this window');
		return this.updates.checkForUpdates();
	}
	public clearTransientState(): void {
		for (const run of this.agentTaskRuns) void this.tasks.terminate(run).catch(() => undefined);
		this.agentTaskRuns.clear();
		this.celebration.clear();
	}
	public fireConfetti(): boolean {
		this.celebration.clear();
		if (this.accessibility.isMotionReduced()) return false;
		const overlay = this.ownerDocument.createElement('div');
		overlay.setAttribute('aria-hidden', 'true');
		overlay.className = 'ash-app-confetti';
		const animations: Animation[] = [];
		for (let index = 0; index < 24; index++) {
			const particle = this.ownerDocument.createElement('span');
			particle.textContent = ['🎉', '✨', '🎊'][index % 3];
			particle.className = 'ash-app-confetti-particle';
			particle.style.left = `${(index + 0.5) / 24 * 100}%`;
			overlay.append(particle);
			animations.push(particle.animate([{ transform: 'translateY(-32px) rotate(0deg)', opacity: 1 }, { transform: `translateY(${this.ownerDocument.documentElement.clientHeight}px) rotate(${index % 2 ? 360 : -360}deg)`, opacity: 0 }], { duration: 1500, delay: index % 4 * 60, fill: 'both' }));
		}
		this.ownerDocument.body.append(overlay);
		const timer = setTimeout(() => this.celebration.clear(), 1800);
		this.celebration.value = toDisposable(() => { clearTimeout(timer); animations.forEach(animation => animation.cancel()); overlay.remove(); });
		return true;
	}
}

function taskSummary(run: ITaskRun): TaskRunSummary {
	return { runId: run.runId, taskId: run.task.id, label: run.task.label, terminalId: run.terminalId, status: run.status, exitCode: run.exitCode ?? null, ready: run.isReady === true, hasErrors: run.hasErrors === true };
}
