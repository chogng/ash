import { h } from '../../../../base/browser/dom.js';
import { getHoverDelegate, type IManagedHover } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { Menu, unthemedMenuStyles, SubmenuMenuActionViewItem, type MenuActionViewItemOptions } from '../../../../base/browser/ui/menu/menu.js';
import { Separator, SubmenuAction, type IAction } from '../../../../base/common/actions.js';
import type { Icon } from '../../../../base/common/icon.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { createUuid } from '../../../../base/common/uuid.js';
import type { LanguageServerControl } from '../../../../platform/language/common/languageServerService.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { localize } from '../../../../nls.js';
import './media/languageServerStatusWidget.css';

interface ServerStatus {
	readonly id: string;
	readonly status: string;
	readonly detail: string;
	readonly progress: string;
	readonly activity: 'inactive' | 'busy' | 'ready' | 'error';
	readonly canRestart: boolean;
	readonly canStop: boolean;
}

/** Read-only presentation of the owning service's workspace and server state. */
export interface LanguageServerStatusFolder {
	readonly id: string;
	readonly name: string;
	readonly path: string;
	readonly unavailable: boolean;
	readonly loading: boolean;
	readonly busy: boolean;
	readonly servers: readonly ServerStatus[];
	readonly canRestart: boolean;
	readonly canStop: boolean;
}

interface WidgetActions {
	control(request: LanguageServerControl): Promise<void>;
	showLogs(dirId: string, serverId: string): void;
}

interface StatusMenuAction extends IAction {
	enabled: boolean;
}

function menuAction(id: string, label: string, run: () => unknown): StatusMenuAction {
	return { id, label, tooltip: '', enabled: true, run };
}

function statusIcon(activity: ServerStatus['activity']): Icon {
	return { busy: Lxicon.progress, inactive: Lxicon.circle, ready: Lxicon.circleFilled, error: Lxicon.circleFilled }[activity];
}

class ServerMenuAction extends SubmenuAction {
	readonly restart: StatusMenuAction;
	readonly stop: StatusMenuAction;

	constructor(readonly folderId: string, public status: ServerStatus, actions: WidgetActions) {
		const logs = menuAction('logs', localize('languageServer.viewLogs', 'View Logs'), () => actions.showLogs(folderId, status.id));
		const restart = menuAction('restart', localize('languageServer.restart', 'Restart Server'),
			() => actions.control({ action: 'restart', dirId: folderId, serverId: status.id }));
		const stop = menuAction('stop', localize('languageServer.stop', 'Stop Server'),
			() => actions.control({ action: 'stop', dirId: folderId, serverId: status.id }));
		super(`server:${folderId}:${status.id}`, status.id, [logs, restart, stop], statusIcon(status.activity));
		this.restart = restart;
		this.stop = stop;
	}
}

class WorkspaceMenuAction extends SubmenuAction {
	readonly restart: StatusMenuAction;
	readonly stop: StatusMenuAction;

	constructor(readonly folder: LanguageServerStatusFolder, showPath: boolean, actions: WidgetActions) {
		const restart = menuAction('restartWorkspace', localize('languageServer.restartWorkspace', 'Restart Servers in {0}', folder.name),
			() => actions.control({ action: 'restart', dirId: folder.id }));
		const stop = menuAction('stopWorkspace', localize('languageServer.stopWorkspace', 'Stop Servers in {0}', folder.name),
			() => actions.control({ action: 'stop', dirId: folder.id }));
		super(`workspace:${folder.id}`, showPath ? `${folder.name} — ${folder.path}` : folder.name, [restart, stop]);
		this.restart = restart;
		this.stop = stop;
	}
}

/** Adds lifecycle content to the shared submenu item; Menu owns all navigation and dismissal. */
class ServerMenuActionViewItem extends SubmenuMenuActionViewItem {
	private state: HTMLElement | undefined;
	private detail: HTMLElement | undefined;
	private progress: HTMLElement | undefined;
	private statusHover: IManagedHover | undefined;
	private activity: ServerStatus['activity'] | undefined;

