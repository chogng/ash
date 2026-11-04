import { IContextKeyService, type IScopedContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { SessionsMenuActiveConversationContext } from '../../../../common/contextkeys.js';
import { ISessionsListModelService, type ISessionsListTreeNode } from '../../../../services/sessions/browser/sessionsListModelService.js';
import { Separator, type IAction } from '../../../../../base/common/actions.js';
import { ISessionSectionOrderService } from '../../../../services/sessions/browser/sessionSectionOrderService.js';
import * as chatInputStatePersistence from '../../../../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { ISessionGroupsService, type SessionGroup } from '../../../../services/sessions/browser/sessionGroupsService.js';
import { CHANGE_SESSION_GROUP_APPEARANCE } from './sessionGroupAppearancePicker.js';
import '../media/sessionsList.css';
import { addDisposableListener, getWindow, h } from '../../../../../base/browser/dom.js';
import { appendIcon, getRegisteredIcon } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';
import { AbstractDisposable, DisposableMap, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { SessionActionFeedback } from '../sessionActionFeedback.js';
import { getSessionsListEntries } from './sessionsListFilters.js';
import { SessionsListSearch } from './sessionsListSearch.js';
import { DomWidget } from '../../../../../platform/domWidget/browser/domWidget.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { IGitHubService } from '../../../github/browser/githubService.js';
import { getPullRequestLabel } from '../../../github/common/types.js';
import { getHighestPriorityPullRequestIcon } from '../../../../../workbench/common/chatPullRequest.js';
import { sessionManagementLabel } from '../../../../browser/sessionManagementLabels.js';
import type { SessionManagementInfo } from '../../../../services/sessions/common/session.js';
import type { ThemeIcon } from '../../../../../base/common/themables.js';
import { colorCssVariable } from '../../../../../platform/theme/common/colorUtils.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { autorun } from '../../../../../base/common/observable.js';
import { IMenuService, type MenuActionGroup } from '../../../../../platform/actions/common/actions.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ICustomViewService } from '../../../../services/customView/browser/customViewService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IProjectService, type Project } from '../../../../../platform/projects/common/projectService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import type { ContextMenuAnchor } from '../../../../../base/browser/contextmenu.js';
import { Menus } from '../../../../browser/menus.js';
import { ActionBar } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { createSessionItemActions } from '../../../../browser/agentSessionsModel.js';
import type { SessionsViewSelection } from '../../../../services/sessions/browser/sessionsService.js';
import { readNewChatDraftState } from '../../../chat/common/newChatDraftState.js';
import { createSessionSummaryHover, getSessionSummaryHoverData } from '../sessionHoverContent.js';
import { IHoverService, type IManagedHover } from '../../../../../platform/hover/browser/hoverService.js';

/** Session picker owned by the dedicated Sessions Workbench sidebar. */
export class SessionsList extends DomWidget {
	private readonly search: SessionsListSearch;
	private readonly feedback = this._register(new SessionActionFeedback());
	private readonly rowMenuContext = this._register(new MutableDisposable<IScopedContextKeyService>());
	readonly domNode: HTMLElement;
	private readonly heading: HTMLHeadingElement;
	private readonly list: HTMLDivElement;
	private readonly items = this._register(new DisposableMap<string, SessionListItem>());
	private readonly sections = this._register(new DisposableMap<string, SessionListSection>());
	private projects: readonly Project[] = [];
	private projectLoad = 0;
	private projectsFailed = false;
	private projectsLoading = false;
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
		@ISessionsListModelService private readonly listModel: ISessionsListModelService,
		@ISessionSectionOrderService private readonly sectionOrder: ISessionSectionOrderService,
		@IContextKeyService private readonly contextKeys?: IContextKeyService,
		@IHoverService private readonly hoverService?: IHoverService,
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
		this.search = this._register(new SessionsListSearch(this.domNode, this.list, () => this.render(), () => {
			const row = [...this.list.querySelectorAll<HTMLButtonElement>('.ash-sessions-list-item')].find(button => !button.closest('[hidden]'));
			row?.focus();
		}));
		this._register(listModel.registerTree(mode, () => this.readTree()));
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
		this.registerOrderingDragAndDrop();
		this._register(sessionService.onDidChange(() => this.render()));
		this._register(storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key.startsWith(`sessions.list.${mode}.collapsed.`)
				|| event.scope === StorageScope.WORKSPACE && event.key.startsWith('sessions.inputDraft:untitled:')) this.render();
		}));
		this._register(listModel.onDidChange(() => this.render()));
		this._register(sectionOrder.onDidChange(() => this.render()));
		this._register(viewService.onDidChange(() => this.render()));
		this._register(github.onDidChange(() => this.render()));
		this._register(groups.onDidChange(() => this.render()));
		const menu = this._register(menus.createMenu(Menus.SidebarSessionsHeader));

		const more = this._register(new Button(this.domNode, {
			...defaultButtonStyles, icon: Lxicon.ellipsis, iconOnly: true, presentation: 'quiet', size: 'small',
			label: localize('sessions.list.moreActions', 'More Sessions Actions'),
			onClick: event => {
				more.domNode.setAttribute('aria-expanded', 'true');
				this.contextMenus.showContextMenu({
					getAnchor: () => more.domNode,
					getActions: () => {
						const mode = listModel.automationSessionsMode;
						const checked = mode === 'always';
						const label = localize('sessions.list.showAutomationSessions', 'Show Automation Sessions');
						return Separator.join([{
							id: 'sessions.list.search',
							label: localize({ bundle: 'ash.sessions', key: 'sessions.list.inlineSearch' }, 'Search sessions in the sidebar'),
							tooltip: '',
							enabled: true,
							run: () => this.search.open(),
						}], [{
							id: 'sessions.list.toggleAutomationSessions',
							label,
							tooltip: label,
							enabled: true,
							checked,
							run: () => listModel.setAutomationSessionsMode(checked ? 'never' : 'always'),
						}, {
							id: 'sessions.list.showAutomationSessionsAfterReply',
							label: localize('sessions.list.showAutomationSessionsAfterReply', 'Show Automation Sessions After Reply'),
							tooltip: '',
							enabled: true,
							checked: mode === 'afterReply',
							run: () => listModel.setAutomationSessionsMode(mode === 'afterReply' ? 'never' : 'afterReply'),
						}], [{
							id: 'sessions.list.sortByCreated',
							label: localize('sessions.list.sortByCreated', 'Sort by Creation Time'),
							tooltip: '',
							enabled: true,
							checked: listModel.sortMode === 'created',
							run: () => listModel.setSortMode('created'),
						}, {
							id: 'sessions.list.sortByUpdated',
							label: localize('sessions.list.sortByUpdated', 'Sort by Last Update'),
							tooltip: '',
							enabled: true,
							checked: listModel.sortMode === 'updated',
							run: () => listModel.setSortMode('updated'),
						}], ...menu.getActions().filter(([group]) => group !== 'navigation').map(([, actions]) => [...actions]));
					},
					getMenuClassName: () => 'ash-sessions-list-menu',
					autoSelectFirstItem: event.detail === 0,
					onHide: () => more.domNode.setAttribute('aria-expanded', 'false'),
				});
			},
		}));
		this.domNode.insertBefore(more.domNode, this.list);
		more.domNode.classList.add('ash-sessions-list-more');
		more.domNode.setAttribute('aria-haspopup', 'menu');
		more.domNode.setAttribute('aria-expanded', 'false');
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
		this._register(autorun(reader => {
			customViews.activeCustomView.read(reader);
			this.render();
		}));
		this.render();
		this._register(projectService.onDidChange(() => { void this.loadProjects(); }));
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

	private registerOrderingDragAndDrop(): void {
		const selector = '[data-row-order-id], [data-section-order-id]';
		let source: HTMLElement | undefined;
		const destination = (event: DragEvent) => {
			const target = (event.target as Element | null)?.closest<HTMLElement>(`${selector}, [data-section]`);
			if (!source || !target || source === target || !this.list.contains(source)) return;
			const attribute = source.dataset.rowOrderId ? 'rowOrderId' : 'sectionOrderId';
			if (source.parentElement === target.parentElement && target.dataset[attribute]) return { target, attribute } as const;
			if (attribute !== 'rowOrderId') return;
			const section = target.closest<HTMLElement>('[data-section]')?.dataset.section;
			const from = source.parentElement?.closest<HTMLElement>('[data-section]')?.dataset.section;
			if (section !== from && (section === 'pinned' || section === 'recent'
				|| this.groups.groups.some(group => group.kind !== 'comparison' && section === `group:${group.sectionId}`))) {
				return { target, attribute, section } as const;
			}
		};
		this._register(addDisposableListener(this.list, 'dragstart', event => {
			const handle = (event.target as Element | null)?.closest<HTMLElement>('[draggable="true"]');
			source = handle?.closest<HTMLElement>(selector) ?? undefined;
			if (source && event.dataTransfer) {
				event.dataTransfer.effectAllowed = 'move';
				event.dataTransfer.setData('application/x-ash-session-order', '');
			}
		}));
		this._register(addDisposableListener(this.list, 'dragover', event => {
			if (!destination(event)) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		}));
		this._register(addDisposableListener(this.list, 'drop', event => {
			const drop = destination(event);
			if (!drop || !source) return;
			event.preventDefault();
			if ('section' in drop && drop.section) {
				void this.moveToSection(source.dataset.rowOrderId!, drop.section, drop.target.dataset.rowOrderId).catch(error => this.notifications.error(String(error)));
			} else {
				this.moveOrderedItem(source, drop.attribute, drop.target.dataset[drop.attribute]!);
			}
			source = undefined;
		}));
		this._register(addDisposableListener(this.list, 'dragend', () => { source = undefined; }));
	}

	private async moveToSection(id: string, section: string, targetId?: string): Promise<void> {
		const session = this.sessionService.sessions.find(candidate => candidate.sessionId === id && candidate.status === 'active');
		if (!session) return;
		if (section === 'pinned') {
			this.listModel.pinSession(session);
		} else {
			const group = section === 'recent' ? null : section.slice('group:'.length);
			await this.groups.move(id, group);
			if (this.isDisposed) return;
			this.listModel.unpinSession(session);
		}
		const item = this.items.get(`session:${id}`)?.presentation;
		if (item && targetId) this.moveOrderedItem(item, 'rowOrderId', targetId);
	}

	private moveOrderedItem(element: HTMLElement, attribute: 'rowOrderId' | 'sectionOrderId', targetId: string): void {
		const parent = element.parentElement;
		const id = element.dataset[attribute];
		if (!parent || !id) return;
		const ids = this.orderedSiblingIds(parent, attribute);
		if (attribute === 'rowOrderId') {
			const section = parent.closest<HTMLElement>('[data-section]')?.dataset.section ?? '';
			this.listModel.moveSession(`${this.mode}:${section}`, ids, id, targetId);
		} else {
			this.sectionOrder.reorder(this.mode, ids, id, targetId);
		}
	}

	private orderedSiblingIds(parent: HTMLElement, attribute: 'rowOrderId' | 'sectionOrderId'): string[] {
		return Array.from(parent.children).flatMap(child => {
			const id = (child as HTMLElement).dataset[attribute];
			return id ? [id] : [];
		});
	}

	private orderActions(element: HTMLElement, kind: 'row' | 'section'): IAction[] {
		const attribute = kind === 'row' ? 'rowOrderId' : 'sectionOrderId';
		const id = element.dataset[attribute];
		const parent = element.parentElement;
		if (!id || !parent) {
			return [];
		}
		const ids = this.orderedSiblingIds(parent, attribute);
		const index = ids.indexOf(id);
		const action = (delta: number, label: string): IAction => ({
			id: delta < 0 ? 'sessions.list.moveUp' : 'sessions.list.moveDown',
			label,
			tooltip: label,
			enabled: ids[index + delta] !== undefined,
			run: () => { const target = ids[index + delta]; if (target !== undefined) this.moveOrderedItem(element, attribute, target); },
		});
		return ids.length < 2 ? [] : [
			action(-1, localize('sessions.list.moveUp', 'Move Up')),
			action(1, localize('sessions.list.moveDown', 'Move Down')),
		];
	}

	private showSectionMenu(section: SessionListSection, group: SessionGroup, anchor: ContextMenuAnchor): void {
		const actions = this.orderActions(section.domNode, 'section');
		if (actions.length) {
		if (group.kind !== 'comparison') {
			const appearanceAction = (property: 'icon' | 'color', label: string): IAction => ({
				id: `${CHANGE_SESSION_GROUP_APPEARANCE}.${property}`,
				label,
				tooltip: '',
				enabled: true,
				run: () => this.commands.executeCommand(CHANGE_SESSION_GROUP_APPEARANCE, group.sectionId, property)
					.catch(error => this.notifications.error(String(error))),
			});
			actions.push(
				appearanceAction('icon', localize('sessions.list.changeGroupIcon', 'Change group icon')),
				appearanceAction('color', localize('sessions.list.changeGroupColor', 'Change group color')),
			);
		}
			this.contextMenus.showContextMenu({ getAnchor: () => anchor, getActions: () => actions, autoSelectFirstItem: true });
		}
	}

	private automationVisibilityActions(selection: SessionsViewSelection): IAction[] {
		if (selection.kind !== 'session' || selection.active.session.source !== 'automation') return [];
		const { session } = selection.active;
		const listed = this.listModel.isSessionListed(session);
		const actions: IAction[] = [{
			id: 'sessions.list.overrideAutomationVisibility',
			label: listed
				? localize('sessions.list.hideAutomationSession', 'Hide from Sessions List')
				: localize('sessions.list.showAutomationSession', 'Show in Sessions List'),
			tooltip: '',
			enabled: true,
			run: () => this.listModel.setAutomationSessionOverride(session, listed ? 'hide' : 'show'),
		}];
		if (this.listModel.getAutomationSessionOverride(session) !== undefined) {
			actions.push({
				id: 'sessions.list.resetAutomationVisibility',
				label: localize('sessions.list.resetAutomationVisibility', 'Use Default Session Visibility'),
				tooltip: '',
				enabled: true,
				run: () => this.listModel.setAutomationSessionOverride(session, undefined),
			});
		}
		return actions;
	}

	private showItemMenu(selection: SessionsViewSelection, item: SessionListItem, anchor: ContextMenuAnchor): void {
		const sessionActions: IAction[] = [];
		if (selection.kind === 'session') {
			const { session, threadId } = selection.active;
			if (threadId === session.sessionId && this.sessionService.canChangeDirectory?.(session.sessionId)) {
				sessionActions.push({
					id: 'agentSession.changeDirectory',
					label: localize({ bundle: 'ash.sessions', key: 'sessions.directory.change' }, 'Change Session Folder…'),
					tooltip: '',
					enabled: true,
					run: () => this.commands.executeCommand('agentSession.changeDirectory', session.sessionId),
				});
			}
			if (this.sessionService.getChatMoveDestinations?.(session.sessionId, threadId).length) {
				sessionActions.push({
					id: 'agentSession.moveChatToSession',
					label: localize({ bundle: 'ash.sessions', key: 'sessions.list.moveChat' }, 'Move Conversation to Session…'),
					tooltip: '',
					enabled: true,
					run: () => this.commands.executeCommand('agentSession.moveChatToSession', { sessionId: session.sessionId, threadId }),
				});
			}
		}
		this.rowMenuContext.clear();
		const context = this.rowMenuContext.value = this.contextKeys?.createScoped(item.domNode);
		if (context) SessionsMenuActiveConversationContext.bindTo(context).set(this.mode === 'code' && selection.kind === 'session' && selection.active.session.status === 'active');
		item.setMenuVisible(true);
		this.contextMenus.showContextMenu({
			menuId: Menus.SidebarSessionContext,
			menuActionOptions: { arg: selection },
			contextKeyService: context,
			getAnchor: () => anchor,
			getActions: () => [...this.orderActions(item.presentation, 'row'), ...sessionActions, ...this.automationVisibilityActions(selection), ...createSessionItemActions(selection, this.commands, this.listModel, this.notifications,
				() => this.commands.executeCommand('sessions.openInNewWindow', selection),
				sessionId => this.restoreViewState({ top: this.list.scrollTop, focus: `session:${sessionId}` })).map(action => action.id !== 'agentSession.archive' ? action : {
					...action,
					run: () => this.feedback.archive(item.domNode, () => action.run()),
				})],
			onHide: () => {
				if (this.rowMenuContext.value === context) this.rowMenuContext.clear();
				item.setMenuVisible(false);
			},
		});
	}

	private readTree(): readonly ISessionsListTreeNode[] {
		const nodes = new Map<Element, SessionListItem | SessionListSection>();
		for (const [, item] of this.items) nodes.set(item.presentation, item);
		for (const [, section] of this.sections) nodes.set(section.domNode, section);
		const readChildren = (parent: HTMLElement): readonly ISessionsListTreeNode[] => Array.from(parent.children).flatMap(element => {
			const node = nodes.get(element);
			return node ? [node.describe(readChildren)] : [];
		});
		return readChildren(this.list);
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
		const itemFor = (key: string, icon = this.mode === 'code' ? Lxicon.chat : undefined): SessionListItem => {
			present.add(key);
			const item = this.items.get(key) ?? this.items.set(key, new SessionListItem(ownerDocument, icon));
			item.domNode.dataset.item = key;
			return item;
		};
		const sectionFor = (key: string, title: string, children: readonly HTMLElement[], subgroup = false, open?: () => void, group?: SessionGroup): HTMLElement => {
			activeSections.add(key);
			const storageKey = `sessions.list.${this.mode}.collapsed.${key}`;
			const section = this.sections.get(key) ?? this.sections.set(key, new SessionListSection(ownerDocument, key, subgroup, collapsed => {
				if (!this.search.hasQuery) this.storage.store(storageKey, collapsed, StorageScope.PROFILE, StorageTarget.MACHINE);
			}));
			section.update(title, reorderChildren(children, ids => this.listModel.getSessionOrder(`${this.mode}:${key}`, ids), 'rowOrderId'),
				!this.search.hasQuery && this.storage.getBoolean(storageKey, StorageScope.PROFILE, false), open, group);
			if (group) {
				section.domNode.dataset.sectionOrderId = key;
				section.button.draggable = true;
				section.setContextMenu(anchor => this.showSectionMenu(section, group, anchor));
			}
			return section.domNode;
		};
		// Content belongs to the composer store; an open blank welcome page is not a recent conversation.
		// Include parked drafts too, so switching conversations does not hide their only sidebar entry.
		const nestedDrafts = new Map<string, HTMLElement[]>();
		for (const session of this.sessionService.untitledSessions) {
			let draft: ReturnType<typeof readNewChatDraftState>;
			try { draft = readNewChatDraftState(this.storage, `untitled:${session.untitledSessionId}`, chatInputStatePersistence); }
			catch { continue; } // The composer reports unreadable drafts; one must not break the whole list.
			if (!session.forkSource && (!draft || (!draft.text.trim() && draft.contexts.length === 0))) continue;
			if (!this.search.matches(session.title)) continue;
			const selected = activeSelection?.kind === 'untitled' && activeSelection.session.untitledSessionId === session.untitledSessionId;
			const item = itemFor(`untitled:${session.untitledSessionId}`);
			item.update(localize('sessions.list.draft', '{0} (draft)', session.title || localize('chat.sessions.new', 'New Session')), selected, () => this.viewService.openUntitledSession(session.untitledSessionId));
			item.setContextMenu(anchor => this.showItemMenu({ kind: 'untitled', session }, item, anchor));
			if (session.forkSource) {
				const id = session.forkSource.sessionId;
				const rows = nestedDrafts.get(id) ?? [];
				rows.push(item.domNode);
				nestedDrafts.set(id, rows);
			} else {
				recent.push(item.domNode);
			}
		}
		const catalog = getSessionsListEntries(this.sessionService.sessions, this.listModel,
			activeSelection?.kind === 'session' ? activeSelection.active.session.sessionId : undefined);
		const groupNames = new Map(this.groups.groups.flatMap(group => group.sessionIds.map(id => [id, group.name] as const)));
		for (const session of catalog) {
			const current = activeSelection?.kind === 'session' && activeSelection.active.session.sessionId === session.sessionId ? activeSelection.active : undefined;
			const activeChats = session.chats.filter(chat => chat.status === 'active');
			const thread = activeChats.find(chat => chat.threadId === session.sessionId)
				?? activeChats.find(chat => chat.origin.type === 'root') ?? activeChats[0];
			if (!thread) continue;
			const requests = this.github.getSessionPullRequests(session.sessionId);
			const fields = [session.title, session.providerLabel, session.workspace?.root, groupNames.get(session.sessionId),
			...requests.map(getPullRequestLabel)];
			const matchesSession = this.search.matches(thread.title, ...fields);
			const nested = activeChats.filter(chat => chat !== thread && chat.origin.type !== 'agentSpawn'
				&& (matchesSession || this.search.matches(chat.title, chat.workspace?.root, ...fields)));
			if (!matchesSession && !nested.length && !nestedDrafts.has(session.sessionId)) continue;
			const item = itemFor(`session:${session.sessionId}`);
			item.target = { sessionId: session.sessionId, threadId: thread.threadId };
			item.update(session.title || localize('sessions.list.untitled', 'Untitled Session'), current?.threadId === thread.threadId, () => this.viewService.openSession(session.sessionId, thread.threadId), session.management);
			item.setContextMenu(anchor => this.showItemMenu({ kind: 'session', active: { session, threadId: thread.threadId } }, item, anchor));
			item.updatePullRequests(getHighestPriorityPullRequestIcon(requests.map(request => request.icon)), requests.map(getPullRequestLabel).join('\n'));
			item.updateSummary(this.hoverService, getSessionSummaryHoverData(session, thread));
			const children = nested.map(chat => {
				const child = itemFor(`chat:${JSON.stringify([session.sessionId, chat.threadId])}`);
				child.target = { sessionId: session.sessionId, threadId: chat.threadId };
				child.update(chat.title || localize('sessions.list.untitledChat', 'Untitled Chat'), current?.threadId === chat.threadId,
					() => this.viewService.openSession(session.sessionId, chat.threadId), chat.management);
				child.updateSummary(this.hoverService, getSessionSummaryHoverData(session, chat));
				child.setContextMenu(anchor => this.showItemMenu({ kind: 'session', active: { session, threadId: chat.threadId } }, child, anchor));
				return child.domNode;
			});
			item.updateChats([...children, ...(nestedDrafts.get(session.sessionId) ?? [])]);
			delete item.domNode.dataset.rowOrderId;
			item.presentation.dataset.rowOrderId = session.sessionId;
			item.domNode.draggable = true;
			if (this.listModel.isSessionPinned(session)) pinned.push(item.presentation);
			else remaining.set(session.sessionId, item.presentation);
		}
		const projects: HTMLElement[] = [];
		const chatGroups: HTMLElement[] = [];
		for (const project of this.projects) {
			if (!this.search.matches(project.name)) continue;
			const item = itemFor(`project:${project.id}`, Lxicon.projects);
			item.update(project.name, false, () => { void this.commands.executeCommand('sessions.open.projects', project.id).catch(error => this.notifications.error(String(error))); });
			projects.push(item.domNode);
		}
		if (this.projectsFailed && !this.search.hasQuery) projects.push(this.projectError);
		for (const group of this.groups.groups) {
			const members: HTMLElement[] = [];
			for (const id of group.sessionIds) {
				const item = remaining.get(id);
				if (item) { members.push(item); remaining.delete(id); }
			}
			if (this.search.hasQuery && !members.length && !this.search.matches(group.name)) continue;
			(this.mode === 'code' ? recent : chatGroups).push(sectionFor(`group:${group.sectionId}`, group.name, members, this.mode === 'code',
				group.kind === 'comparison' ? () => { void this.openComparison(group.sessionIds); } : undefined, group));
		}
		const orderedRecent = reorderChildren(recent, ids => this.sectionOrder.getOrder(this.mode, ids), 'sectionOrderId');
		orderedRecent.push(...remaining.values());
		const showEmpty = orderedRecent.length === 0 && pinned.length === 0 && chatGroups.length === 0;
		const loading = this.sessionService.state === 'loading';
		this.list.setAttribute('aria-busy', String(loading || this.projectsLoading));
		const emptyStatus = loading ? localize('sessions.list.loading', 'Loading sessions…') : this.sessionService.error
			?? (this.search.hasQuery ? localize({ bundle: 'ash.sessions', key: 'sessions.list.searchEmpty' }, 'No matching sessions.') : undefined);
		if (showEmpty && emptyStatus) { this.empty.textContent = emptyStatus; }
		const ordered: HTMLElement[] = [];
		if (pinned.length) ordered.push(sectionFor('pinned', localize('sessions.list.pinned', 'Pinned'), pinned));
		if (projects.length) ordered.push(sectionFor('projects', localize('projects.title', 'Projects'), projects));
		ordered.push(...reorderChildren(chatGroups, ids => this.sectionOrder.getOrder(this.mode, ids), 'sectionOrderId'));
		if (orderedRecent.length) ordered.push(sectionFor('recent', this.mode === 'chat' ? localize('sessions.list.chats', 'Chats') : localize('sessions.list.recents', 'Recents'), orderedRecent));
		if (showEmpty && emptyStatus) ordered.push(this.empty);
		// Keep filtered rows available so closing search can restore the original focus target.
		if (!this.search.hasQuery) {
			for (const key of this.items.keys()) if (!present.has(key)) this.items.deleteAndDispose(key);
			for (const key of this.sections.keys()) if (!activeSections.has(key)) this.sections.deleteAndDispose(key);
		}
		reconcileChildren(this.list, ordered);
		if (focused?.isConnected && !focused.closest('[hidden]') && ownerDocument.activeElement !== focused) focused.focus({ preventScroll: true });
	}
	private async openComparison(sessionIds: readonly string[]): Promise<void> {
		for (const id of sessionIds) {
			const session = this.sessionService.sessions.find(candidate => candidate.sessionId === id && candidate.status === 'active');
			const thread = session?.chats.find(candidate => candidate.status === 'active' && candidate.origin.type === 'root')
				?? session?.chats.find(candidate => candidate.status === 'active');
			if (!thread) continue;
			const revision = this.viewService.navigationRevision;
			try {
				await this.viewService.openThread(id, thread.threadId, { sideBySide: true });
			} catch (error) {
				this.notifications.error(String(error));
				if (this.viewService.navigationRevision !== revision + 1) break;
				continue;
			}
			const active = this.viewService.activeSelection;
			if (active?.kind !== 'session' || active.active.session.sessionId !== id || active.active.threadId !== thread.threadId) break;
		}
	}

}

