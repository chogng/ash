import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ISessionGroupsService } from '../../../services/sessions/browser/sessionGroupsService.js';
import './media/sessionsList.css';
import { LoadingSkeleton } from '../../ui/loadingSkeleton.js';
import { addDisposableListener, getWindow, h } from '../../../../base/browser/dom.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { AbstractDisposable, DisposableMap, toDisposable } from '../../../../base/common/lifecycle.js';
import { DomWidget } from '../../../../platform/domWidget/browser/domWidget.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { IGitHubService } from '../../../contrib/github/browser/githubService.js';
import { getPullRequestLabel } from '../../../contrib/github/common/types.js';
import { getHighestPriorityPullRequestIcon } from '../../../../workbench/common/chatPullRequest.js';
import { sessionManagementLabel } from '../../sessionManagementLabels.js';
import type { SessionManagementInfo } from '../../../services/sessions/common/session.js';
import type { ThemeIcon } from '../../../../base/common/themables.js';
import { colorCssVariable } from '../../../../platform/theme/common/colorUtils.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { autorun } from '../../../../base/common/observable.js';
import { IMenuService, type MenuActionGroup } from '../../../../platform/actions/common/actions.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IProjectService, type Project } from '../../../../platform/projects/common/projectService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { posix } from '../../../../base/common/path.js';
import type { ContextMenuAnchor } from '../../../../base/browser/contextmenu.js';
import { Menus } from '../../menus.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { createSessionItemActions } from '../../agentSessionsModel.js';
import type { SessionsViewSelection } from '../../../services/sessions/browser/sessionsService.js';
import { readNewChatDraftState } from '../../../contrib/chat/common/newChatDraftState.js';

/** Session picker owned by the dedicated Sessions Workbench sidebar. */
export class SessionsList extends DomWidget {
	readonly domNode: HTMLElement;
	private readonly heading: HTMLHeadingElement;
	private readonly list: HTMLDivElement;
	private readonly items = this._register(new DisposableMap<string, SessionListItem>());
	private readonly sections = this._register(new DisposableMap<string, SessionListSection>());
	private projects: readonly Project[] = [];
	private projectLoad = 0;
	private projectsFailed = false;
	private projectsLoading = false;
	private readonly loading: LoadingSkeleton;
	private readonly projectLoading: LoadingSkeleton;
	private readonly empty: HTMLParagraphElement;
	private readonly projectError: HTMLButtonElement;
	private readonly navigation: HTMLElement;
	private readonly navigationButtons = this._register(new DisposableMap<string, Button>());
	private readonly navigationActions = new Map<string, MenuActionGroup[1][number]>();

	public get element(): HTMLElement { return this.domNode; }

