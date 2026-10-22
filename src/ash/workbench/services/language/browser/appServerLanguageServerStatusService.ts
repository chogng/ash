import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Separator, SubmenuAction, type IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { localize } from '../../../../nls.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IServerEventApi } from '../../../../platform/agentHost/common/appServerApi.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILanguageServerService, type LanguageServerState, type LanguageServerControl } from '../../../../platform/language/common/languageServerService.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IProgressService, ProgressLocation, type IProgress, type IProgressStep } from '../../../../platform/progress/common/progress.js';
import type { LanguageServerMessageNotification, LanguageServerProgressNotification, LanguageServerStateNotification } from '../../../../../../.build/protocol/typescript/index.js';
import { IOutputService, type IOutputChannel } from '../../output/common/output.js';
import { IStatusbarService, StatusbarAlignment, type IStatusbarEntryAccessor } from '../../statusbar/browser/statusbar.js';
import { ILanguageServerStatusService, LanguageServerMenuFocused, LANGUAGE_SERVER_STATUS_ENTRY_ID } from '../common/languageServerStatusService.js';

let nextOutputCommand = 0;
const entryId = LANGUAGE_SERVER_STATUS_ENTRY_ID;

interface Server {
	readonly id: string;
	readonly dirId?: string;
	state?: LanguageServerState;
	issue?: string;
	/** A snapshot requested before this event must not overwrite it. */
	revision: number;
}
interface LanguageServerTask {
	readonly server: Server;
	readonly downloading: boolean;
	readonly completion: DeferredPromise<void>;
	progress?: IProgress<IProgressStep>;
	title: string;
	message?: string;
	percentage?: number;
	/** Last absolute percentage delivered to the incremental progress contract. */
	reportedPercentage?: number;
}

/** Projects connection-local lifecycle events into a shared Workbench management surface. */
export class AppServerLanguageServerStatusService extends Disposable implements ILanguageServerStatusService {
	private readonly channels = new Map<string, IOutputChannel>();
	private readonly progress = new Map<string, LanguageServerTask>();
	private readonly servers = new Map<string, Server>();
	private readonly notified = new Map<string, string>();
	private readonly catalog = new Map<string, readonly string[]>();
	private readonly catalogErrors = new Map<string, string>();
	private readonly statusEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private revision = 0;
	private openGeneration = 0;
	private disposed = false;

	constructor(
		@IServerEventApi events: IServerEventApi,
		@ILanguageServerService private readonly languageServers: ILanguageServerService,
		@INotificationService private readonly notifications: INotificationService,
		@IOutputService private readonly outputService: IOutputService,
		@IStatusbarService private readonly statusbar: IStatusbarService,
		@IProgressService private readonly progressService: IProgressService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IContextMenuService private readonly menus: IContextMenuService,
		@IContextViewService private readonly contextView: IContextViewService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService private readonly accessibleView: IAccessibleViewService,
	) {
		super();
		const focused = LanguageServerMenuFocused.bindTo(contextKeys);
		this._register(toDisposable(() => {
			this.disposed = true;
			this.openGeneration++;
			focused.reset();
			for (const task of this.progress.values()) void task.completion.complete(undefined);
			this.progress.clear();
		}));
		this._register(menus.onDidHideContextMenu(() => focused.reset()));
		this.setMenuFocused = value => focused.set(value);
		const eventsSubscription = events.subscribe(event => {
			if (event.method === 'language/serverMessage') this.acceptMessage(event.params);
			if (event.method === 'language/serverProgress') this.acceptProgress(event.params);
			if (event.method === 'language/serverState') this.acceptState(event.params);
		});
		this._register(toDisposable(() => eventsSubscription.dispose()));
		this._register(workspace.onDidChangeWorkspace(() => {
			this.openGeneration++;
			this.catalog.clear();
			this.catalogErrors.clear();
			this.updateStatus();
		}));
		this.updateStatus();
	}

	private readonly setMenuFocused: (value: boolean) => void;

