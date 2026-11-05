import { IContextKeyService, type IScopedContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { SessionsMenuActiveConversationContext } from '../../../../common/contextkeys.js';
import { ISessionsListModelService, type ISessionsListTreeNode, type SessionGrouping, type SessionSortDirection, type SessionSortMode } from '../../../../services/sessions/browser/sessionsListModelService.js';
import { Separator, SubmenuAction, type IAction } from '../../../../../base/common/actions.js';
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
import { AbstractDisposable, Disposable, DisposableMap, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { MOVE_CHAT_TO_SESSION_ACTION_ID } from '../sessionsActions.js';
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
import type { ISession, SessionManagementInfo } from '../../../../services/sessions/common/session.js';
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
import { WorkbenchObjectTree } from '../../../../../platform/list/browser/listService.js';
import type { ObjectTreeElement } from '../../../../../base/browser/ui/tree/objectTreeModel.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ContextMenuAnchor } from '../../../../../base/browser/contextmenu.js';
import { Menus } from '../../../../browser/menus.js';
import { ActionBar } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { extUriBiasedIgnorePathCase } from '../../../../../base/common/resources.js';
import { sessionWorkspaceUri } from '../../../../common/sessionWorkspace.js';
import { ISessionProviderScopeService } from '../../../../browser/agentHost/sessionProviderScopeService.js';
import { DropdownMenuActionViewItem } from '../../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js';
import { createSessionItemActions } from '../../../../browser/agentSessionsModel.js';
import type { SessionsViewSelection } from '../../../../services/sessions/browser/sessionsService.js';
import { readNewChatDraftState } from '../../../chat/common/newChatDraftState.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { Icon } from '../../../../../base/common/icon.js';
import { SessionLeadingIcon } from '../../../../browser/ui/sessionLeadingIcon.js';
import { createSessionSummaryHover, getSessionSummaryHoverData } from '../sessionHoverContent.js';
import { IHoverService, type IManagedHover } from '../../../../../platform/hover/browser/hoverService.js';
import { LocalChatSessionUri } from '../../../../../workbench/contrib/chat/common/model/chatUri.js';
import { fillChatReferenceDragData } from '../../../../browser/dnd.js';

interface SessionBucket {
	readonly id: string;
	readonly label: string;
}

const managementIcons: Record<SessionManagementInfo['status'], Icon | undefined> = {
	idle: undefined,
	needsInput: Lxicon.question,
	working: Lxicon.sync,
	readyForReview: Lxicon.codeReview,
	completed: Lxicon.check,
	failed: Lxicon.error,
	stopped: Lxicon.stopCircle,
};

export type SessionsListPresentation = 'chat' | 'code' | { readonly openCommand: string; readonly activeContext: string; };

/** Session picker owned by the dedicated Sessions Workbench sidebar. */
export class SessionsList extends DomWidget {
	private readonly mode: 'chat' | 'code';
	private readonly entry: Exclude<SessionsListPresentation, string> | undefined;
	private readonly search: SessionsListSearch;
	private readonly tree: SessionsListTree;
	private syncingCollapse = false;
	private branches: readonly ObjectTreeElement<HTMLElement>[] = [];
	private readonly parents = new Map<HTMLElement, ObjectTreeElement<HTMLElement> | undefined>();
	private readonly feedback = this._register(new SessionActionFeedback());
	private readonly rowMenuContext = this._register(new MutableDisposable<IScopedContextKeyService>());
	readonly domNode: HTMLElement;
	private readonly list: HTMLDivElement;
	private readonly items = this._register(new DisposableMap<string, SessionListItem>());
	private readonly sections = this._register(new DisposableMap<string, SessionListSection>());
	private projects: readonly Project[] = [];
	private readonly repositoryGroups = new Map<string, SessionBucket | undefined>();
	private readonly repositoryLookup = new MutableDisposable<CancellationTokenSource>();
	private projectLoad = 0;
	private projectsFailed = false;
	private projectsLoading = false;
	private readonly empty: HTMLParagraphElement;
	private readonly projectError: HTMLButtonElement;
	private readonly navigation: HTMLElement;
	private readonly navigationButtons = this._register(new DisposableMap<string, Button>());
	private readonly navigationActions = new Map<string, MenuActionGroup[1][number]>();

	public get element(): HTMLElement { return this.domNode; }

	constructor(container: HTMLElement, title: string, presentation: SessionsListPresentation,
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
		@ISessionProviderScopeService private readonly providerScopes?: ISessionProviderScopeService,
		@IInstantiationService private readonly instantiation?: IInstantiationService,
		@IConfigurationService configuration?: IConfigurationService,
	) {
		super();
		const mode = this.mode = typeof presentation === 'string' ? presentation : 'chat';
		this.entry = typeof presentation === 'string' ? undefined : presentation;
		const ownerDocument = container.ownerDocument;
		this.domNode = h(ownerDocument, 'section');
		this.domNode.className = 'ash-sessions-list';
		this.domNode.tabIndex = -1;
		this.domNode.dataset.mode = mode;
		this.navigation = h(ownerDocument, 'nav', { className: 'ash-sessions-list-navigation', attributes: { 'aria-label': localize('sessions.list.navigation', 'Sessions navigation') } });
		const header = h(ownerDocument, 'header', { className: 'ash-sessions-list-header' });
		const heading = h(ownerDocument, 'h2', { className: 'ash-sessions-list-title' });
		heading.textContent = title;
		header.append(heading);
		const config = configuration ?? this._register(new InMemoryConfigurationService());
		// Embedded Sessions shares Chat's viewport with the conversation history.
		this.tree = this._register(new SessionsListTree(this.domNode, title, config, this.entry ? 'external' : 'managed'));
		this.list = this.tree.domNode;
		this.list.classList.add('ash-sessions-list-items');
		this._register(this.tree.onDidChangeCollapseState(({ element, collapsed }) => {
			const key = element.dataset.section;
			if (key === undefined || this.search.hasQuery || this.syncingCollapse) return;
			this.storage.store(this.collapseKey(key), collapsed, StorageScope.PROFILE, StorageTarget.MACHINE);
		}));
		this.search = this._register(new SessionsListSearch(this.domNode, this.list, () => this.render(), () => {
			const row = [...this.list.querySelectorAll<HTMLButtonElement>('.ash-sessions-list-item')].find(button => !button.closest('[hidden]'));
			row?.focus();
		}));
		if (!this.entry) this._register(listModel.registerTree(mode, () => this.readTree()));
		else if (contextKeys) {
			const keys = new Set([this.entry.activeContext]);
			this._register(contextKeys.onDidChangeContext(event => { if (event.affectsSome(keys)) this.render(); }));
		}
		this.empty = h(ownerDocument, 'p');
		this.empty.className = 'ash-sessions-empty';
		this.projectError = h(ownerDocument, 'button', { className: 'ash-sessions-list-item' });
		this.projectError.type = 'button';
		this.projectError.textContent = localize('sessions.list.projectsRetry', 'Could not load projects. Retry');
		this._register(addDisposableListener(this.projectError, 'click', () => { void this.loadProjects(); }));
		this.domNode.append(this.navigation, header, this.list);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(addDisposableListener(this.list, 'keydown', event => {
			if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
			const buttons = [...this.list.querySelectorAll<HTMLButtonElement>('button:not(.ash-session-leading-icon button)')].filter(button => !button.closest('[hidden]'));
			const index = buttons.indexOf(ownerDocument.activeElement as HTMLButtonElement);
			if (index < 0) return;
			event.preventDefault();
			event.stopPropagation();
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
			buttons[next]?.focus();
		}, true));
		this.registerOrderingDragAndDrop();
		this._register(sessionService.onDidChange(() => this.render()));
		this._register(storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key.startsWith(`sessions.list.${mode}.collapsed.`)
				|| event.scope === StorageScope.WORKSPACE && event.key.startsWith('sessions.inputDraft:untitled:')) this.render();
		}));
		this._register(listModel.onDidChange(() => {
			if (listModel.grouping !== 'repository') {
				this.resetRepositoryGroups();
			}
			this.render();
		}));
		if (providerScopes) {
			this._register(providerScopes.onDidChangeScopes(() => {
				this.resetRepositoryGroups();
				this.render();
			}));
		}
		this._register(toDisposable(() => this.resetRepositoryGroups()));
		this._register(sectionOrder.onDidChange(() => this.render()));
		this._register(viewService.onDidChange(() => this.render()));
		this._register(github.onDidChange(() => this.render()));
		this._register(groups.onDidChange(() => this.render()));
		const menu = this._register(menus.createMenu(Menus.SidebarSessionsHeader));

		const moreLabel = localize('sessions.list.moreActions', 'More Sessions Actions');
		const createGroupLabel = localize('sessions.list.newGroup', 'New group…');
		const headerActions = this._register(new ActionBar(header, {
			ariaLabel: localize('sessions.list.headerActions', 'Sessions List Actions'),
			actions: [
				{ id: 'sessions.list.headerMore', label: moreLabel, tooltip: moreLabel, icon: Lxicon.listFilter, enabled: true, run: () => { } },
				{
					id: 'sessionsViewPane.createGroup', label: createGroupLabel, tooltip: createGroupLabel, icon: Lxicon.add, enabled: true,
					run: () => this.commands.executeCommand('sessionsViewPane.createGroup').catch(error => this.notifications.error(String(error))),
				},
			],
			actionViewItemOptions: { iconOnly: true, buttonStyles: defaultButtonStyles, buttonPresentation: 'quiet' },
			actionViewItemProvider: (action, options) => action.id === 'sessions.list.headerMore' ? new DropdownMenuActionViewItem(
				action,
				() => this.getHeaderActions(menu.getActions()),
				{
					showContextMenu: delegate => this.contextMenus.showContextMenu({
						...delegate, getMenuClassName: () => 'ash-sessions-list-menu',
						getCheckedActionsRepresentation: item => item.id.startsWith('sessions.list.groupBy.') || item.id.startsWith('sessions.list.sort') ? 'radio' : 'checkbox',
					})
				},
				options,
			) : undefined,
		}));
		headerActions.domNode.classList.add('ash-sessions-list-more');
		const updateNavigation = (): void => {
			const actions = this.entry ? [] : menu.getActions().filter(([group]) => group === 'navigation').flatMap(([, actions]) => actions);
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

	private openRow(open: () => void): void {
		if (!this.entry || this.contextKeys?.getValue(this.entry.activeContext)) { open(); return; }
		void this.commands.executeCommand(this.entry.openCommand).then(() => {
			if (!this.isDisposed) open();
		}).catch(error => this.notifications.error(String(error)));
	}

	private getHeaderActions(contributed: readonly MenuActionGroup[]): readonly IAction[] {
		const model = this.listModel;
		const choice = (id: string, label: string, checked: boolean, run: () => void): IAction => ({ id, label, tooltip: '', enabled: true, checked, run });
		const group = (value: SessionGrouping, label: string): IAction =>
			choice(`sessions.list.groupBy.${value}`, label, model.grouping === value, () => model.setGrouping(value));
		const sort = (value: SessionSortMode, label: string): IAction =>
			choice(`sessions.list.sortBy.${value}`, label, model.sortMode === value, () => model.setSortMode(value));
		const direction = (value: SessionSortDirection, label: string): IAction =>
			choice(`sessions.list.sortDirection.${value}`, label, model.sortDirection === value, () => model.setSortDirection(value));
		const automation = model.automationSessionsMode;
		return Separator.join([
			new SubmenuAction('sessions.list.groupBy', localize('sessions.list.groupBy', 'Group By'), [
				group('projects', localize('projects.title', 'Projects')),
				group('repository', localize('sessions.list.groupRepository', 'Repository')),
				group('status', localize('sessions.list.groupStatus', 'Status')),
				group('environment', localize('sessions.list.groupEnvironment', 'Environment')),
				new Separator(),
				group('none', localize('sessions.list.groupNone', 'None')),
			]),
			new SubmenuAction('sessions.list.sortBy', localize('sessions.list.sortBy', 'Sort By'), [
				sort('name', localize('sessions.list.sortName', 'Name')),
				sort('updated', localize('sessions.list.sortUpdated', 'Last Updated')),
				sort('created', localize('sessions.list.sortCreated', 'Date Created')),
				new Separator(),
				direction('ascending', localize('sessions.list.sortAscending', 'Ascending')),
				direction('descending', localize('sessions.list.sortDescending', 'Descending')),
			]),
			new SubmenuAction('sessions.list.show', localize('sessions.list.show', 'Show'), [
				choice('sessions.list.showComparisonGroups', localize('sessions.list.showComparisonGroups', 'Comparison Groups'),
					model.showComparisonGroups, () => model.setShowComparisonGroups(!model.showComparisonGroups)),
				new Separator(),
				choice('sessions.list.toggleAutomationSessions', localize('sessions.list.showAutomationSessions', 'Show Automation Sessions'),
					automation === 'always', () => model.setAutomationSessionsMode(automation === 'always' ? 'never' : 'always')),
				choice('sessions.list.showAutomationSessionsAfterReply', localize('sessions.list.showAutomationSessionsAfterReply', 'Show Automation Sessions After Reply'),
					automation === 'afterReply', () => model.setAutomationSessionsMode(automation === 'afterReply' ? 'never' : 'afterReply')),
			]),
		], [{
			id: 'sessions.list.search',
			label: localize({ bundle: 'ash.sessions', key: 'sessions.list.inlineSearch' }, 'Search sessions in the sidebar'),
			tooltip: '',
			enabled: true,
			run: () => this.search.open(),
		}], ...contributed.filter(([group]) => group !== 'navigation').map(([, actions]) => [...actions]));
	}

	focus(): void {
		const activeNavigation = this.navigation.querySelector<HTMLButtonElement>('[aria-current="page"]');
		if (activeNavigation) { activeNavigation.focus(); return; }
		const firstItem = this.list.querySelector<HTMLButtonElement>('button:not(.ash-session-leading-icon button)');
		(firstItem ?? this.domNode).focus();
	}

	public getViewState(): { readonly top: number; readonly focus: string | undefined; } {
		const active = this.domNode.ownerDocument.activeElement;
		const item = [...this.items].find(([, item]) => item.domNode.contains(active));
		const section = [...this.sections].find(([, section]) => section.button === active);
		const navigation = [...this.navigationButtons].find(([, button]) => button.domNode === active);
		return { top: this.tree.scrollTop, focus: navigation ? `navigation:${navigation[0]}` : section ? `section:${section[0]}` : item?.[0] };
	}

	public closeIconPickers(): void {
		for (const [, item] of this.items) { item.leadingIcon?.closePicker(); }
	}

	public restoreViewState(state: ReturnType<SessionsList['getViewState']>): void {
		this.render();
		this.tree.scrollTop = state.top;
		if (state.focus?.startsWith('navigation:')) this.navigationButtons.get(state.focus.slice('navigation:'.length))?.focus();
		else if (state.focus) {
			let row = state.focus.startsWith('section:')
				? this.sections.get(state.focus.slice('section:'.length))?.domNode
				: this.items.get(state.focus)?.domNode;
			while (row && !this.list.contains(row)) row = this.parents.get(row)?.element;
			if (row) this.tree.focusRow(row, true);
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
		const referenceDrag = this._register(new MutableDisposable());
		let source: HTMLElement | undefined;
		const destination = (event: DragEvent) => {
			const target = (event.target as Element | null)?.closest<HTMLElement>(`${selector}, [data-section]`);
			if (!source || !target || source === target || !this.list.contains(source)) return;
			const attribute = source.dataset.rowOrderId ? 'rowOrderId' : 'sectionOrderId';
			if (this.parents.get(source) === this.parents.get(target) && target.dataset[attribute]) return { target, attribute } as const;
			if (attribute !== 'rowOrderId') return;
			const section = target.dataset.section ?? this.parents.get(target)?.element.dataset.section;
			const from = this.parents.get(source)?.element.dataset.section;
			if (section !== from && (section === 'pinned' || section === 'recent'
				|| this.groups.groups.some(group => group.kind !== 'comparison' && section === `group:${group.sectionId}`))) {
				return { target, attribute, section } as const;
			}
		};
		this._register(addDisposableListener(this.list, 'dragstart', event => {
			const handle = (event.target as Element | null)?.closest<HTMLElement>('[draggable="true"]');
			referenceDrag.clear();
			const item = handle?.dataset.item ? this.items.get(handle.dataset.item) : undefined;
			source = item
				? (item.domNode.matches(selector) ? item.domNode : undefined)
				: handle?.closest<HTMLElement>(selector) ?? undefined;
			const conversation = item?.target;
			if (conversation && event.dataTransfer) {
				referenceDrag.value = fillChatReferenceDragData(event.dataTransfer, LocalChatSessionUri.forSession(conversation.sessionId, conversation.threadId));
				event.dataTransfer.effectAllowed = source ? 'copyMove' : 'copy';
			}
			if (source && event.dataTransfer) {
				if (!conversation) event.dataTransfer.effectAllowed = 'move';
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
		this._register(addDisposableListener(this.list.ownerDocument, 'dragend', () => {
			source = undefined;
			referenceDrag.clear();
		}, true));
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
		const item = this.items.get(`session:${id}`)?.domNode;
		if (item && targetId) this.moveOrderedItem(item, 'rowOrderId', targetId);
	}

	private moveOrderedItem(element: HTMLElement, attribute: 'rowOrderId' | 'sectionOrderId', targetId: string): void {
		const parent = this.parents.get(element);
		const id = element.dataset[attribute];
		if (!id) return;
		const ids = this.orderedSiblingIds(parent, attribute);
		if (attribute === 'rowOrderId') {
			const section = parent?.element.dataset.section ?? '';
			this.listModel.moveSession(`${this.mode}:${section}`, ids, id, targetId);
		} else {
			this.sectionOrder.reorder(this.mode, ids, id, targetId);
		}
	}

	private orderedSiblingIds(parent: ObjectTreeElement<HTMLElement> | undefined, attribute: 'rowOrderId' | 'sectionOrderId'): string[] {
		return (parent ? parent.children ?? [] : this.branches).flatMap(({ element }) => {
			const id = element.dataset[attribute];
			return id ? [id] : [];
		});
	}

	private orderActions(element: HTMLElement, kind: 'row' | 'section'): IAction[] {
		const attribute = kind === 'row' ? 'rowOrderId' : 'sectionOrderId';
		const id = element.dataset[attribute];
		const parent = this.parents.get(element);
		if (!id) {
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
		if (actions.length) {
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
					id: MOVE_CHAT_TO_SESSION_ACTION_ID,
					label: localize({ bundle: 'ash.sessions', key: 'sessions.list.moveChat' }, 'Move Conversation to Session…'),
					tooltip: '',
					enabled: true,
					run: () => this.commands.executeCommand(MOVE_CHAT_TO_SESSION_ACTION_ID, { sessionId: session.sessionId, threadId }),
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
			getActions: () => [...this.orderActions(item.domNode, 'row'), ...sessionActions, ...this.automationVisibilityActions(selection), ...createSessionItemActions(selection, this.commands, this.listModel, this.notifications,
				() => this.commands.executeCommand('sessions.openInNewWindow', selection),
				sessionId => this.restoreViewState({ top: this.tree.scrollTop, focus: `session:${sessionId}` })).map(action => action.id !== 'agentSession.archive' ? action : {
					...action,
					run: () => this.feedback.archive(item.domNode, () => action.run()),
				})],
			onHide: () => {
				if (this.rowMenuContext.value === context) this.rowMenuContext.clear();
				item.setMenuVisible(false);
			},
		});
	}

	private collapseKey(key: string): string {
		return `sessions.list.${this.mode}.collapsed.${key}`;
	}

	private readTree(): readonly ISessionsListTreeNode[] {
		const read = (branches: readonly ObjectTreeElement<HTMLElement>[]): ISessionsListTreeNode[] => branches.flatMap(branch => {
			const { element } = branch;
			const children = read(branch.children ?? []);
			const key = element.dataset.section;
			if (key !== undefined) {
				return [{
					id: key, kind: 'section', label: this.sections.get(key)!.title,
					collapsed: this.tree.isCollapsed(SessionsListTree.id(element)) ?? false, children,
				}];
			}
			const item = this.items.get(element.dataset.item ?? '');
			return item ? [item.describe(children)] : [];
		});
		return read(this.branches);
	}

	private resetRepositoryGroups(): void {
		this.repositoryLookup.value?.cancel();
		this.repositoryLookup.clear();
		this.repositoryGroups.clear();
	}

	private repositoryKey(session: ISession): string {
		return JSON.stringify([session.sessionId, session.workspace?.authorityId, session.workspace?.root]);
	}

	private async loadRepositoryGroups(sessions: readonly ISession[]): Promise<void> {
		const scopes = this.providerScopes;
		if (!scopes || this.repositoryLookup.value) {
			return;
		}
		const missing = sessions.filter(session => session.workspace && !this.repositoryGroups.has(this.repositoryKey(session)));
		if (!missing.length) {
			return;
		}
		const lookup = this.repositoryLookup.value = new CancellationTokenSource();
		const token = lookup.token;
		await Promise.resolve();
		for (const session of missing) {
			if (token.isCancellationRequested || this.isDisposed) {
				return;
			}
			const workspace = session.workspace!;
			let bucket: SessionBucket | undefined;
			try {
				const scope = scopes.getScope(session.sessionId);
				const root = sessionWorkspaceUri(workspace);
				const repositories = await scope.services.host.localGit.readRepositoryContexts({
					sessionId: scope.backendIdentity(session.sessionId), path: workspace.root,
				}, token);
				scope.assertCurrent();
				const repository = repositories
					.filter(repo => extUriBiasedIgnorePathCase.isEqualOrParent(root, sessionWorkspaceUri({ ...workspace, root: repo.rootPath })))
					.sort((left, right) => right.rootPath.length - left.rootPath.length)[0];
				if (repository) {
					const remote = repository.remotes.find(remote => remote.name === 'origin' && remote.identity)?.identity
						?? repository.remotes.find(remote => remote.identity)?.identity;
					bucket = remote
						? { id: JSON.stringify([remote.host, remote.owner, remote.repository]), label: `${remote.owner}/${remote.repository}` }
						: { id: JSON.stringify([workspace.authorityId, repository.rootPath]), label: repository.label };
				}
			} catch {
				// Some hosts cannot inspect Git metadata for a session's directory.
			}
			if (token.isCancellationRequested || this.isDisposed) {
				return;
			}
			this.repositoryGroups.set(this.repositoryKey(session), bucket);
		}
		this.repositoryLookup.clear();
		this.render();
	}

	private sessionBucket(session: ISession, grouping: Exclude<SessionGrouping, 'none'>, projects: ReadonlyMap<string, Project>): SessionBucket {
		switch (grouping) {
			case 'projects': {
				const project = projects.get(session.sessionId);
				return project ? { id: project.id, label: project.name } : { id: '', label: localize('sessions.list.noProjectGroup', 'No Project') };
			}
			case 'repository':
				return this.repositoryGroups.get(this.repositoryKey(session)) ?? { id: '', label: localize('sessions.list.noRepositoryGroup', 'No Repository Information') };
			case 'status':
				return { id: session.management?.status ?? '', label: sessionManagementLabel(session.management) ?? localize('sessions.list.unknownStatusGroup', 'Unknown Status') };
			case 'environment': {
				const workspace = session.workspace;
				if (workspace?.runtime) {
					const runtime = workspace.runtime;
					return { id: JSON.stringify([runtime.providerId, runtime.hostAuthority, runtime.workspace]), label: runtime.workspace };
				}
				if (workspace) {
					return { id: workspace.authorityId, label: workspace.authorityId === 'local' ? localize('sessions.list.localEnvironmentGroup', 'Local') : session.providerLabel || workspace.authorityId };
				}
				return { id: '', label: localize('sessions.list.noEnvironmentGroup', 'No Environment') };
			}
		}
	}

	private render(): void {
		const ownerDocument = this.domNode.ownerDocument;
		const focused = this.list.contains(ownerDocument.activeElement) ? ownerDocument.activeElement as HTMLElement : undefined;
		const present = new Set<string>();
		const activeSections = new Set<string>();
		const pinned: HTMLElement[] = [];
		const recent: HTMLElement[] = [];
		const remaining = new Map<string, HTMLElement>();
		const activeSelection = this.customViews.activeCustomView.get() || this.entry && !this.contextKeys?.getValue(this.entry.activeContext)
			? undefined : this.viewService.activeSelection;
		const itemFor = (key: string, icon = this.mode === 'code' ? Lxicon.chatSession : undefined, conversation = false): SessionListItem => {
			present.add(key);
			let item = this.items.get(key);
			if (!item) {
				const leading = conversation && this.instantiation
					? this.instantiation.createInstance(SessionLeadingIcon, ownerDocument, '',
						(picked: Icon | undefined) => this.listModel.setRowIcon(key, picked?.id))
					: undefined;
				item = this.items.set(key, new SessionListItem(ownerDocument, icon, leading));
			}
			item.domNode.dataset.item = key;
			if (item.leadingIcon) {
				const customId = this.listModel.getRowIcon(key);
				item.leadingIcon.setRestingIcon((customId ? getRegisteredIcon(customId, ownerDocument) : undefined) ?? icon);
			}
			return item;
		};
		const sectionFor = (key: string, title: string, children: readonly HTMLElement[], subgroup = false, open?: () => void, group?: SessionGroup): HTMLElement => {
			activeSections.add(key);
			const section = this.sections.get(key) ?? this.sections.set(key, new SessionListSection(ownerDocument, key, subgroup,
				collapsed => this.tree.setSectionCollapsed(key, collapsed)));
			section.update(title, reorderChildren(children, ids => this.listModel.getSessionOrder(`${this.mode}:${key}`, ids), 'rowOrderId'), {
				open,
				actionLabel: open ? localize('sessions.list.openComparison', 'Open comparison {0}', title) : undefined,
				icon: group?.icon ? getRegisteredIcon(group.icon, ownerDocument) : undefined,
				color: group?.color ? `var(${colorCssVariable(group.color)})` : undefined,
			});
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
		const projectDrafts = new Map<string, HTMLElement[]>();
		for (const session of this.sessionService.untitledSessions) {
			let draft: ReturnType<typeof readNewChatDraftState>;
			try { draft = readNewChatDraftState(this.storage, `untitled:${session.untitledSessionId}`, chatInputStatePersistence); }
			catch { continue; } // The composer reports unreadable drafts; one must not break the whole list.
			if (!session.forkSource && (!draft || (!draft.text.trim() && draft.contexts.length === 0))) continue;
			if (!this.search.matches(session.title)) continue;
			const selected = activeSelection?.kind === 'untitled' && activeSelection.session.untitledSessionId === session.untitledSessionId;
			const item = itemFor(`untitled:${session.untitledSessionId}`);
			item.update(localize('sessions.list.draft', '{0} (draft)', session.title || localize('chat.sessions.new', 'New Session')), selected, () => this.openRow(() => this.viewService.openUntitledSession(session.untitledSessionId)));
			item.setContextMenu(anchor => this.showItemMenu({ kind: 'untitled', session }, item, anchor));
			if (session.forkSource) {
				const id = session.forkSource.sessionId;
				const rows = nestedDrafts.get(id) ?? [];
				rows.push(item.domNode);
				nestedDrafts.set(id, rows);
			} else if (this.mode === 'code' && session.projectId && this.projects.some(project => project.id === session.projectId)) {
				const rows = projectDrafts.get(session.projectId) ?? [];
				rows.push(item.domNode);
				projectDrafts.set(session.projectId, rows);
			} else {
				recent.push(item.domNode);
			}
		}
		const catalog = getSessionsListEntries(this.sessionService.sessions, this.listModel,
			activeSelection?.kind === 'session' ? activeSelection.active.session.sessionId : undefined);
		const groupNames = new Map(this.groups.groups.flatMap(group => group.sessionIds.map(id => [id, group.name] as const)));
		const projectNames = new Map(this.projects.flatMap(project => project.sessionIds.map(id => [id, project.name] as const)));
		for (const session of catalog) {
			const current = activeSelection?.kind === 'session' && activeSelection.active.session.sessionId === session.sessionId ? activeSelection.active : undefined;
			const activeChats = session.chats.filter(chat => chat.status === 'active');
			const thread = activeChats.find(chat => chat.threadId === session.sessionId)
				?? activeChats.find(chat => chat.origin.type === 'root') ?? activeChats[0];
			if (!thread) continue;
			const requests = this.github.getSessionPullRequests(session.sessionId);
			const fields = [session.title, session.providerLabel, session.workspace?.root, groupNames.get(session.sessionId), projectNames.get(session.sessionId),
			...requests.map(getPullRequestLabel)];
			const matchesSession = this.search.matches(thread.title, ...fields);
			const nested = activeChats.filter(chat => chat !== thread && chat.origin.type !== 'agentSpawn'
				&& (matchesSession || this.search.matches(chat.title, chat.workspace?.root, ...fields)));
			if (!matchesSession && !nested.length && !nestedDrafts.has(session.sessionId)) continue;
			const item = itemFor(`session:${session.sessionId}`, this.mode === 'code' ? Lxicon.chatSession : Lxicon.cowork, true);
			item.target = { sessionId: session.sessionId, threadId: thread.threadId };
			item.update(session.title || localize('sessions.list.untitled', 'Untitled Session'), current?.threadId === thread.threadId, () => this.openRow(() => this.viewService.openSession(session.sessionId, thread.threadId)), session.management);
			item.setContextMenu(anchor => this.showItemMenu({ kind: 'session', active: { session, threadId: thread.threadId } }, item, anchor));
			item.updatePullRequests(getHighestPriorityPullRequestIcon(requests.map(request => request.icon)), requests.map(getPullRequestLabel).join('\n'));
			item.updateSummary(this.hoverService, getSessionSummaryHoverData(session, thread));
			const children = nested.map(chat => {
				const child = itemFor(`chat:${JSON.stringify([session.sessionId, chat.threadId])}`, Lxicon.chatSession, true);
				child.target = { sessionId: session.sessionId, threadId: chat.threadId };
				child.domNode.draggable = true;
				child.update(chat.title || localize('sessions.list.untitledChat', 'Untitled Chat'), current?.threadId === chat.threadId,
					() => this.openRow(() => this.viewService.openSession(session.sessionId, chat.threadId)), chat.management);
				child.updateSummary(this.hoverService, getSessionSummaryHoverData(session, chat));
				child.setContextMenu(anchor => this.showItemMenu({ kind: 'session', active: { session, threadId: chat.threadId } }, child, anchor));
				return child.domNode;
			});
			item.children = [...children, ...(nestedDrafts.get(session.sessionId) ?? [])];
			item.domNode.dataset.rowOrderId = session.sessionId;
			item.domNode.draggable = true;
			if (this.listModel.isSessionPinned(session)) pinned.push(item.domNode);
			else remaining.set(session.sessionId, item.domNode);
		}
		const projects: HTMLElement[] = [];
		const chatGroups: HTMLElement[] = [];
		for (const project of this.projects) {
			const members = this.mode === 'code' ? project.sessionIds.flatMap(id => {
				const item = remaining.get(id);
				if (!item) return [];
				remaining.delete(id);
				return [item];
			}) : [];
			const drafts = projectDrafts.get(project.id) ?? [];
			if (!members.length && !drafts.length && !this.search.matches(project.name)) continue;
			const item = itemFor(`project:${project.id}`, Lxicon.projects);
			item.update(project.name, false, () => { void this.commands.executeCommand('sessions.open.projects', project.id).catch(error => this.notifications.error(String(error))); });
			item.children = [...members, ...drafts];
			projects.push(item.domNode);
		}
		if (this.projectsFailed && !this.search.hasQuery) projects.push(this.projectError);
		for (const group of this.groups.groups) {
			if (group.kind === 'comparison' && !this.listModel.showComparisonGroups) {
				continue;
			}
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
		const grouping = this.listModel.grouping;
		if (grouping === 'none') {
			orderedRecent.push(...remaining.values());
		} else {
			const projectsBySession = new Map<string, Project>();
			if (grouping === 'projects') {
				for (const project of this.projects) {
					for (const id of project.sessionIds) {
						if (!projectsBySession.has(id)) {
							projectsBySession.set(id, project);
						}
					}
				}
			}
			const ungrouped = catalog.filter(session => remaining.has(session.sessionId));
			if (grouping === 'repository') {
				void this.loadRepositoryGroups(ungrouped);
			}
			const buckets = new Map<string, { readonly label: string; readonly rows: HTMLElement[]; }>();
			for (const session of ungrouped) {
				const { id, label } = this.sessionBucket(session, grouping, projectsBySession);
				let bucket = buckets.get(id);
				if (!bucket) {
					bucket = { label, rows: [] };
					buckets.set(id, bucket);
				}
				bucket.rows.push(remaining.get(session.sessionId)!);
			}
			for (const [id, bucket] of [...buckets].sort((left, right) => left[1].label.localeCompare(right[1].label))) {
				orderedRecent.push(sectionFor(`grouping:${grouping}:${id}`, bucket.label, bucket.rows, true));
			}
		}
		const showEmpty = orderedRecent.length === 0 && pinned.length === 0 && chatGroups.length === 0;
		const loading = this.sessionService.state === 'loading';
		this.tree.element.setAttribute('aria-busy', String(loading || this.projectsLoading));
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
		this.parents.clear();
		const project = (element: HTMLElement, parent?: ObjectTreeElement<HTMLElement>): ObjectTreeElement<HTMLElement> => {
			const key = element.dataset.section;
			const section = key === undefined ? undefined : this.sections.get(key);
			const item = this.items.get(element.dataset.item ?? '');
			const children: ObjectTreeElement<HTMLElement>[] = [];
			const branch = { element, children, collapsible: !!section, collapsed: !!section && !this.search.hasQuery && this.storage.getBoolean(this.collapseKey(key!), StorageScope.PROFILE, false) };
			this.parents.set(element, parent);
			if (parent) element.dataset.parentSection = parent.element.dataset.section ?? parent.element.dataset.parentSection ?? '';
			else delete element.dataset.parentSection;
			for (const child of section?.children ?? item?.children ?? []) children.push(project(child, branch));
			return branch;
		};
		this.branches = ordered.map(element => project(element));
		this.syncingCollapse = true;
		try {
			this.tree.setChildren(this.branches);
			for (const [key, section] of this.sections) {
				if (this.parents.has(section.domNode)) this.tree.setSectionCollapsed(key, !this.search.hasQuery && this.storage.getBoolean(this.collapseKey(key), StorageScope.PROFILE, false));
			}
		} finally {
			this.syncingCollapse = false;
		}
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

class SessionListItem extends AbstractDisposable {
	readonly domNode: HTMLElement;
	target: { readonly sessionId: string; readonly threadId: string; } | undefined;
	private readonly button: HTMLButtonElement;
	private readonly actions: ActionBar;
	private readonly row: SessionListRowRenderer;
	private readonly label: HTMLSpanElement;
	private readonly pullRequest: HTMLSpanElement;
	children: readonly HTMLElement[] = [];
	private readonly statusAnnouncement: HTMLSpanElement;
	private managementDescription: string | undefined;
	private pullRequestDescription = '';
	private readonly summaryHover = new MutableDisposable<IManagedHover>();
	private summaryText: string | undefined;
	private open: () => void = () => { };
	private readonly clickListener;
	private readonly contextListeners;
	private contextMenu: ((anchor: ContextMenuAnchor) => void) | undefined;

	describe(children: readonly ISessionsListTreeNode[]): ISessionsListTreeNode {
		const id = this.domNode.dataset.item!;
		const kind = id.startsWith('session:') ? 'session' : id.startsWith('chat:') ? 'chat' : id.startsWith('project:') ? 'project' : 'draft';
		return {
			id, kind, label: this.label.textContent ?? '', ...this.target,
			...(children.length ? { children } : {})
		};
	}

	constructor(ownerDocument: Document, icon?: ThemeIcon, readonly leadingIcon?: SessionLeadingIcon) {
		super();
		this.row = new SessionListRowRenderer(ownerDocument, leadingIcon?.element);
		this.domNode = this.row.element;
		this.button = this.row.button;
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
		this.statusAnnouncement = h(ownerDocument, 'span', {
			className: 'ash-aria-live',
			attributes: { 'aria-live': 'polite' },
		});
		this.domNode.append(this.statusAnnouncement);
		this.pullRequest = h(ownerDocument, 'span');
		this.pullRequest.className = 'ash-sessions-list-pr';
		this.pullRequest.setAttribute('aria-hidden', 'true');
		this.pullRequest.hidden = true;
		if (icon && !leadingIcon) appendIcon(icon, this.button);
		// Keep attention metadata clear of the trailing hover actions.
		this.button.append(this.pullRequest, this.label);
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
		this.leadingIcon?.setTitle(title);
		const state = sessionManagementLabel(management);
		const icon = management && managementIcons[management.status];
		this.leadingIcon?.setStatus(state && icon ? {
			label: state, kind: management?.status === 'working' ? 'inProgress' : 'static', icon,
		} : undefined);
		if (this.statusAnnouncement.textContent !== (state ?? '')) this.statusAnnouncement.textContent = state ?? '';
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
		this.leadingIcon?.dispose();
		this.clickListener.dispose();
		this.actions.dispose();
		for (const listener of this.contextListeners) listener.dispose();
		this.row.dispose();
	}
}

export class SessionListSection extends AbstractDisposable {
	readonly domNode: HTMLElement;
	readonly button: HTMLButtonElement;
	children: readonly HTMLElement[] = [];
	private readonly label: HTMLElement;
	private readonly icon: HTMLElement;
	private readonly appearanceIcon: HTMLElement;
	private open: (() => void) | undefined;
	private contextMenu: ((anchor: ContextMenuAnchor) => void) | undefined;
	private readonly listeners: { dispose(): void; }[];

	get title(): string { return this.label.textContent ?? ''; }

	constructor(document: Document, key: string, private readonly subgroup: boolean, toggle: (collapsed?: boolean) => void) {
		super();
		this.domNode = h(document, 'section', { className: subgroup ? 'ash-sessions-list-subgroup' : 'ash-sessions-list-section' });
		this.domNode.dataset.section = key;
		sectionRenderers.set(this.domNode, this);
		const heading = h(document, 'h3');
		this.button = h(document, 'button', { className: 'ash-sessions-list-section-toggle' });
		this.button.type = 'button';
		this.icon = h(document, 'span', { className: 'ash-sessions-list-section-icon' });
		this.appearanceIcon = h(document, 'span', { className: 'ash-sessions-list-section-icon' });
		this.label = h(document, 'span', { className: 'ash-sessions-list-section-label' });
		this.button.append(...(subgroup ? [this.icon, this.label] : [this.label, this.icon]));
		heading.append(this.button);
		this.domNode.append(heading);
		this.listeners = [
			addDisposableListener(this.button, 'click', event => { event.stopPropagation(); if (this.open) this.open(); else toggle(); }),
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
				if (event.key === 'Enter' || event.key === ' ') { event.stopPropagation(); return; }
				if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
				event.preventDefault();
				event.stopPropagation();
				toggle(event.key === 'ArrowLeft');
			}),
		];
	}

	setContextMenu(menu: (anchor: ContextMenuAnchor) => void): void {
		this.contextMenu = menu;
		this.button.setAttribute('aria-haspopup', 'menu');
	}

	update(title: string, children: readonly HTMLElement[], options?: { readonly open?: () => void; readonly actionLabel?: string; readonly icon?: Icon; readonly color?: string; }): void {
		this.open = options?.open;
		this.label.textContent = title;
		this.button.title = options?.actionLabel ?? title;
		if (options?.actionLabel) this.button.setAttribute('aria-label', options.actionLabel);
		else this.button.removeAttribute('aria-label');
		this.children = children;
		const customIcon = options?.icon;
		const color = options?.color ?? '';
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
	}

	renderCollapse(collapsed: boolean): void {
		this.button.setAttribute('aria-expanded', String(!collapsed));
		const icon = this.subgroup ? collapsed ? Lxicon.folder : Lxicon.folderOpened : collapsed ? Lxicon.chevronRight : Lxicon.chevronDown;
		if (this.icon.firstElementChild?.getAttribute('data-ash-icon-id') !== icon.id) {
			this.icon.replaceChildren();
			appendIcon(icon, this.icon);
		}
	}

	protected override disposeCore(): void {
		for (const listener of this.listeners) listener.dispose();
		this.domNode.remove();
	}
}

export class SessionListRowRenderer extends Disposable {
	readonly element: HTMLElement;
	readonly button: HTMLButtonElement;

	constructor(document: Document, leading?: HTMLElement) {
		super();
		this.element = h(document, 'div', { className: 'ash-sessions-list-row' });
		this.button = h(document, 'button', { className: 'ash-sessions-list-item', attributes: { type: 'button' } });
		if (leading) {
			this.element.classList.add('has-leading-icon');
			this.element.append(leading);
		}
		this.element.append(this.button);
		// The tree owns navigation between rows. Embedded controls own activation within a row.
		this._register(addDisposableListener(this.element, 'click', event => event.stopPropagation()));
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
		}));
		this._register(toDisposable(() => this.element.remove()));
	}
}

/** Shared tree renderer for the retained controls supplied by each session sidebar. */
export class SessionsListTree extends WorkbenchObjectTree<HTMLElement> {
	constructor(container: HTMLElement, title: string, configurationService: IConfigurationService, scrolling: 'external' | 'managed' = 'external') {
		super(container, {
			configurationService,
			ariaLabel: title,
			accessibilityProvider: {
				getAriaLabel: element => {
					const title = element.querySelector('h3, .ash-sessions-list-item');
					return title?.getAttribute('aria-label') ?? title?.textContent ?? element.textContent ?? '';
				},
			},
			scrolling,
			expandOnDoubleClick: false,
			indent: 0,
			indentGuides: 'none',
			modelOptions: { identityProvider: { getId: SessionsListTree.id } },
			reuseRows: true,
			renderElement: element => element,
			renderTwistie: (element, state) => {
				if (element.dataset.section !== undefined) sectionRenderers.get(element)?.renderCollapse(!state.expanded);
			},
		});
		this.element.classList.add('ash-sessions-list-tree');
		this.element.tabIndex = -1;
	}

	static id(element: HTMLElement): string {
		return element.dataset.section === undefined ? element.dataset.item ?? element.className : `section:${element.dataset.section}`;
	}

	setSectionCollapsed(key: string, collapsed?: boolean): void {
		const id = `section:${key}`;
		const current = this.isCollapsed(id);
		if (current === undefined || current === collapsed) return;
		if (collapsed ?? !current) {
			const active = this.element.ownerDocument.activeElement;
			const section = this.getVisibleElements().find(element => element.dataset.section === key);
			this.collapse(id);
			if (active && !active.isConnected && section) this.focusRow(section, true);
		} else {
			this.expand(id);
		}
	}

	focusRow(row: HTMLElement, preventScroll = false): void {
		const target = row.isConnected ? row : this.getVisibleElements().find(element => element.dataset.section === row.dataset.parentSection);
		target?.querySelector<HTMLButtonElement>('.ash-sessions-list-item, .ash-sessions-list-section-toggle')?.focus({ preventScroll });
	}
}

const sectionRenderers = new WeakMap<HTMLElement, SessionListSection>();