	constructor(container: HTMLElement, title: string, private readonly mode: 'chat' | 'code',
		@ISessionsManagementService private readonly sessionService: ISessionsManagementService,
		@ISessionsService private readonly viewService: ISessionsService,
		@IGitHubService private readonly github: IGitHubService,
		@ISessionGroupsService private readonly groups: ISessionGroupsService,
		@IStorageService private readonly storage: IStorageService,
		@IProjectService private readonly projectService: IProjectService,
		@ICommandService private readonly commands: ICommandService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@ICustomViewService private readonly customViews: ICustomViewService,
		@IMenuService menus: IMenuService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		const ownerDocument = container.ownerDocument;
		this.domNode = h(ownerDocument, 'section');
		this.domNode.className = 'ash-sessions-list';
		this.domNode.tabIndex = -1;
		this.domNode.dataset.mode = mode;
		this.navigation = h(ownerDocument, 'nav', { className: 'ash-sessions-list-navigation', attributes: { 'aria-label': localize('sessions.list.navigation', 'Sessions navigation') } });
		this.heading = h(ownerDocument, 'h2');
		this.heading.textContent = title;
		this.list = h(ownerDocument, 'div');
		this.list.className = 'ash-sessions-list-items';
		this.loading = this._register(new LoadingSkeleton(this.list, localize('sessions.list.loading', 'Loading sessions…')));
		this.projectLoading = this._register(new LoadingSkeleton(this.list, localize('projects.loading', 'Loading projects…'), 'list', 3));
		this.empty = h(ownerDocument, 'p');
		this.empty.className = 'ash-sessions-empty';
		this.projectError = h(ownerDocument, 'button', { className: 'ash-sessions-list-item' });
		this.projectError.type = 'button';
		this.projectError.textContent = localize('sessions.list.projectsRetry', 'Could not load projects. Retry');
		this._register(addDisposableListener(this.projectError, 'click', () => { void this.loadProjects(); }));
		this.domNode.append(this.navigation, this.heading, this.list);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(addDisposableListener(this.list, 'keydown', event => {
			if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
			const buttons = [...this.list.querySelectorAll<HTMLButtonElement>('button')].filter(button => !button.closest('[hidden]'));
			const index = buttons.indexOf(ownerDocument.activeElement as HTMLButtonElement);
			if (index < 0) return;
			event.preventDefault();
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
			buttons[next]?.focus();
		}));
		this._register(sessionService.onDidChange(() => this.render()));
		this._register(storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key.startsWith('sessions.list.')
				|| event.scope === StorageScope.WORKSPACE && event.key.startsWith('sessions.inputDraft:untitled:')) this.render();
		}));
		this._register(projectService.onDidChange(() => { void this.loadProjects(); }));
		this._register(viewService.onDidChange(() => this.render()));
		this._register(github.onDidChange(() => this.render()));
		this._register(groups.onDidChange(() => this.render()));
		const menu = this._register(menus.createMenu(Menus.SidebarSessionsHeader));
		const updateNavigation = (): void => {
			const actions = menu.getActions().filter(([group]) => group === 'navigation').flatMap(([, actions]) => actions);
			this.navigationActions.clear();
			for (const action of actions) {
				this.navigationActions.set(action.id, action);
				let button = this.navigationButtons.get(action.id);
				if (!button) {
					button = this.navigationButtons.set(action.id, new Button(this.navigation, {
						...defaultButtonStyles,
						label: action.label,
						presentation: 'quiet',
						onClick: () => { void Promise.resolve().then(() => this.navigationActions.get(action.id)?.run()).catch(error => notifications.error(String(error))); },
					}));
				}
				button.label = action.label;
				button.enabled = action.enabled;
				button.domNode.setAttribute('aria-current', action.checked ? 'page' : 'false');
			}
			for (const id of this.navigationButtons.keys()) if (!this.navigationActions.has(id)) this.navigationButtons.deleteAndDispose(id);
			this.navigation.hidden = actions.length === 0;
		};
		this._register(menu.onDidChange(updateNavigation));
		updateNavigation();
		this._register(autorun(reader => { customViews.activeCustomView.read(reader); this.render(); }));
		this.render();
		void this.loadProjects();
	}

	focus(): void {
		const activeNavigation = this.navigation.querySelector<HTMLButtonElement>('[aria-current="page"]');
		if (activeNavigation) { activeNavigation.focus(); return; }
		const firstItem = this.list.querySelector<HTMLButtonElement>('button');
		(firstItem ?? this.domNode).focus();
	}

	public getViewState(): { readonly top: number; readonly focus: string | undefined; } {
		const active = this.domNode.ownerDocument.activeElement;
		const item = [...this.items].find(([, item]) => item.domNode.contains(active));
		const section = [...this.sections].find(([, section]) => section.button === active);
		const navigation = [...this.navigationButtons].find(([, button]) => button.domNode === active);
		return { top: this.list.scrollTop, focus: navigation ? `navigation:${navigation[0]}` : section ? `section:${section[0]}` : item?.[0] };
	}

	public restoreViewState(state: ReturnType<SessionsList['getViewState']>): void {
		this.render();
		this.list.scrollTop = state.top;
		if (state.focus?.startsWith('navigation:')) this.navigationButtons.get(state.focus.slice('navigation:'.length))?.focus();
		else if (state.focus?.startsWith('section:')) this.sections.get(state.focus.slice('section:'.length))?.button.focus({ preventScroll: true });
		else if (state.focus) {
			const item = this.items.get(state.focus)?.domNode;
			const collapsed = item?.closest<HTMLElement>('[hidden]');
			(collapsed?.parentElement?.querySelector<HTMLButtonElement>('h3 button') ?? item?.querySelector<HTMLButtonElement>('.ash-sessions-list-item'))?.focus({ preventScroll: true });
		}
	}

	private async loadProjects(): Promise<void> {
		const generation = ++this.projectLoad;
		this.projectsLoading = true;
		this.render();
		try {
			const summaries = await this.projectService.list();
			const projects = await Promise.all(summaries.filter(project => !project.archived).map(project => this.projectService.read(project.id)));
			if (this.isDisposed || generation !== this.projectLoad) return;
			this.projects = projects.filter(project => !project.archived);
			this.projectsFailed = false;
		} catch {
			if (this.isDisposed || generation !== this.projectLoad) return;
			this.projectsFailed = true;
		}
		this.projectsLoading = false;
		this.render();
	}

	private pinKey(id: string): string { return `sessions.list.pinned.${id}`; }

	private showItemMenu(selection: SessionsViewSelection, item: SessionListItem, anchor: ContextMenuAnchor): void {

		item.setMenuVisible(true);
		this.contextMenus.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => createSessionItemActions(selection, this.commands, this.storage, this.notifications,
				() => this.commands.executeCommand('sessions.openInNewWindow', selection),
				sessionId => this.restoreViewState({ top: this.list.scrollTop, focus: `session:${sessionId}` })),
			onHide: () => { item.setMenuVisible(false); },
		});
	}

	private render(): void {
		const ownerDocument = this.domNode.ownerDocument;
		const focused = this.list.contains(ownerDocument.activeElement) ? ownerDocument.activeElement as HTMLElement : undefined;
		const present = new Set<string>();
		const activeSections = new Set<string>();
		const pinned: HTMLElement[] = [];
		const recent: HTMLElement[] = [];
		const remaining = new Map<string, HTMLElement>();
		const activeSelection = this.customViews.activeCustomView.get() ? undefined : this.viewService.activeSelection;
		const itemFor = (key: string): SessionListItem => {
			present.add(key);
			const item = this.items.get(key) ?? this.items.set(key, new SessionListItem(ownerDocument, this.mode === 'code' ? Lxicon.chat4 : undefined));
			item.domNode.dataset.item = key;
			return item;
		};
		const sectionFor = (key: string, title: string, children: readonly HTMLElement[], subgroup = false): HTMLElement => {
			activeSections.add(key);
			const storageKey = `sessions.list.${this.mode}.collapsed.${key}`;
			const section = this.sections.get(key) ?? this.sections.set(key, new SessionListSection(ownerDocument, key, subgroup, collapsed => {
				this.storage.store(storageKey, collapsed, StorageScope.PROFILE, StorageTarget.MACHINE);
			}));
			section.update(title, children, this.storage.getBoolean(storageKey, StorageScope.PROFILE, false));
			return section.domNode;
		};
		// Content belongs to the composer store; an open blank welcome page is not a recent conversation.
		// Include parked drafts too, so switching conversations does not hide their only sidebar entry.
		for (const session of this.sessionService.untitledSessions) {
			let draft: ReturnType<typeof readNewChatDraftState>;
			try { draft = readNewChatDraftState(this.storage, `untitled:${session.untitledSessionId}`); }
			catch { continue; } // The composer reports unreadable drafts; one must not break the whole list.
			if (!draft || (!draft.text.trim() && draft.contexts.length === 0)) continue;
			const selected = activeSelection?.kind === 'untitled' && activeSelection.session.untitledSessionId === session.untitledSessionId;
			const item = itemFor(`untitled:${session.untitledSessionId}`);
			item.update(localize('sessions.list.draft', '{0} (draft)', session.title || localize('chat.sessions.new', 'New Session')), selected, () => this.viewService.openUntitledSession(session.untitledSessionId));
			item.setContextMenu(anchor => this.showItemMenu({ kind: 'untitled', session }, item, anchor));
			recent.push(item.domNode);
		}
		for (const session of this.sessionService.sessions) {
			const current = activeSelection?.kind === 'session' && activeSelection.active.session.sessionId === session.sessionId ? activeSelection.active : undefined;
			const thread = current
				? session.chats.find(candidate => candidate.threadId === current.threadId && candidate.status === 'active')
				: session.chats.find(candidate => candidate.status === 'active' && candidate.origin.type === 'root') ?? session.chats.find(candidate => candidate.status === 'active');
			if (!thread || session.status !== 'active') continue;
			const item = itemFor(`session:${session.sessionId}`);
			item.update(session.title || localize('sessions.list.untitled', 'Untitled Session'), current !== undefined, () => this.viewService.openSession(session.sessionId, thread.threadId), session.management);
			item.setContextMenu(anchor => this.showItemMenu({ kind: 'session', active: { session, threadId: thread.threadId } }, item, anchor));
			const requests = this.github.getSessionPullRequests(session.sessionId);
			item.updatePullRequests(getHighestPriorityPullRequestIcon(requests.map(request => request.icon)), requests.map(getPullRequestLabel).join('\n'));
			if (this.storage.getBoolean(this.pinKey(session.sessionId), StorageScope.PROFILE, false)) pinned.push(item.domNode);
			else remaining.set(session.sessionId, item.domNode);
		}
		const projects: HTMLElement[] = [];
		const chatGroups: HTMLElement[] = [];
		for (const project of this.projects) {
			if (this.mode === 'chat') {
				const item = itemFor(`project:${project.id}`);
				item.update(project.name, false, () => { void this.commands.executeCommand('sessions.open.projects', project.id).catch(error => this.notifications.error(String(error))); });
				projects.push(item.domNode);
			} else {
				const members: HTMLElement[] = [];
				for (const id of project.sessionIds) {
					const item = remaining.get(id);
					if (item) { members.push(item); remaining.delete(id); }
				}
				projects.push(sectionFor(`project:${project.id}`, project.name, members, true));
			}
		}
		if (this.projectsFailed) projects.push(this.projectError);
		this.projectLoading.setVisible(this.projectsLoading && !this.projects.length && !this.projectsFailed);
		if (!this.projectLoading.element.hidden) projects.push(this.projectLoading.element);
		for (const group of this.groups.groups) {
			const members: HTMLElement[] = [];
			for (const id of group.sessionIds) {
				const item = remaining.get(id);
				if (item) { members.push(item); remaining.delete(id); }
			}
			(this.mode === 'code' ? recent : chatGroups).push(sectionFor(`group:${group.sectionId}`, group.name, members, this.mode === 'code'));
		}
		if (this.mode === 'code') {
			const workspaces = new Map<string, { title: string; items: HTMLElement[]; }>();
			for (const session of this.sessionService.sessions) {
				const item = remaining.get(session.sessionId);
				if (!item) continue;
				const workspace = session.workspace;
				const key = workspace ? JSON.stringify([workspace.authorityId, workspace.root]) : `provider:${session.providerId ?? ''}`;
				let group = workspaces.get(key);
				if (!group) {
					const title = workspace ? posix.basename(workspace.root.replace(/\\/g, '/')) || workspace.root : session.providerLabel ?? localize('sessions.list.other', 'Other chats');
					group = { title, items: [] }; workspaces.set(key, group);
				}
				group.items.push(item);
			}
			for (const [key, group] of workspaces) recent.push(sectionFor(`workspace:${key}`, group.title, group.items, true));
		} else recent.push(...remaining.values());
		const showEmpty = recent.length === 0 && pinned.length === 0 && chatGroups.length === 0;
		const loading = this.sessionService.state === 'loading';
		this.loading.setVisible(loading && showEmpty);
		this.list.setAttribute('aria-busy', String(loading || this.projectsLoading));
		if (showEmpty) {
			this.empty.textContent = this.sessionService.state === 'loading' ? localize('sessions.list.loading', 'Loading sessions…') : this.sessionService.error ?? localize('sessions.list.empty', 'Create a session to begin.');
		}
		const ordered: HTMLElement[] = [];
		if (pinned.length) ordered.push(sectionFor('pinned', localize('sessions.list.pinned', 'Pinned'), pinned));
		if (projects.length) ordered.push(sectionFor('projects', localize('projects.title', 'Projects'), projects));
		ordered.push(...chatGroups);
		if (recent.length) ordered.push(sectionFor('recent', this.mode === 'chat' ? localize('sessions.list.chats', 'Chats') : localize('sessions.list.recents', 'Recents'), recent));
		if (!this.loading.element.hidden) ordered.push(this.loading.element);
		else if (showEmpty) ordered.push(this.empty);
		for (const key of this.items.keys()) if (!present.has(key)) this.items.deleteAndDispose(key);
		for (const key of this.sections.keys()) if (!activeSections.has(key)) this.sections.deleteAndDispose(key);
		reconcileChildren(this.list, ordered);
		if (focused?.isConnected && !focused.closest('[hidden]') && ownerDocument.activeElement !== focused) focused.focus({ preventScroll: true });
	}
}