/** Retain rows and headings during refreshes so keyboard focus and scroll do not jump. */
function reconcileChildren(parent: HTMLElement, children: readonly HTMLElement[]): void {
	for (let index = 0; index < children.length; index++) {
		if (parent.childNodes[index] !== children[index]) parent.insertBefore(children[index], parent.childNodes[index] ?? null);
	}
	while (parent.childNodes.length > children.length) parent.lastChild!.remove();
}

/** Project an order into movable slots while retaining fixed siblings in place. */
function reorderChildren(children: readonly HTMLElement[], order: (ids: readonly string[]) => readonly string[], attribute: 'rowOrderId' | 'sectionOrderId'): HTMLElement[] {
	const movable = new Map<string, HTMLElement>();
	for (const child of children) {
		const id = child.dataset[attribute];
		if (id) movable.set(id, child);
	}
	if (movable.size < 2) return [...children];
	const ordered = order([...movable.keys()]).map(id => movable.get(id)!);
	let next = 0;
	return children.map(child => child.dataset[attribute] ? ordered[next++]! : child);
}

class SessionListSection extends AbstractDisposable {
	readonly domNode: HTMLElement;
	readonly button: HTMLButtonElement;
	private readonly body: HTMLElement;
	private readonly label: HTMLElement;
	private readonly icon: HTMLElement;
	private collapsed = false;
	private readonly appearanceIcon: HTMLElement;
	private open: (() => void) | undefined;
	private contextMenu: ((anchor: ContextMenuAnchor) => void) | undefined;
	private readonly listeners: { dispose(): void; }[];

