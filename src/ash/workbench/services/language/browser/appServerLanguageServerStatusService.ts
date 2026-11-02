import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { AnchorPosition, ContextView, ContextViewFocusRestore } from '../../../../base/browser/ui/contextview/contextview.js';
import { addDisposableListener, isHTMLElement } from '../../../../base/browser/dom.js';
import { LanguageServerStatusWidget, type LanguageServerStatusFolder } from './languageServerStatusWidget.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { localize } from '../../../../nls.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IServerEventApi } from '../../../../platform/agentHost/common/appServerApi.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILanguageServerService, type LanguageServerState, type LanguageServerControl } from '../../../../platform/language/common/languageServerService.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IProgressService, ProgressLocation, type IProgress, type IProgressStep } from '../../../../platform/progress/common/progress.js';
import type { LanguageServerMessageNotification, LanguageServerProgressNotification, LanguageServerStateNotification } from '../../../../../../.build/protocol/typescript/index.js';
import { IOutputService, type IOutputChannel } from '../../output/common/output.js';
import { IStatusbarService, StatusbarAlignment, type IStatusbarEntryAccessor } from '../../statusbar/browser/statusbar.js';
import { ILanguageServerStatusService, LanguageServerStatusFocused, LANGUAGE_SERVER_STATUS_ENTRY_ID } from '../common/languageServerStatusService.js';

let nextOutputCommand = 0;
const entryId = LANGUAGE_SERVER_STATUS_ENTRY_ID;

interface Server {
	readonly id: string;
	readonly dirId?: string;
	state?: LanguageServerState;
	issue?: { readonly message: string; readonly severity: 'warning' | 'error'; };
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
	private readonly loadingCatalogs = new Set<string>();
	private readonly statusEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly popup = this._register(new MutableDisposable<DisposableStore>());
	private widget: LanguageServerStatusWidget | undefined;
	private readonly pendingControls = new Map<string, LanguageServerControl>();
	private revision = 0;
	private openGeneration = 0;

	constructor(
		@IServerEventApi events: IServerEventApi,
		@ILanguageServerService private readonly languageServers: ILanguageServerService,
		@INotificationService private readonly notifications: INotificationService,
		@IOutputService private readonly outputService: IOutputService,
		@IStatusbarService private readonly statusbar: IStatusbarService,
		@IProgressService private readonly progressService: IProgressService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IContextViewService private readonly contextView: IContextViewService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService private readonly accessibleView: IAccessibleViewService,
	) {
		super();
		const focused = LanguageServerStatusFocused.bindTo(contextKeys);
		this._register(toDisposable(() => {
			this.openGeneration++;
			focused.reset();
			for (const task of this.progress.values()) void task.completion.complete(undefined);
			this.progress.clear();
		}));
		this.setWidgetFocused = value => focused.set(value);
		const eventsSubscription = events.subscribe(event => {
			if (event.method === 'language/serverMessage') this.acceptMessage(event.params);
			if (event.method === 'language/serverProgress') this.acceptProgress(event.params);
			if (event.method === 'language/serverState') this.acceptState(event.params);
		});
		this._register(toDisposable(() => eventsSubscription.dispose()));
		this._register(workspace.onDidChangeWorkspace(() => {
			this.openGeneration++;
			this.popup.clear();
			focused.reset();
			this.catalog.clear();
			this.catalogErrors.clear();
			this.loadingCatalogs.clear();
			this.updateStatus();
		}));
		this.updateStatus();
	}

	private readonly setWidgetFocused: (value: boolean) => void;

