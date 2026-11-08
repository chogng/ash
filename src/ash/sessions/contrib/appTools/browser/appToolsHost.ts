import { addDisposableListener } from '../../../../base/browser/dom.js';
import './media/appToolsHost.css';
import { CancellationError } from '../../../../base/common/errors.js';
import { CancellationTokenSource, throwIfCancelled } from '../../../../base/common/cancellation.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Range } from '../../../../editor/common/core/range.js';
import { IModelEvaluationTools, type IAppToolsHost } from '../../../services/appTools/browser/appTools.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { TERMINAL_VIEW_ID } from '../../../../workbench/contrib/terminal/common/terminal.js';
import { ITerminalProfileResolverService } from '../../../../workbench/contrib/terminal/common/terminal.js';
import { ITerminalProcessService, TerminalLocation, type IShellLaunchConfig } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService, type IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import type { IUpdateService, UpdateCheckResult } from '../../../../platform/update/common/updateService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { createDiffEditorInput } from '../../../../workbench/common/editor/diffEditorInput.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { SessionsListTools } from '../../sessions/browser/sessionsListTools.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { PICK_WORKSPACE_FOLDER_COMMAND_ID } from '../../../../workbench/browser/actions/workspaceCommands.js';
import { AgentHostSessionTaskRunner } from '../../terminal/browser/agentHostSessionTaskRunner.js';
import { getRemoteAuthority } from '../../../../platform/remote/common/remoteHosts.js';

/** Window-owned execution; tool definitions and durable business operations belong to Rust. */
export class AppToolsHost extends Disposable implements IAppToolsHost {
	readonly sessionsList: IAppToolsHost['sessionsList'];
	private readonly celebration = this._register(new MutableDisposable());
	private terminalGeneration = 0;
	readonly taskRunner: AgentHostSessionTaskRunner;
	constructor(private readonly ownerDocument: Document, private readonly updates: Pick<IUpdateService, 'checkForUpdates'> | undefined,
		@IEditorService private readonly editors: IEditorService,
		@IOpenerService private readonly opener: IOpenerService,
		@ITerminalService private readonly terminals: ITerminalService,
		@ITerminalProfileResolverService private readonly profiles: ITerminalProfileResolverService,
		@ITerminalProcessService private readonly terminalProcesses: ITerminalProcessService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IViewsService private readonly views: IViewsService,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IAccessibilityService private readonly accessibility: IAccessibilityService,
		@ICommandService private readonly commands: ICommandService,
		@IModelEvaluationTools readonly modelEvaluation: IModelEvaluationTools,
	) {
		super();
		this.sessionsList = instantiation.createInstance(SessionsListTools);
		this.taskRunner = this._register(instantiation.createInstance(AgentHostSessionTaskRunner));
		this._register(workspace.onDidChangeWorkspace(() => this.terminalGeneration++));
		this._register(toDisposable(() => this.clearTransientState()));
		this._register(terminalProcesses.onConnectionState(() => this.terminalGeneration++));
		this._register(accessibility.onDidChangeReducedMotion(() => { if (accessibility.isMotionReduced()) this.celebration.clear(); }));
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
		using selection = new CancellationTokenSource();
		using selectionListener = addDisposableListener(signal, 'abort', () => selection.cancel());
		const folders = this.workspace.getWorkspace().folders;
		const activeResource = this.editors.activeEditor?.resource;
		const folder = (activeResource && this.workspace.getWorkspaceFolder(activeResource))
			|| (folders.length === 1 ? folders[0] : await this.commands.executeCommand<IWorkspaceFolder | undefined>(PICK_WORKSPACE_FOLDER_COMMAND_ID, [{ placeHolder: localize('terminal.selectFolder', 'Select a workspace folder for the terminal.') }, selection.token]));
		assertCurrent();
		if (!folder) throw new CancellationError();
		const options = { os, remoteAuthority: getRemoteAuthority(folder.uri), workspaceFolder: folder, allowAgentHostShell: true };
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
			if (terminal.target !== TerminalLocation.Editor) await this.views.openView(TERMINAL_VIEW_ID, true);
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
	public async checkUpdate(): Promise<UpdateCheckResult> {
		if (!this.updates) throw new Error('Desktop updates are unavailable in this window');
		return this.updates.checkForUpdates();
	}
	public clearTransientState(): void {
		this.taskRunner.cancelOwnedRuns();
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