/** Retain rows and headings during refreshes so keyboard focus and scroll do not jump. */
function reconcileChildren(parent: HTMLElement, children: readonly HTMLElement[]): void {
	for (let index = 0; index < children.length; index++) {
		if (parent.childNodes[index] !== children[index]) parent.insertBefore(children[index], parent.childNodes[index] ?? null);
	}
	while (parent.childNodes.length > children.length) parent.lastChild!.remove();
}

class SessionListSection extends AbstractDisposable {
	readonly domNode: HTMLElement;
	readonly button: HTMLButtonElement;
	private readonly body: HTMLElement;
	private readonly label: HTMLElement;
	private readonly icon: HTMLElement;
	private collapsed = false;
	private readonly listeners: { dispose(): void; }[];

	constructor(document: Document, key: string, private readonly subgroup: boolean, toggle: (collapsed: boolean) => void) {
		super();
		this.domNode = h(document, 'section', { className: subgroup ? 'ash-sessions-list-subgroup' : 'ash-sessions-list-section' });
		this.domNode.dataset.section = key;
		const heading = h(document, 'h3');
		this.button = h(document, 'button', { className: 'ash-sessions-list-section-toggle' });
		this.button.type = 'button';
		this.icon = h(document, 'span', { className: 'ash-sessions-list-section-icon' });
		this.label = h(document, 'span', { className: 'ash-sessions-list-section-label' });
		this.button.append(...(subgroup ? [this.icon, this.label] : [this.label, this.icon]));
		heading.append(this.button);
		this.body = h(document, 'div', { className: 'ash-sessions-list-section-body' });
		this.body.id = `ash-sessions-list-${generateUuid()}`;
		this.button.setAttribute('aria-controls', this.body.id);
		this.domNode.append(heading, this.body);
		this.listeners = [
			addDisposableListener(this.button, 'click', () => toggle(!this.collapsed)),
			addDisposableListener(this.button, 'keydown', event => {
				if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
				event.preventDefault();
				toggle(event.key === 'ArrowLeft');
			}),
		];
	}