	async open(): Promise<void> {
		if (this.isDisposed) {
			return;
		}
		const generation = ++this.openGeneration;
		const folders = this.workspace.getWorkspace().folders;
		this.loadingCatalogs.clear();
		for (const folder of folders) {
			this.loadingCatalogs.add(folder.id);
		}
		this.showWidget();
		await Promise.all(folders.map(async folder => {
			const revision = this.revision;
			try {
				const snapshot = await this.languageServers.read(folder.id);
				if (generation !== this.openGeneration || this.isDisposed) return;
				this.catalog.set(folder.id, snapshot.servers.map(server => server.id));
				this.catalogErrors.delete(folder.id);
				for (const descriptor of snapshot.servers) {
					const server = this.server(descriptor.id, folder.id);
					if (server.revision <= revision) server.state = descriptor.state;
				}
			} catch (error) {
				if (generation === this.openGeneration && !this.isDisposed) this.catalogErrors.set(folder.id, String(error));
			} finally {
				if (generation === this.openGeneration && !this.isDisposed) {
					this.loadingCatalogs.delete(folder.id);
					this.updateStatus();
				}
			}
		}));
	}

	private showWidget(): void {
		const document = this.contextView.container.ownerDocument;
		const bounds = this.contextView.container.getBoundingClientRect();
		const anchor = document.querySelector<HTMLElement>(`[data-statusbar-item-id="${entryId}"] .ash-statusbar-item-label`)
			?? { left: bounds.left + 16, top: Math.max(bounds.top, bounds.bottom - 16), width: 0, height: 0 };
		this.popup.clear();
		const resources = new DisposableStore();
		const view = resources.add(new ContextView(this.contextView.container));
		const widget = resources.add(new LanguageServerStatusWidget(document, {
			control: request => request.dirId ? this.control(request) : this.controlAll(request.action),
			showLogs: (dirId, serverId) => {
				this.popup.clear();
				this.ensureChannel(this.server(serverId, dirId)).show();
			},
		}));
		this.popup.value = resources;
		this.widget = widget;
		resources.add(toDisposable(() => {
			// A replacement context view owns its own focus and must not be hidden.
			if (widget.domNode.isConnected) {
				view.hide();
			}
			if (this.widget === widget) {
				this.widget = undefined;
				this.setWidgetFocused(false);
				if (!this.isDisposed) {
					this.updateStatus();
				}
			}
		}));
		const hint = this.accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.LanguageServers);
		if (hint) {
			widget.setAccessibilityHint(hint);
		}
		resources.add(addDisposableListener(widget.domNode, 'focusin', () => this.setWidgetFocused(true)));
		resources.add(addDisposableListener(widget.domNode, 'focusout', event => {
			if (!isHTMLElement(event.relatedTarget) || !widget.domNode.contains(event.relatedTarget)) {
				this.setWidgetFocused(false);
			}
		}));
		widget.update(this.widgetFolders());
		if (isHTMLElement(anchor)) {
			anchor.focus();
		}
		// Prevent pointer default focus from overriding the host's focus restoration.
		resources.add(addDisposableListener(document, 'pointerdown', event => {
			if (!isHTMLElement(event.target) || widget.domNode.contains(event.target)
				|| (isHTMLElement(anchor) && anchor.contains(event.target))
				|| event.target.closest('dialog:modal')) {
				return;
			}
			event.preventDefault();
		}, true));
		const shown = view.show({
			anchor, content: widget.domNode, anchorPosition: AnchorPosition.Above,
			// The window's shared tooltip host remains above this independent surface.
			layer: -1, presentation: 'menu', focusRestore: ContextViewFocusRestore.Previous,
			isTargetWithin: target => widget.domNode.contains(target),
			onHide: () => {
				if (this.popup.value === resources) {
					this.popup.clear();
				}
			},
		});
		if (!shown || this.widget !== widget) {
			if (this.popup.value === resources) {
				this.popup.clear();
			}
			return;
		}
		this.setWidgetFocused(true);
		this.updateStatus();
		widget.focus();
	}

	getAccessibleContent(): string {
		return this.workspace.getWorkspace().folders.map(folder => [folder.name, folder.uri.path, ...this.folderServers(folder.id).map(server =>
			[localize('languageServer.accessibleState', '{0}: {1}', server.id, this.description(server)), this.progressDescription(server)].filter(Boolean).join('\n')),
		this.catalogErrors.has(folder.id) ? localize('languageServer.unavailable', 'Unable to load servers. Try opening Language Services again.') : '',
		].filter(Boolean).join('\n')).join('\n\n') || localize('languageServer.noWorkspace', 'Open a workspace to manage language servers.');
	}

	private widgetFolders(): LanguageServerStatusFolder[] {
		return this.workspace.getWorkspace().folders.map(folder => {
			const servers = this.folderServers(folder.id);
			return {
				id: folder.id, name: folder.name, path: folder.uri.path, busy: this.isControlPending(folder.id),
				unavailable: this.catalogErrors.has(folder.id), loading: this.loadingCatalogs.has(folder.id),
				canRestart: servers.some(server => !!server.state) && !this.isControlPending(folder.id),
				canStop: servers.some(server => !!server.state && server.state.type !== 'stopped') && !this.isControlPending(folder.id),
				servers: servers.map(server => ({
					id: server.id, status: this.stateLabel(server), detail: this.issueDescription(server),
					progress: this.progressDescription(server),
					activity: this.serverActivity(server),
					canRestart: !this.isControlPending(folder.id, server.id),
					canStop: !!server.state && server.state.type !== 'stopped' && !this.isControlPending(folder.id, server.id),
				})),
			};
		});
	}

	private serverActivity(server: Server): 'inactive' | 'busy' | 'ready' | 'error' {
		if (server.dirId && this.isControlPending(server.dirId, server.id)) return 'busy';
		if (server.state?.type === 'failed' || server.state?.type === 'crashLoop' || server.issue?.severity === 'error') return 'error';
		if (server.state?.type === 'ready') return 'ready';
		if (server.state?.type === 'starting' || server.state?.type === 'backingOff'
			|| [...this.progress.values()].some(task => task.server === server)) return 'busy';
		return 'inactive';
	}

	private progressDescription(server: Server): string {
		return [...this.progress.values()].filter(task => task.server === server).map(task => progressMessage(task, 1)).join('\n');
	}

	private isControlPending(dirId: string, serverId?: string): boolean {
		return [...this.pendingControls.values()].some(request => request.dirId === dirId
			&& (!request.serverId || !serverId || request.serverId === serverId));
	}

	private folderServers(dirId: string): Server[] {
		const ids = new Set(this.catalog.get(dirId) ?? []);
		// A successful discovery read is authoritative for enablement and removed providers.
		// Retained Output channels remain readable after a server leaves this catalog.
		if (!this.catalog.has(dirId)) for (const server of this.servers.values()) if (server.dirId === dirId) ids.add(server.id);
		return [...ids].sort((a, b) => a.localeCompare(b)).map(id => this.server(id, dirId));
	}

	private async controlAll(action: LanguageServerControl['action']): Promise<void> {
		await Promise.all(this.workspace.getWorkspace().folders.map(folder => this.control({ action, dirId: folder.id })));
	}

	private async control(request: LanguageServerControl): Promise<void> {
		if (this.isDisposed) {
			return;
		}
		if (request.dirId && this.isControlPending(request.dirId, request.serverId)) {
			return;
		}
		const identity = key({ id: request.serverId ?? '', dirId: request.dirId });
		this.pendingControls.set(identity, request);
		this.updateStatus();
		try {
			await this.languageServers.control(request);
		} catch (error) {
			if (this.isDisposed) {
				return;
			}
			const server = request.serverId ? this.server(request.serverId, request.dirId) : { id: localize('languageServer.all', 'All language servers'), dirId: request.dirId, revision: 0 };
			const text = String(error);
			this.ensureChannel(server).appendLine({ severity: 'error', category: 'control', text });
			this.notifyFailure(server, localize('languageServer.controlFailed', 'Could not {0} {1}.', request.action === 'restart' ? localize('languageServer.restartVerb', 'restart') : localize('languageServer.stopVerb', 'stop'), this.serverLabel(server)), text, request);
		} finally {
			this.pendingControls.delete(identity);
			if (!this.isDisposed) {
				this.updateStatus();
			}
		}
	}

	private action(id: string, label: string, run: () => unknown): IAction {
		return { id: `ash.languageServers.${id}`, label, tooltip: label, enabled: true, run };
	}

	private acceptMessage(message: LanguageServerMessageNotification): void {
		const text = message.message.trim();
		if (!text) return;
		const server = this.server(message.server, message.dirId);
		this.ensureChannel(server).appendLine({ severity: message.severity, category: message.source, text });
		if (message.severity === 'warning' || message.severity === 'error') {
			server.issue = { message: summary(text), severity: message.severity };
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
			server.issue = { message: summary(update.state.message), severity: 'error' };
			this.notifyFailure(server, localize('languageServer.failedNotification', '{0} needs attention. {1}', this.serverLabel(server), server.issue.message), update.state.message);
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
		this.widget?.update(this.widgetFolders());
		if (!this.workspace.getWorkspace().folders.length) { this.statusEntry.clear(); return; }
		const active = this.workspace.getWorkspace().folders.flatMap(folder => this.folderServers(folder.id));
		const issues = active.filter(server => server.issue || server.state?.type === 'failed' || server.state?.type === 'crashLoop').length;
		const starting = active.some(server => server.state?.type === 'starting' || server.state?.type === 'backingOff');
		const text = localize('languageServer.services', 'Language Services');
		const hint = this.accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.LanguageServers);
		const entry = {
			text: '',
			ariaHasPopup: 'menu' as const,
			ariaExpanded: !!this.widget,
			icon: issues ? Lxicon.warning : starting ? Lxicon.sync : Lxicon.languageServer,
			showProgress: starting && !issues,
			ariaLabel: `${text}${hint ? `. ${hint}` : ''}`,
			tooltip: this.widget ? undefined : issues ? localize('languageServer.issues', 'Language Services: {0} servers need attention', issues) : text,
			run: () => this.open(),
		};
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
		const folders = this.workspace.getWorkspace().folders;
		if (!server.dirId || folders.length === 1 && folders[0].id === server.dirId) return server.id;
		return `${server.id} — ${folders.find(folder => folder.id === server.dirId)?.name || server.dirId}`;
	}

	private stateLabel(server: Server): string {
		const state = server.state;
		return !state ? localize('languageServer.idle', 'Not started') : state.type === 'ready' ? localize('languageServer.running', 'Running') : state.type === 'idle' ? localize({ bundle: 'ash.settings', key: 'lsp.idle.state' }, 'Released while idle') : state.type === 'stopped' ? localize('languageServer.stopped', 'Stopped') : state.type === 'starting' ? localize('languageServer.starting', 'Starting…') : state.type === 'backingOff' ? localize('languageServer.restarting', 'Restarting…') : localize('languageServer.failed', 'Failed');
	}

	private issueDescription(server: Server): string {
		const state = server.state;
		const issue = server.issue?.message ?? (state?.type === 'failed' || state?.type === 'crashLoop' ? state.message : undefined);
		return issue ? summary(issue, 90) : '';
	}

	private description(server: Server): string {
		const label = this.stateLabel(server);
		const issue = this.issueDescription(server);
		return issue ? localize('languageServer.stateIssue', '{0}: {1}', label, issue) : label;
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
		case 'idle': return { severity: 'log', text: localize({ bundle: 'ash.settings', key: 'lsp.idle.state' }, 'Released while idle') };
		case 'backingOff': return { severity: 'warning', text: localize('languageServer.logRetry', 'Language server stopped unexpectedly; restart attempt {0} begins in {1}ms.', state.attempt, state.retryAfterMillis) };
		case 'crashLoop': return { severity: 'error', text: localize('languageServer.logCrashLoop', 'Language server entered a crash loop after {0} restart attempts: {1}', state.restartAttempts, state.message) };
		case 'failed': return { severity: 'error', text: localize('languageServer.logFailed', 'Language server failed: {0}', state.message) };
		case 'stopped': return { severity: 'log', text: localize('languageServer.logStopped', 'Language server stopped.') };
	}
}