	async open(): Promise<void> {
		const generation = ++this.openGeneration;
		const folders = this.workspace.getWorkspace().folders;
		await Promise.all(folders.map(async folder => {
			const revision = this.revision;
			try {
				const snapshot = await this.languageServers.read(folder.id);
				if (generation !== this.openGeneration || this.disposed) return;
				this.catalog.set(folder.id, snapshot.servers.map(server => server.id));
				this.catalogErrors.delete(folder.id);
				for (const descriptor of snapshot.servers) {
					const server = this.server(descriptor.id, folder.id);
					if (server.revision <= revision) server.state = descriptor.state;
				}
			} catch (error) {
				if (generation === this.openGeneration && !this.disposed) this.catalogErrors.set(folder.id, String(error));
			}
		}));
		if (generation !== this.openGeneration || this.disposed) return;
		const document = this.contextView.container.ownerDocument;
		const bounds = this.contextView.container.getBoundingClientRect();
		// A command can run in a host without a visible status bar. Never anchor a
		// replacement menu to an item that its own presentation is about to remove.
		const anchor = document.querySelector<HTMLElement>(`[data-statusbar-item-id="${entryId}"] .ash-statusbar-item-label`)
			?? { x: bounds.left + 16, y: Math.max(bounds.top, bounds.bottom - 16), targetWindow: document.defaultView ?? undefined };
		this.menus.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => this.menuActions(),
			anchorPosition: AnchorPosition.Above,
			autoSelectFirstItem: true,
			onHide: () => this.setMenuFocused(false),
		});
		this.setMenuFocused(true);
	}

	getAccessibleContent(): string {
		return this.workspace.getWorkspace().folders.map(folder => [folder.name, ...this.folderServers(folder.id).map(server =>
			localize('languageServer.accessibleState', '{0}: {1}', server.id, this.description(server))),
		this.catalogErrors.has(folder.id) ? localize('languageServer.unavailable', 'Unable to load servers. Try opening Language Services again.') : '',
		].filter(Boolean).join('\n')).join('\n\n') || localize('languageServer.noWorkspace', 'Open a workspace to manage language servers.');
	}

	private menuActions(): IAction[] {
		const actions: IAction[] = [];
		for (const folder of this.workspace.getWorkspace().folders) {
			if (actions.length) actions.push(new Separator());
			actions.push(this.action(`folder.${folder.id}`, folder.name, () => { }, false));
			const servers = this.folderServers(folder.id);
			for (const server of servers) {
				actions.push(new SubmenuAction(`server.${key(server)}`, server.id, [
					this.action('state', this.description(server), () => { }, false),
					new Separator(),
					this.action('logs', localize('languageServer.viewLogs', 'View Logs'), () => this.ensureChannel(server).show()),
					this.action('restart', localize('languageServer.restart', 'Restart Server'), () => this.control({ action: 'restart', dirId: folder.id, serverId: server.id })),
					this.action('stop', localize('languageServer.stop', 'Stop Server'), () => this.control({ action: 'stop', dirId: folder.id, serverId: server.id }), !!server.state && server.state.type !== 'stopped'),
				], server.issue || server.state?.type === 'failed' || server.state?.type === 'crashLoop' ? Lxicon.warning : server.state?.type === 'ready' ? Lxicon.check : undefined));
			}
			if (!servers.length) actions.push(this.action('empty', localize('languageServer.empty', 'No language servers'), () => { }, false));
			if (this.catalogErrors.has(folder.id)) actions.push(this.action('unavailable', localize('languageServer.unavailable', 'Unable to load servers. Try opening Language Services again.'), () => { }, false));
			actions.push(new Separator(),
				this.action(`restart.${folder.id}`, localize('languageServer.restartWorkspace', 'Restart Servers in {0}', folder.name), () => this.control({ action: 'restart', dirId: folder.id }), servers.some(server => !!server.state)),
				this.action(`stop.${folder.id}`, localize('languageServer.stopWorkspace', 'Stop Servers in {0}', folder.name), () => this.control({ action: 'stop', dirId: folder.id }), servers.some(server => !!server.state && server.state.type !== 'stopped')),
			);
		}
		if (!actions.length) actions.push(this.action('noWorkspace', localize('languageServer.noWorkspace', 'Open a workspace to manage language servers.'), () => { }, false));
		if (this.workspace.getWorkspace().folders.length > 1) {
			actions.push(new Separator(),
				this.action('restartAll', localize('languageServer.restartAll', 'Restart All Servers'), () => this.controlAll('restart'), this.hasStartedServer()),
				this.action('stopAll', localize('languageServer.stopAll', 'Stop All Servers'), () => this.controlAll('stop'), this.hasStartedServer(true)),
			);
		}
		return actions;
	}

	private folderServers(dirId: string): Server[] {
		const ids = new Set(this.catalog.get(dirId) ?? []);
		// A successful discovery read is authoritative for enablement and removed providers.
		// Retained Output channels remain readable after a server leaves this catalog.
		if (!this.catalog.has(dirId)) for (const server of this.servers.values()) if (server.dirId === dirId) ids.add(server.id);
		return [...ids].sort((a, b) => a.localeCompare(b)).map(id => this.server(id, dirId));
	}

	private hasStartedServer(running = false): boolean {
		return this.workspace.getWorkspace().folders.some(folder => this.folderServers(folder.id).some(server => !!server.state && (!running || server.state.type !== 'stopped')));
	}

	private async controlAll(action: LanguageServerControl['action']): Promise<void> {
		await Promise.all(this.workspace.getWorkspace().folders.map(folder => this.control({ action, dirId: folder.id })));
	}

	private async control(request: LanguageServerControl): Promise<void> {
		try {
			await this.languageServers.control(request);
		} catch (error) {
			const server = request.serverId ? this.server(request.serverId, request.dirId) : { id: localize('languageServer.all', 'All language servers'), dirId: request.dirId, revision: 0 };
			const text = String(error);
			this.ensureChannel(server).appendLine({ severity: 'error', category: 'control', text });
			this.notifyFailure(server, localize('languageServer.controlFailed', 'Could not {0} {1}.', request.action === 'restart' ? localize('languageServer.restartVerb', 'restart') : localize('languageServer.stopVerb', 'stop'), this.serverLabel(server)), text, request);
		}
	}

	private action(id: string, label: string, run: () => unknown, enabled = true): IAction {
		return { id: `ash.languageServers.${id}`, label, tooltip: label, enabled, run };
	}

	private acceptMessage(message: LanguageServerMessageNotification): void {
		const text = message.message.trim();
		if (!text) return;
		const server = this.server(message.server, message.dirId);
		this.ensureChannel(server).appendLine({ severity: message.severity, category: message.source, text });
		if (message.severity === 'warning' || message.severity === 'error') {
			server.issue = summary(text);
			server.revision = ++this.revision;
		}
		if (message.show && message.severity === 'error') this.notifyFailure(server, summary(text), text);
		this.updateStatus();
	}

	private acceptState(update: LanguageServerStateNotification): void {
		const server = this.server(update.server, update.dirId);
		server.state = { ...update.state };
		server.revision = ++this.revision;
		const presentation = lifecyclePresentation(update.state);
		this.ensureChannel(server).appendLine({ severity: presentation.severity, category: 'lifecycle', text: presentation.text });
		if (update.state.type === 'ready') {
			server.issue = undefined;
			this.notified.delete(key(server));
		}
		if (update.state.type === 'failed' || update.state.type === 'crashLoop') {
			server.issue = summary(update.state.message);
			this.notifyFailure(server, localize('languageServer.failedNotification', '{0} needs attention. {1}', this.serverLabel(server), server.issue), update.state.message);
		}
		if (['stopped', 'failed', 'crashLoop'].includes(update.state.type)) {
			for (const [token, task] of this.progress) if (task.server === server) {
				void task.completion.complete(undefined);
				this.progress.delete(token);
			}
		}
		for (const task of this.progress.values()) task.progress?.report({ message: progressMessage(task, this.progress.size) });
		this.updateStatus();
	}

	private notifyFailure(server: Server, message: string, detail: string, retry?: LanguageServerControl): void {
		if (this.notified.get(key(server)) === detail) return;
		this.notified.set(key(server), detail);
		this.notifications.notify({
			severity: Severity.Error, message, source: this.serverLabel(server), actions: {
				primary: [
					this.action('logs', localize('languageServer.viewLogs', 'View Logs'), () => this.ensureChannel(server).show()),
					retry ? this.action('retry', localize('languageServer.retry', 'Retry'), () => this.control(retry)) : this.action('restart', localize('languageServer.restart', 'Restart Server'), () => this.control({ action: 'restart', dirId: server.dirId, serverId: server.id })),
				]
			}
		});
	}

	private acceptProgress(update: LanguageServerProgressNotification): void {
		const server = this.server(update.server, update.dirId);
		this.ensureChannel(server);
		const token = `${key(server)}\0${update.token}`;
		let task = this.progress.get(token);
		if (update.done) {
			if (task) void task.completion.complete(undefined);
			this.progress.delete(token);
		} else {
			const downloading = update.token === 'ash.language-server.download';
			const title = downloading ? localize('languageServer.downloading', 'Downloading {0}…', update.server) : update.title?.trim();
			if (!task) {
				task = { server, downloading, completion: new DeferredPromise<void>(), title: title || localize('languageServer.operation', 'Language server operation'), message: update.message?.trim(), percentage: update.percentage ?? undefined };
				this.progress.set(token, task);
				if (downloading) {
					status(task.title);
					this.ensureChannel(server).appendLine({ severity: 'information', category: 'download', text: task.title });
				}
				const commandId = `ash.languageServers.showOutput.${++nextOutputCommand}`;
				const command = CommandsRegistry.register(commandId, () => this.ensureChannel(server).show());
				const current = task;
				void this.progressService.withProgress({ location: ProgressLocation.Window, title: downloading ? task.title : this.serverLabel(server), command: commandId }, progress => {
					current.progress = progress;
					this.reportProgress(current);
					return current.completion.p;
				}).finally(() => command.dispose()).catch(onUnexpectedError);
			}
			if (title) task.title = title;
			// Omitted details retain the last report; an empty message explicitly clears it.
			if (update.message != null) task.message = update.message.trim();
			if (update.percentage != null) task.percentage = update.percentage;
		}
		for (const task of this.progress.values()) this.reportProgress(task);
		this.updateStatus();
	}

	private reportProgress(task: LanguageServerTask): void {
		if (!task.progress) return;
		task.progress.report({
			message: progressMessage(task, this.progress.size),
			...(task.percentage === undefined ? {} : { total: 100, increment: task.percentage - (task.reportedPercentage ?? 0) }),
		});
		task.reportedPercentage = task.percentage;
	}

	private updateStatus(): void {
		if (!this.workspace.getWorkspace().folders.length) { this.statusEntry.clear(); return; }
		const active = this.workspace.getWorkspace().folders.flatMap(folder => this.folderServers(folder.id));
		const issues = active.filter(server => server.issue || server.state?.type === 'failed' || server.state?.type === 'crashLoop').length;
		const starting = active.some(server => server.state?.type === 'starting' || server.state?.type === 'backingOff');
		const text = localize('languageServer.services', 'Language Services');
		const hint = this.accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.LanguageServers);
		const entry = { text, icon: issues ? Lxicon.warning : starting ? Lxicon.sync : Lxicon.code, showProgress: starting && !issues, ariaLabel: `${text}${hint ? `. ${hint}` : ''}`, tooltip: issues ? localize('languageServer.issues', 'Language Services: {0} servers need attention', issues) : text, run: () => this.open() };
		if (this.statusEntry.value) this.statusEntry.value.update(entry);
		else this.statusEntry.value = this.statusbar.addEntry(entry, { id: entryId, alignment: StatusbarAlignment.Left, priority: -100 });
	}

	private server(id: string, dirId?: string): Server {
		dirId ??= this.workspace.getWorkspace().folders.length === 1 ? this.workspace.getWorkspace().folders[0].id : undefined;
		const identity = key({ id, dirId });
		let server = this.servers.get(identity);
		if (!server) { server = { id, dirId, revision: 0 }; this.servers.set(identity, server); }
		return server;
	}

	private serverLabel(server: Server): string {
		if (!server.dirId) return server.id;
		return `${server.id} — ${this.workspace.getWorkspace().folders.find(folder => folder.id === server.dirId)?.name || server.dirId}`;
	}

	private description(server: Server): string {
		const state = server.state;
		const label = !state ? localize('languageServer.idle', 'Not started') : state.type === 'ready' ? localize('languageServer.running', 'Running') : state.type === 'stopped' ? localize('languageServer.stopped', 'Stopped') : state.type === 'starting' ? localize('languageServer.starting', 'Starting…') : state.type === 'backingOff' ? localize('languageServer.restarting', 'Restarting…') : localize('languageServer.failed', 'Failed');
		const issue = server.issue ?? (state?.type === 'failed' || state?.type === 'crashLoop' ? state.message : undefined);
		return issue ? localize('languageServer.stateIssue', '{0}: {1}', label, summary(issue, 90)) : label;
	}

	private ensureChannel(server: Server): IOutputChannel {
		const id = `language-server.${encodeURIComponent(server.id)}${server.dirId ? `.${encodeURIComponent(server.dirId)}` : ''}`;
		const existing = this.channels.get(id);
		if (existing) return existing;
		const channel = this._register(this.outputService.createChannel({ id, label: this.serverLabel(server), kind: 'log', source: 'core' }));
		this.channels.set(id, channel);
		return channel;
	}
}