	update(title: string, children: readonly HTMLElement[], collapsed: boolean): void {
		this.label.textContent = title;
		this.button.title = title;
		this.collapsed = collapsed;
		this.button.setAttribute('aria-expanded', String(!collapsed));
		const icon = this.subgroup ? collapsed ? Lxicon.folder : Lxicon.folderOpened : collapsed ? Lxicon.chevronRight : Lxicon.chevronDown;
		if (this.icon.firstElementChild?.getAttribute('data-ash-icon-id') !== icon.id) {
			this.icon.replaceChildren(); appendIcon(icon, this.icon);
		}
		if (collapsed && this.body.contains(this.domNode.ownerDocument.activeElement)) this.button.focus({ preventScroll: true });
		this.body.hidden = collapsed;
		reconcileChildren(this.body, children);
	}

	protected override disposeCore(): void {
		for (const listener of this.listeners) listener.dispose();
		this.domNode.remove();
	}
}

class SessionListItem extends AbstractDisposable {
	readonly domNode: HTMLElement;
	private readonly button: HTMLButtonElement;
	private readonly actions: ActionBar;
	private readonly label: HTMLSpanElement;
	private readonly pullRequest: HTMLSpanElement;
	private readonly management: HTMLSpanElement;
	private managementDescription: string | undefined;
	private pullRequestDescription = '';
	private open: () => void = () => { };
	private readonly clickListener;
	private readonly contextListeners;
	private contextMenu: ((anchor: ContextMenuAnchor) => void) | undefined;