	constructor(private readonly server: ServerMenuAction, options: MenuActionViewItemOptions) {
		super(server, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		const document = container.ownerDocument;
		container.classList.add('ash-language-server-row');
		container.dataset.folderId = this.server.folderId;
		container.dataset.serverId = this.server.status.id;
		this.button.domNode.classList.add('ash-language-server-summary');
		this.button.domNode.setAttribute('aria-label', localize('languageServer.serverActions', 'Actions for {0}', this.server.status.id));
		this.state = h(document, 'span', { className: 'ash-language-server-state' });
		this.state.id = createUuid();
		this.state.setAttribute('role', 'status');
		this.state.setAttribute('aria-atomic', 'true');
		this.detail = h(document, 'div', { className: 'ash-language-server-detail' });
		this.detail.id = createUuid();
		this.detail.setAttribute('aria-live', 'polite');
		this.progress = h(document, 'div', { className: 'ash-language-server-progress-text' });
		this.progress.id = createUuid();
		container.append(this.state, this.detail, this.progress);
		this.button.domNode.setAttribute('aria-describedby', `${this.state.id} ${this.detail.id} ${this.progress.id}`);
		this.statusHover = this._register(getHoverDelegate().setupHover({ target: this.button.domNode, content: '' }));
		this.update();
	}

	override update(): boolean {
		const status = this.server.status;
		if (this.activity !== status.activity) {
			this.button.icon = statusIcon(status.activity);
			this.button.domNode.classList.toggle('is-busy', status.activity === 'busy');
			this.button.domNode.classList.toggle('is-ready', status.activity === 'ready');
			this.button.domNode.classList.toggle('is-error', status.activity === 'error');
			this.activity = status.activity;
		}
		if (this.state && this.state.textContent !== status.status) {
			this.state.textContent = status.status;
			this.statusHover?.update(localize('languageServer.accessibleState', '{0}: {1}', status.id, status.status));
		}
		if (this.detail) {
			if (this.detail.textContent !== status.detail) {
				this.detail.textContent = status.detail;
			}
			this.detail.hidden = !status.detail;
		}
		if (this.progress) {
			if (this.progress.textContent !== status.progress) {
				this.progress.textContent = status.progress;
			}
			this.progress.hidden = !status.progress;
		}
		return super.update();
	}
}

class WorkspaceMenuActionViewItem extends SubmenuMenuActionViewItem {
	constructor(private readonly workspace: WorkspaceMenuAction, options: MenuActionViewItemOptions) {
		super(workspace, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.dataset.folderId = this.workspace.folder.id;
		container.classList.add('ash-language-server-workspace');
		this.button.domNode.setAttribute('aria-label', localize('languageServer.workspaceActions', 'Workspace actions for {0}', this.workspace.folder.name));
		this.button.domNode.setAttribute('aria-description', this.workspace.folder.path);
		this._register(getHoverDelegate().setupHover({ target: this.button.domNode, content: this.workspace.folder.path }));
	}
}

/** Projects service snapshots into one shared Menu; ContextView owns its floating shell. */
export class LanguageServerStatusWidget extends Disposable {
	readonly domNode: HTMLElement;
	private readonly menu = this._register(new MutableDisposable<Menu>());
	private readonly servers = new Map<string, ServerMenuAction>();
	private readonly workspaces = new Map<string, WorkspaceMenuAction>();
	private readonly items = new Map<string, SubmenuMenuActionViewItem>();
	private readonly restartAll: StatusMenuAction;
	private readonly stopAll: StatusMenuAction;
	private structure: string | undefined;
	private accessibilityHint: string | undefined;

	constructor(document: Document, private readonly actions: WidgetActions) {
		super();
		this.domNode = h(document, 'div', { className: 'ash-language-server-status-widget' });
		this.restartAll = menuAction('restartAll', localize('languageServer.restartAll', 'Restart All Servers'), () => actions.control({ action: 'restart' }));
		this.stopAll = menuAction('stopAll', localize('languageServer.stopAll', 'Stop All Servers'), () => actions.control({ action: 'stop' }));
		this._register(toDisposable(() => this.domNode.remove()));
	}

	setAccessibilityHint(hint: string): void {
		this.accessibilityHint = hint;
		this.menu.value?.getContainer().setAttribute('aria-description', hint);
	}

	focus(): void {
		this.menu.value?.focus(false);
	}