function key(server: Pick<Server, 'id' | 'dirId'>): string { return `${server.dirId ?? ''}\0${server.id}`; }
function summary(text: string, limit = 180): string { const first = text.trim().split(/[\r\n]/, 1)[0]; return first.length > limit ? `${first.slice(0, limit - 1)}…` : first; }
function progressMessage(task: LanguageServerTask, count: number): string {
	let message: string;
	if (task.downloading) {
		const percentage = task.percentage === undefined ? '' : ` ${task.percentage}%`;
		message = `${task.message ?? ''}${percentage}`.trim();
	} else {
		const operation = task.percentage === undefined ? task.title : localize('languageServer.progressOperation', '{0} ({1}%)', task.title, task.percentage);
		message = task.message ? localize('progress.titleMessage', '{0}: {1}', operation, task.message) : operation;
	}
	return count > 1 ? localize('languageServer.moreProgress', '{0} +{1} more', message, count - 1).trim() : message;
}
function lifecyclePresentation(state: LanguageServerState): { readonly severity: 'information' | 'warning' | 'error' | 'log'; readonly text: string; } {
	switch (state.type) {
		case 'starting': return { severity: 'information', text: localize('languageServer.logStarting', 'Starting language server…') };
		case 'ready': return { severity: 'information', text: localize('languageServer.logReady', 'Language server is ready.') };
		case 'backingOff': return { severity: 'warning', text: localize('languageServer.logRetry', 'Language server stopped unexpectedly; restart attempt {0} begins in {1}ms.', state.attempt, state.retryAfterMillis) };
		case 'crashLoop': return { severity: 'error', text: localize('languageServer.logCrashLoop', 'Language server entered a crash loop after {0} restart attempts: {1}', state.restartAttempts, state.message) };
		case 'failed': return { severity: 'error', text: localize('languageServer.logFailed', 'Language server failed: {0}', state.message) };
		case 'stopped': return { severity: 'log', text: localize('languageServer.logStopped', 'Language server stopped.') };
	}
}