	constructor(ownerDocument: Document, icon?: ThemeIcon) {
		super();
		this.domNode = h(ownerDocument, 'div', { className: 'ash-sessions-list-row' });
		this.button = h(ownerDocument, 'button', { className: 'ash-sessions-list-item' });
		this.button.type = 'button';
		this.domNode.append(this.button);
		this.actions = new ActionBar(this.domNode, {
			ariaLabel: localize('sessions.list.actions', 'Chat actions'),
			actions: [{
				id: 'sessions.list.more', label: localize('sessions.list.more', 'More actions'),
				tooltip: localize('sessions.list.more', 'More actions'), icon: Lxicon.ellipsis, enabled: true,
				run: () => this.contextMenu?.(this.actions.element),
			}],
		});
		this.actions.element.classList.add('ash-sessions-list-actions');
		this.actions.element.hidden = true;
		this.actions.element.querySelector('button')?.setAttribute('aria-haspopup', 'menu');
		this.label = h(ownerDocument, 'span');
		this.label.className = 'ash-sessions-list-label';
		this.management = h(ownerDocument, 'span');
		this.management.className = 'ash-sessions-list-management';
		this.management.hidden = true;
		this.management.setAttribute('aria-live', 'polite');
		const content = h(ownerDocument, 'span');
		content.className = 'ash-sessions-list-content';
		content.append(this.label, this.management);
		this.pullRequest = h(ownerDocument, 'span');
		this.pullRequest.className = 'ash-sessions-list-pr';
		this.pullRequest.setAttribute('aria-hidden', 'true');
		this.pullRequest.hidden = true;
		if (icon) appendIcon(icon, this.button);
		// Keep attention metadata clear of the trailing hover actions.
		this.button.append(this.pullRequest, content);
		this.clickListener = addDisposableListener(this.button, 'click', () => this.open());
		const showMenu = (event: MouseEvent | KeyboardEvent): void => {
			if (!this.contextMenu) return;
			event.preventDefault(); event.stopPropagation();
			this.contextMenu(event.type === 'contextmenu' ? { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY, targetWindow: getWindow(this.domNode) } : this.button);
		};
		this.contextListeners = [
			addDisposableListener(this.domNode, 'contextmenu', showMenu),
			addDisposableListener(this.domNode, 'keydown', event => {
				if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) showMenu(event);
			}),
		];
	}

	setContextMenu(menu: (anchor: ContextMenuAnchor) => void): void {
		this.contextMenu = menu;
		this.actions.element.hidden = false;
	}

	setMenuVisible(visible: boolean): void {
		this.domNode.classList.toggle('menu-visible', visible);
		this.actions.element.querySelector('button')?.setAttribute('aria-expanded', String(visible));
	}

	update(title: string, selected: boolean, open: () => void, management?: SessionManagementInfo): void {
		if (this.label.textContent !== title) this.label.textContent = title;
		const state = sessionManagementLabel(management);
		if (this.management.textContent !== (state ?? '')) this.management.textContent = state ?? '';
		this.management.hidden = state === undefined;
		this.button.classList.toggle('has-management', state !== undefined);
		this.managementDescription = [state, management?.activity?.text, management?.summary].filter(Boolean).join('. ');
		this.updateDescription();
		this.domNode.classList.toggle('selected', selected);
		this.button.setAttribute('aria-current', selected ? 'page' : 'false');
		this.open = open;
	}

	updatePullRequests(icon: ThemeIcon | undefined, description: string): void {
		this.pullRequest.replaceChildren();
		this.pullRequest.hidden = icon === undefined;
		if (icon) {
			appendIcon(icon, this.pullRequest);
			this.pullRequest.style.color = `var(${colorCssVariable(icon.color!.id)})`;
		}
		this.pullRequestDescription = description;
		this.updateDescription();
	}

	private updateDescription(): void {
		const parts = [this.label.textContent, this.managementDescription, this.pullRequestDescription].filter(Boolean);
		this.button.title = parts.join('\n');
		this.button.setAttribute('aria-label', parts.join('. '));
	}

	protected override disposeCore(): void {
		this.clickListener.dispose();
		this.actions.dispose();
		for (const listener of this.contextListeners) listener.dispose();
		this.domNode.remove();
	}
}