	describe(readChildren: (parent: HTMLElement) => readonly ISessionsListTreeNode[]): ISessionsListTreeNode {
		return {
			id: this.domNode.dataset.section!, kind: 'section', label: this.label.textContent ?? '',
			collapsed: this.collapsed, children: readChildren(this.body)
		};
	}

	constructor(document: Document, key: string, private readonly subgroup: boolean, toggle: (collapsed: boolean) => void) {
		super();
		this.domNode = h(document, 'section', { className: subgroup ? 'ash-sessions-list-subgroup' : 'ash-sessions-list-section' });
		this.domNode.dataset.section = key;
		const heading = h(document, 'h3');
		this.button = h(document, 'button', { className: 'ash-sessions-list-section-toggle' });
		this.button.type = 'button';
		this.icon = h(document, 'span', { className: 'ash-sessions-list-section-icon' });
		this.label = h(document, 'span', { className: 'ash-sessions-list-section-label' });
		this.appearanceIcon = h(document, 'span', { className: 'ash-sessions-list-section-icon' });
		this.button.append(...(subgroup ? [this.icon, this.label] : [this.label, this.icon]));
		heading.append(this.button);
		this.body = h(document, 'div', { className: 'ash-sessions-list-section-body' });
		this.body.id = `ash-sessions-list-${generateUuid()}`;
		this.button.setAttribute('aria-controls', this.body.id);
		this.domNode.append(heading, this.body);
		this.listeners = [
			addDisposableListener(this.button, 'click', () => { if (this.open) this.open(); else toggle(!this.collapsed); }),
			addDisposableListener(this.button, 'contextmenu', event => {
				if (!this.contextMenu) return;
				event.preventDefault();
				this.contextMenu({ x: event.clientX, y: event.clientY, targetWindow: getWindow(this.button) });
			}),
			addDisposableListener(this.button, 'keydown', event => {
				if (this.contextMenu && (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) {
					event.preventDefault();
					event.stopPropagation();
					this.contextMenu(this.button);
					return;
				}
				if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
				event.preventDefault();
				toggle(event.key === 'ArrowLeft');
			}),
		];
	}

	setContextMenu(menu: (anchor: ContextMenuAnchor) => void): void {
		this.contextMenu = menu;
		this.button.setAttribute('aria-haspopup', 'menu');
	}

	update(title: string, children: readonly HTMLElement[], collapsed: boolean, open?: () => void, group?: SessionGroup): void {
		this.open = open;
		this.label.textContent = title;
		this.button.title = open ? localize('sessions.list.openComparison', 'Open comparison {0}', title) : title;
		if (open) this.button.setAttribute('aria-label', this.button.title);
		else this.button.removeAttribute('aria-label');
		this.collapsed = collapsed;
		this.button.setAttribute('aria-expanded', String(!collapsed));
		const icon = this.subgroup ? collapsed ? Lxicon.folder : Lxicon.folderOpened : collapsed ? Lxicon.chevronRight : Lxicon.chevronDown;
		const customIcon = group?.icon && getRegisteredIcon(group.icon, this.icon.ownerDocument);
		if (this.icon.firstElementChild?.getAttribute('data-ash-icon-id') !== icon.id) {
			this.icon.replaceChildren(); appendIcon(icon, this.icon);
		}
		if (collapsed && this.body.contains(this.domNode.ownerDocument.activeElement)) this.button.focus({ preventScroll: true });
		const color = group?.color ? `var(${colorCssVariable(group.color)})` : '';
		this.icon.style.color = customIcon ? '' : color;
		if (customIcon) {
			if (this.appearanceIcon.firstElementChild?.getAttribute('data-ash-icon-id') !== customIcon.id) {
				this.appearanceIcon.replaceChildren();
				appendIcon(customIcon, this.appearanceIcon);
			}
			this.appearanceIcon.style.color = color;
			if (!this.appearanceIcon.parentElement) this.label.before(this.appearanceIcon);
		} else {
			this.appearanceIcon.remove();
		}
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
	target: { readonly sessionId: string; readonly threadId: string; } | undefined;
	private readonly button: HTMLButtonElement;
	private readonly actions: ActionBar;
	private readonly label: HTMLSpanElement;
	private readonly pullRequest: HTMLSpanElement;
	private chats: HTMLElement | undefined;
	private wrapper: HTMLElement | undefined;
	get presentation(): HTMLElement { return this.chats?.childElementCount ? this.wrapper! : this.domNode; }
	private readonly management: HTMLSpanElement;
	private managementDescription: string | undefined;
	private pullRequestDescription = '';
	private readonly summaryHover = new MutableDisposable<IManagedHover>();
	private summaryText: string | undefined;
	private open: () => void = () => { };
	private readonly clickListener;
	private readonly contextListeners;
	private contextMenu: ((anchor: ContextMenuAnchor) => void) | undefined;

	describe(readChildren: (parent: HTMLElement) => readonly ISessionsListTreeNode[]): ISessionsListTreeNode {
		const id = this.domNode.dataset.item!;
		const kind = id.startsWith('session:') ? 'session' : id.startsWith('chat:') ? 'chat' : id.startsWith('project:') ? 'project' : 'draft';
		return {
			id, kind, label: this.label.textContent ?? '', ...this.target,
			...(this.chats?.childElementCount ? { children: readChildren(this.chats) } : {})
		};
	}

	updateChats(children: readonly HTMLElement[]): void {
		if (!children.length) {
			this.chats?.replaceChildren();
			return;
		}
		const group = this.chats ??= h(this.domNode.ownerDocument, 'div', { className: 'ash-sessions-list-nested-chats' });
		group.setAttribute('role', 'group');
		group.setAttribute('aria-label', localize('sessions.list.nestedChats', 'Conversations in {0}', this.label.textContent ?? ''));
		const wrapper = this.wrapper ??= h(this.domNode.ownerDocument, 'div');
		if (!group.parentElement) wrapper.append(group);
		if (this.domNode.parentElement !== wrapper) wrapper.prepend(this.domNode);
		reconcileChildren(group, children);
	}

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
				run: () => this.contextMenu?.(this.actions.domNode),
			}],
		});
		this.actions.domNode.classList.add('ash-sessions-list-actions');
		this.actions.domNode.hidden = true;
		this.actions.domNode.querySelector('button')?.setAttribute('aria-haspopup', 'menu');
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
		this.actions.domNode.hidden = false;
	}

	setMenuVisible(visible: boolean): void {
		this.domNode.classList.toggle('menu-visible', visible);
		this.actions.domNode.querySelector('button')?.setAttribute('aria-expanded', String(visible));
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
		if (!this.summaryHover.value) this.button.title = parts.join('\n');
		this.button.setAttribute('aria-label', parts.join('. '));
	}

	updateSummary(hoverService: IHoverService | undefined, metadata: readonly string[]): void {
		if (!hoverService) return;
		const title = this.label.textContent ?? '';
		const details = [this.managementDescription, ...metadata, this.pullRequestDescription].filter((value): value is string => !!value);
		const summaryText = JSON.stringify([title, details]);
		if (this.summaryText === summaryText) return;
		this.summaryText = summaryText;
		const content = createSessionSummaryHover(this.button.ownerDocument, title, details);
		if (this.summaryHover.value) {
			this.summaryHover.value.update(content);
		} else {
			this.button.removeAttribute('title');
			this.summaryHover.value = hoverService.setupHover({ target: this.button, content, groupId: 'sessions-list' });
		}
	}

	protected override disposeCore(): void {
		this.summaryHover.dispose();
		this.clickListener.dispose();
		this.actions.dispose();
		for (const listener of this.contextListeners) listener.dispose();
		this.wrapper?.remove();
		this.domNode.remove();
	}
}