	update(folders: readonly LanguageServerStatusFolder[]): void {
		// Lifecycle-only updates retain the menu, its open submenus, and focused controls.
		const structure = JSON.stringify(folders.map(folder => [
			folder.id, folder.name, folder.path, folder.loading, folder.unavailable,
			folder.servers.map(server => server.id),
		]));
		const scrollTop = this.menu.value?.getContainer().scrollTop ?? 0;
		if (structure !== this.structure) {
			const focused = this.domNode.ownerDocument.activeElement;
			const focusedId = [...this.items].find(([, item]) => item.ownsTrigger(focused) || !!focused && item.contains(focused))?.[0];
			const restoreFocus = !!focused && this.domNode.contains(focused);
			this.menu.clear();
			this.servers.clear();
			this.workspaces.clear();
			this.items.clear();
			const actions: IAction[] = [];
			for (const folder of folders) {
				if (actions.length) {
					actions.push(new Separator());
				}
				const workspace = new WorkspaceMenuAction(folder, folders.some(other => other.id !== folder.id && other.name === folder.name), this.actions);
				this.workspaces.set(folder.id, workspace);
				actions.push(workspace);
				for (const server of folder.servers) {
					const action = new ServerMenuAction(folder.id, server, this.actions);
					this.servers.set(action.id, action);
					actions.push(action);
				}
				if (!folder.servers.length) {
					actions.push({
						id: `empty:${folder.id}`,
						label: folder.loading ? localize('languageServer.loading', 'Loading language servers…') : localize('languageServer.empty', 'No language servers'),
						tooltip: '', enabled: false, run() { },
					});
				}
				if (folder.unavailable) {
					actions.push({
						id: `unavailable:${folder.id}`,
						label: localize('languageServer.unavailable', 'Unable to load servers. Try opening Language Services again.'),
						tooltip: '', enabled: false, run() { },
					});
				}
			}
			if (folders.length > 1) {
				actions.push(new Separator(), new SubmenuAction('allServers', localize('languageServer.allActions', 'All server actions'), [this.restartAll, this.stopAll]));
			}
			if (!folders.length) {
				actions.push({
					id: 'noWorkspace', label: localize('languageServer.noWorkspace', 'Open a workspace to manage language servers.'),
					tooltip: '', enabled: false, run() { },
				});
			}
			const menu = new Menu(this.domNode, actions, {
				buttonStyles: defaultButtonStyles, contextViewContainer: this.domNode, layer: 0,
				actionViewItemProvider: (action, options) => {
					let item: SubmenuMenuActionViewItem | undefined;
					if (action instanceof ServerMenuAction) {
						item = new ServerMenuActionViewItem(action, options);
					} else if (action instanceof WorkspaceMenuAction) {
						item = new WorkspaceMenuActionViewItem(action, options);
					}
					if (item) {
						this.items.set(action.id, item);
					}
					return item;
				}
			}, unthemedMenuStyles);
			this.menu.value = menu;
			menu.getContainer().setAttribute('aria-label', localize('languageServer.services', 'Language Services'));
			if (this.accessibilityHint) {
				menu.getContainer().setAttribute('aria-description', this.accessibilityHint);
			}
			this.structure = structure;
			if (restoreFocus) {
				const item = focusedId ? this.items.get(focusedId) : undefined;
				if (item) {
					item.focus();
				} else {
					this.focus();
				}
			}
		}
		for (const folder of folders) {
			const workspace = this.workspaces.get(folder.id)!;
			workspace.restart.enabled = folder.canRestart;
			workspace.stop.enabled = folder.canStop;
			for (const status of folder.servers) {
				const server = this.servers.get(`server:${folder.id}:${status.id}`)!;
				server.status = status;
				server.restart.enabled = status.canRestart;
				server.stop.enabled = status.canStop;
			}
		}
		this.restartAll.enabled = folders.some(folder => folder.canRestart) && !folders.some(folder => folder.busy);
		this.stopAll.enabled = folders.some(folder => folder.canStop) && !folders.some(folder => folder.busy);
		this.menu.value?.update();
		if (this.menu.value) {
			this.menu.value.getContainer().scrollTop = scrollTop;
		}
	}
}
