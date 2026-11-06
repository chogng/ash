import { IContextKeyService, type IScopedContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { SessionsMenuActiveConversationContext } from '../../../../common/contextkeys.js';
import { ISessionsListModelService, type ISessionsListTreeNode, type SessionGrouping } from '../../../../services/sessions/browser/sessionsListModelService.js';
import { Separator, SubmenuAction, type IAction } from '../../../../../base/common/actions.js';
import { ISessionSectionOrderService } from '../../../../services/sessions/browser/sessionSectionOrderService.js';
import * as chatInputStatePersistence from '../../../../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { MenuWorkbenchToolBar, WorkbenchToolBar } from '../../../../../platform/actions/browser/toolbar.js';
import { ISessionGroupsService, type SessionGroup } from '../../../../services/sessions/browser/sessionGroupsService.js';
import { CHANGE_SESSION_GROUP_APPEARANCE } from './sessionGroupAppearancePicker.js';
import '../media/sessionsList.css';
import { addDisposableListener, getWindow, h } from '../../../../../base/browser/dom.js';
import { observeResize } from '../../../../../base/browser/observer.js';
import { appendIcon, getRegisteredIcon } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { AbstractDisposable, Disposable, DisposableMap, type DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { MOVE_CHAT_TO_SESSION_ACTION_ID } from '../sessionsActions.js';
import { SessionActionFeedback } from '../sessionActionFeedback.js';
import { getSessionsListEntries } from './sessionsListFilters.js';
import { sessionListProjectActions, sessionProjectOrganization, sessionSortActions, type SessionListOrganization } from './sessionsListActions.js';
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
import { autorun, observableFromEvent, type IObservable } from '../../../../../base/common/observable.js';
import { IMenuService, SubmenuItemAction, type MenuId } from '../../../../../platform/actions/common/actions.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ICustomViewService } from '../../../../services/customView/browser/customViewService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IProjectService, type Project } from '../../../../../platform/projects/common/projectService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { WorkbenchObjectTree } from '../../../../../platform/list/browser/listService.js';
import { defaultListStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import type { ObjectTreeElement, ObjectTreeNode } from '../../../../../base/browser/ui/tree/objectTreeModel.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ContextMenuAnchor } from '../../../../../base/browser/contextmenu.js';
import { Menus } from '../../../../browser/menus.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { basename, extUriBiasedIgnorePathCase } from '../../../../../base/common/resources.js';
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
import { DragAndDropDataKind } from '../../../../../base/browser/ui/dnd/dnd.js';
import { ObjectTreeElementCollapseState, type TreeDragAndDrop, type TreeDragData } from '../../../../../base/browser/ui/tree/tree.js';
import type { URI } from '../../../../../base/common/uri.js';

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

const quietSessionIcon = Lxicon.circle;
const codeManagementIcons: typeof managementIcons = {
	...managementIcons,
	completed: quietSessionIcon,
	stopped: quietSessionIcon,
};

export type SessionsListPresentation = 'chat' | 'code' | { readonly openCommand: string; readonly activeContext: string; };

interface SessionsListDragOptions {
	organization(element: HTMLElement): SessionListOrganization | undefined;
	reference?(element: HTMLElement): URI | undefined;
	canReorder?(element: HTMLElement): boolean;
	reorder?(source: HTMLElement, target: HTMLElement): (() => void) | undefined;
	didMove?(source: HTMLElement, target: HTMLElement, from: string | undefined): void;
	onError(error: unknown): void;
}

class SessionsListDragAndDrop extends Disposable implements TreeDragAndDrop<HTMLElement> {
	private readonly referenceDrag = this._register(new MutableDisposable());

	constructor(document: Document, private readonly options: SessionsListDragOptions) {
		super();
		// A composer can consume the drag and cause the source row to be removed.
		this._register(addDisposableListener(document, 'dragend', () => this.referenceDrag.clear(), true));
	}

	getDragURI(element: HTMLElement): string | undefined {
		const reference = this.options.reference?.(element);
		if (reference) return reference.toString();
		const organization = this.options.organization(element);
		if (organization?.setPinned || organization?.project || organization?.moveToGroup || this.options.canReorder?.(element)) {
			return `ash-session-list:${encodeURIComponent(SessionsListTree.id(element))}`;
		}
	}

	onDragStart(data: TreeDragData<HTMLElement>, event: DragEvent): void {
		this.referenceDrag.clear();
		if (data.kind !== DragAndDropDataKind.Internal || !event.dataTransfer) return;
		const element = data.elements[0];
		if (!element) return;
		const reference = this.options.reference?.(element);
		if (reference) {
			this.referenceDrag.value = fillChatReferenceDragData(event.dataTransfer, reference);
			event.dataTransfer.effectAllowed = this.options.organization(element) ? 'copyMove' : 'copy';
		} else {
			event.dataTransfer.clearData('text/uri-list');
			event.dataTransfer.setData('application/x-ash-session-order', '');
			event.dataTransfer.effectAllowed = 'move';
		}
	}

	onDragOver(data: TreeDragData<HTMLElement>, target: HTMLElement | undefined): boolean {
		return !!this.operation(data, target);
	}

	drop(data: TreeDragData<HTMLElement>, target: HTMLElement | undefined): void {
		const run = this.operation(data, target);
		if (!run || !target || data.kind !== DragAndDropDataKind.Internal) return;
		const source = data.elements[0]!;
		const from = source.dataset.parentSection;
		try {
			void Promise.resolve(run()).then(() => this.options.didMove?.(source, target, from), this.options.onError);
		} catch (error) {
			this.options.onError(error);
		}
	}

	private operation(data: TreeDragData<HTMLElement>, target: HTMLElement | undefined): (() => void | Promise<void>) | undefined {
		if (data.kind !== DragAndDropDataKind.Internal || !target) return;
		const source = data.elements[0];
		if (!source?.isConnected || source === target) return;
		const reorder = this.options.reorder?.(source, target);
		if (reorder) return reorder;
		const item = this.options.organization(source);
		if (!item) return;
		const project = item.project;
		const destination = target.dataset.projectId ?? target.dataset.parentProjectId;
		const from = source.dataset.parentSection;
		const leavingPinned = from === 'pinned' && !source.dataset.parentProjectId && item.pinned;
		if (destination) {
			if (!project?.destinations.some(({ id }) => id === destination)) return;
			if (project.current === destination) {
				if (leavingPinned && item.setPinned) return () => item.setPinned!(false);
				return;
			}
			return async () => {
				await project.move(destination);
				if (leavingPinned) await item.setPinned?.(false);
			};
		}
		const section = target.dataset.section ?? target.dataset.parentSection;
		if (section === from) return;
		if (section === 'pinned' && item.setPinned) return () => item.setPinned!(true);
		if (section === 'recent') {
			if (leavingPinned && item.setPinned) return () => item.setPinned!(false);
			if (project?.current && source.dataset.parentProjectId) return () => project.move(undefined);
			if (from?.startsWith('workspace:')) return;
			if (item.moveToGroup) return () => item.moveToGroup!(null);
		}
		if (section?.startsWith('group:') && target.dataset.groupDropTarget === 'true' && item.moveToGroup) {
			return async () => {
				await item.moveToGroup!(section.slice('group:'.length));
				if (item.pinned) await item.setPinned?.(false);
			};
		}
	}
}

/** Session picker owned by the dedicated Sessions Workbench sidebar. */
export class SessionsList extends DomWidget {
	private readonly mode: 'chat' | 'code';
	private readonly entry: Exclude<SessionsListPresentation, string> | undefined;
	private readonly search: SessionsListSearch;
	private readonly tree: SessionsListTree;
	private readonly feedback = this._register(new SessionActionFeedback());
	private readonly rowMenuContext = this._register(new MutableDisposable<IScopedContextKeyService>());
	readonly domNode: HTMLElement;
	readonly loading: IObservable<boolean>;
	private readonly list: HTMLDivElement;
	private readonly createListToolbar: (container: HTMLElement, disposables: DisposableStore) => MenuWorkbenchToolBar;
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
		this.loading = observableFromEvent(this, sessionService.onDidChange, () => sessionService.state === 'loading' && sessionService.sessions.length > 0);
		const ownerDocument = container.ownerDocument;
		this.domNode = h(ownerDocument, 'section');
		this.domNode.className = 'ash-sessions-list';
		this.domNode.tabIndex = -1;
		this.domNode.dataset.mode = mode;
		const config = configuration ?? this._register(new InMemoryConfigurationService());
		// Embedded Sessions shares Chat's viewport with the conversation history.
		this.tree = this._register(new SessionsListTree(this.domNode, title, config, mode, this.entry ? 'external' : 'managed', {
			organization: element => this.getOrganization(element),
			reference: element => {
				const target = this.items.get(element.dataset.item ?? '')?.target;
				return target && LocalChatSessionUri.forSession(target.sessionId, target.threadId);
			},
			canReorder: element => !!element.dataset.sectionOrderId,
			reorder: (source, target) => {
				const attribute = source.dataset.rowOrderId ? 'rowOrderId' : 'sectionOrderId';
				const id = target.dataset[attribute];
				if (source.dataset[attribute] && id && this.parentOf(source) === this.parentOf(target)) {
					return () => this.moveOrderedItem(source, attribute, id);
				}
			},
			didMove: (source, target, from) => {
				const id = target.dataset.rowOrderId;
				if (id && source.dataset.rowOrderId && source.dataset.parentSection !== from && this.parentOf(source) === this.parentOf(target)) {
					this.moveOrderedItem(source, 'rowOrderId', id);
				}
			},
			onError: error => this.notifications.error(toErrorMessage(error)),
		}));
		this.list = this.tree.domNode;
		this.list.classList.add('ash-sessions-list-items');
		if (mode === 'code') {
			this._register(this.tree.onDidChangeSelection(({ browserEvent }) => {
				// The active conversation owns selection. Tree input can still move focus.
				if (browserEvent) this.syncTreeSelection();
			}));
		}
		this._register(this.tree.onDidChangeCollapseState(({ element, collapsed }) => {
			const key = element.dataset.section;
			if (key === undefined || this.search.hasQuery) return;
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
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(addDisposableListener(this.list, 'keydown', event => {
			if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
			const buttons = [...this.list.querySelectorAll<HTMLButtonElement>('button:not(.ash-session-leading-icon button, .ash-sessions-list-more button)')]
				.filter(button => !button.closest('[hidden]'));
			const index = buttons.indexOf(ownerDocument.activeElement as HTMLButtonElement);
			if (index < 0) return;
			event.preventDefault();
			event.stopPropagation();
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
			buttons[next]?.focus();
		}, true));
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
		const menuContext = contextKeys && this._register(contextKeys.createScoped(this.domNode));
		this.createListToolbar = (container, disposables) => createSessionsListToolbar(
			container, disposables, menus, contextMenus, notifications, menuContext,
			Menus.SidebarSessionsHeader, Menus.SessionsViewFilter, actions => this.getFilterActions(actions),
		);
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

	private getFilterActions(contributed: readonly IAction[]): readonly IAction[] {
		const model = this.listModel;
		const choice = (id: string, label: string, checked: boolean, run: () => void): IAction => ({ id, label, tooltip: '', enabled: true, checked, run });
		const group = (value: SessionGrouping, label: string): IAction =>
			choice(`sessions.list.groupBy.${value}`, label, model.grouping === value, () => model.setGrouping(value));
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
			new SubmenuAction('sessions.list.sortBy', localize('sessions.list.sortBy', 'Sort By'), sessionSortActions(model, this.mode)),
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
		}], [...contributed]);
	}

	focus(): void {
		const firstItem = this.list.querySelector<HTMLButtonElement>('button:not(.ash-session-leading-icon button)');
		(firstItem ?? this.domNode).focus();
	}

	public getViewState(): { readonly top: number; readonly focus: string | undefined; } {
		const active = this.domNode.ownerDocument.activeElement;
		const item = [...this.items].find(([, item]) => item.domNode.contains(active));
		const section = [...this.sections].find(([, section]) => section.button === active);
		return { top: this.tree.scrollTop, focus: section ? `section:${section[0]}` : item?.[0] };
	}

	public closeIconPickers(): void {
		for (const [, item] of this.items) { item.leadingIcon?.closePicker(); }
	}

	public restoreViewState(state: ReturnType<SessionsList['getViewState']>): void {
		this.render();
		this.tree.scrollTop = state.top;
		if (state.focus) {
			const row = this.tree.model.getElement(state.focus);
			if (row) this.tree.focusRow(row, true);
		}
	}

	private async loadProjects(): Promise<void> {
		const generation = ++this.projectLoad;
		this.projectsLoading = true;
		this.render();
		try {
			const summaries = await this.projectService.list(this.mode);
			const projects = await Promise.all(summaries.filter(project => !project.archived).map(project => this.projectService.read(project.id, this.mode)));
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

	private getOrganization(element: HTMLElement): SessionListOrganization | undefined {
		const id = element.dataset.rowOrderId;
		if (!id) return;
		const session = this.sessionService.sessions.find(candidate => candidate.sessionId === id && candidate.status === 'active');
		if (!session) return;
		const memberships = this.projects.filter(project => project.sessionIds.includes(id));
		const current = element.dataset.parentProjectId ?? (memberships.length === 1 ? memberships[0]!.id : undefined);
		return {
			pinned: this.listModel.isSessionPinned(session),
			setPinned: pinned => pinned ? this.listModel.pinSession(session) : this.listModel.unpinSession(session),
			moveToGroup: group => this.groups.move(id, group),
			project: session.backendSessionId ? undefined : sessionProjectOrganization(this.projectService, id, current, this.projects),
		};
	}

	private moveOrderedItem(element: HTMLElement, attribute: 'rowOrderId' | 'sectionOrderId', targetId: string): void {
		const parent = this.parentOf(element);
		const id = element.dataset[attribute];
		if (!id) return;
		const ids = this.orderedSiblingIds(parent, attribute);
		if (attribute === 'rowOrderId') {
			const section = parent?.element.dataset.section ?? '';
			this.listModel.moveSession(this.mode, section, ids, id, targetId);
		} else {
			this.sectionOrder.reorder(this.mode, ids, id, targetId);
		}
	}

	private parentOf(element: HTMLElement): ObjectTreeNode<HTMLElement> | undefined {
		return this.tree.model.getParent(SessionsListTree.id(element));
	}

	private orderedSiblingIds(parent: ObjectTreeNode<HTMLElement> | undefined, attribute: 'rowOrderId' | 'sectionOrderId'): string[] {
		return (parent?.children ?? this.tree.model.rootNodes).flatMap(({ element }) => {
			const id = element.dataset[attribute];
			return id ? [id] : [];
		});
	}

	private orderActions(element: HTMLElement, kind: 'row' | 'section'): IAction[] {
		const attribute = kind === 'row' ? 'rowOrderId' : 'sectionOrderId';
		const id = element.dataset[attribute];
		const parent = this.parentOf(element);
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
		const project = this.getOrganization(item.domNode)?.project;
		if (project && (project.current || project.destinations.length)) {
			sessionActions.push(...sessionListProjectActions(project, project.destinations, async run => {
				try {
					await run();
					if (!this.isDisposed) this.tree.focusRow(item.domNode);
				} catch (error) { this.notifications.error(toErrorMessage(error)); }
			}));
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
		const read = (nodes: readonly ObjectTreeNode<HTMLElement>[]): ISessionsListTreeNode[] => nodes.flatMap(node => {
			const { element } = node;
			const children = read(node.children);
			const key = element.dataset.section;
			if (key !== undefined) {
				return [{
					id: key, kind: element.dataset.projectId === undefined ? 'section' : 'project', label: this.sections.get(key)!.title,
					collapsed: node.collapsed, children,
				}];
			}
			const item = this.items.get(element.dataset.item ?? '');
			return item ? [item.describe(children)] : [];
		});
		return read(this.tree.model.rootNodes);
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
		const focusedRow = focused?.closest<HTMLElement>('[data-section], [data-item]');
		const present = new Set<string>();
		const activeSections = new Set<string>();
		const pinned: HTMLElement[] = [];
		const recent: HTMLElement[] = [];
		const remaining = new Map<string, HTMLElement>();
		const childrenByRow = new Map<HTMLElement, readonly HTMLElement[]>();
		const activeSelection = this.customViews.activeCustomView.get() || this.entry && !this.contextKeys?.getValue(this.entry.activeContext)
			? undefined : this.viewService.activeSelection;
		const restingIcon = this.mode === 'code' ? quietSessionIcon : undefined;
		const statusIcons = this.mode === 'code' ? codeManagementIcons : managementIcons;
		const itemFor = (key: string, kind: 'conversation' | 'draft' | 'project', icon = restingIcon): SessionListItem => {
			present.add(key);
			let item = this.items.get(key);
			if (!item) {
				const leading = kind === 'conversation' && this.instantiation
					? this.instantiation.createInstance(SessionLeadingIcon, ownerDocument, '',
						(picked: Icon | undefined) => this.listModel.setRowIcon(key, picked?.id))
					: undefined;
				item = this.items.set(key, new SessionListItem(ownerDocument, this.contextMenus, statusIcons, kind, icon, leading));
			}
			item.domNode.dataset.item = key;
			if (item.leadingIcon) {
				const customId = this.listModel.getRowIcon(key);
				item.leadingIcon.setRestingIcon((customId ? getRegisteredIcon(customId, ownerDocument) : undefined) ?? icon);
			}
			return item;
		};
		const sectionFor = (key: string, title: string, children: readonly HTMLElement[], kind: SessionListSectionKind = 'section', open?: () => void, group?: SessionGroup): HTMLElement => {
			activeSections.add(key);
			const section = this.sections.get(key) ?? this.sections.set(key, new SessionListSection(ownerDocument, key, kind,
				collapsed => this.tree.setSectionCollapsed(key, collapsed), key === 'projects' ? this.createListToolbar : undefined));
			childrenByRow.set(section.domNode, reorderChildren(children, ids => this.listModel.getSessionOrder(this.mode, key, ids), 'rowOrderId'));
			section.update(title, {
				open,
				actionLabel: open ? localize('sessions.list.openComparison', 'Open comparison {0}', title) : undefined,
				icon: group?.icon ? getRegisteredIcon(group.icon, ownerDocument) : undefined,
				color: group?.color ? `var(${colorCssVariable(group.color)})` : undefined,
			});
			if (group) {
				section.domNode.dataset.sectionOrderId = key;
				section.domNode.dataset.groupDropTarget = String(group.kind !== 'comparison');
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
			const item = itemFor(`untitled:${session.untitledSessionId}`, 'draft');
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
		const catalog = getSessionsListEntries(this.sessionService.sessions.filter(session => session.surface !== 'chat'), this.listModel, this.mode,
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
			const item = itemFor(`session:${session.sessionId}`, 'conversation', restingIcon ?? Lxicon.cowork);
			item.target = { sessionId: session.sessionId, threadId: thread.threadId };
			item.update(session.title || localize('sessions.list.untitled', 'Untitled Session'), current?.threadId === thread.threadId, () => this.openRow(() => this.viewService.openSession(session.sessionId, thread.threadId)), session.management);
			item.setContextMenu(anchor => this.showItemMenu({ kind: 'session', active: { session, threadId: thread.threadId } }, item, anchor));
			item.updatePullRequests(getHighestPriorityPullRequestIcon(requests.map(request => request.icon)), requests.map(getPullRequestLabel).join('\n'));
			item.updateSummary(this.hoverService, getSessionSummaryHoverData(session, thread));
			const children = nested.map(chat => {
				const child = itemFor(`chat:${JSON.stringify([session.sessionId, chat.threadId])}`, 'conversation', restingIcon ?? Lxicon.chatSession);
				child.target = { sessionId: session.sessionId, threadId: chat.threadId };
				child.update(chat.title || localize('sessions.list.untitledChat', 'Untitled Chat'), current?.threadId === chat.threadId,
					() => this.openRow(() => this.viewService.openSession(session.sessionId, chat.threadId)), chat.management);
				child.updateSummary(this.hoverService, getSessionSummaryHoverData(session, chat));
				child.setContextMenu(anchor => this.showItemMenu({ kind: 'session', active: { session, threadId: chat.threadId } }, child, anchor));
				return child.domNode;
			});
			childrenByRow.set(item.domNode, [...children, ...(nestedDrafts.get(session.sessionId) ?? [])]);
			item.domNode.dataset.rowOrderId = session.sessionId;
			if (this.listModel.isSessionPinned(session)) pinned.push(item.domNode);
			else remaining.set(session.sessionId, item.domNode);
		}
		const projects: HTMLElement[] = [];
		let hasProjectConversations = false;
		const chatGroups: HTMLElement[] = [];
		for (const project of this.projects) {
			const members = this.mode === 'code' ? project.sessionIds.flatMap(id => {
				const item = remaining.get(id);
				if (!item) return [];
				remaining.delete(id);
				return [item];
			}) : [];
			hasProjectConversations ||= members.length > 0;
			const drafts = projectDrafts.get(project.id) ?? [];
			if (!members.length && !drafts.length && !this.search.matches(project.name)) continue;
			const key = `project:${project.id}`;
			if (this.mode === 'code') {
				const section = sectionFor(key, project.name, [...members, ...drafts], 'project');
				section.dataset.projectId = project.id;
				projects.push(section);
			} else {
				const item = itemFor(key, 'project', Lxicon.projects);
				item.domNode.dataset.projectId = project.id;
				item.update(project.name, false, () => { void this.commands.executeCommand('sessions.open.projects', project.id).catch(error => this.notifications.error(String(error))); });
				projects.push(item.domNode);
			}
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
			(this.mode === 'code' ? recent : chatGroups).push(sectionFor(`group:${group.sectionId}`, group.name, members, this.mode === 'code' ? 'subgroup' : 'section',
				group.kind === 'comparison' ? () => { void this.openComparison(group.sessionIds); } : undefined, group));
		}
		const orderedRecent = reorderChildren(recent, ids => this.sectionOrder.getOrder(this.mode, ids), 'sectionOrderId');
		const grouping = this.listModel.grouping;
		if (this.mode === 'code' && (grouping === 'none' || grouping === 'projects')) {
			// Saved sessions can have a creation workspace without a Code project membership.
			// Use the Session workspace so managed checkouts of the same folder stay together.
			const workspaces = new Map<string, { readonly label: string; readonly rows: HTMLElement[]; }>();
			for (const session of catalog) {
				const row = remaining.get(session.sessionId);
				if (!row || !session.workspace) continue;
				const resource = sessionWorkspaceUri(session.workspace);
				const path = resource.toEncodedComponents().path.replace(/\/+$/u, '') || '/';
				const key = extUriBiasedIgnorePathCase.getComparisonKey(resource.withEncodedPath(path));
				let workspace = workspaces.get(key);
				if (!workspace) {
					workspace = { label: basename(resource) || session.workspace.root, rows: [] };
					workspaces.set(key, workspace);
				}
				workspace.rows.push(row);
				remaining.delete(session.sessionId);
			}
			for (const [key, workspace] of [...workspaces].sort((left, right) => left[1].label.localeCompare(right[1].label))) {
				projects.push(sectionFor(`workspace:${key}`, workspace.label, workspace.rows, 'project'));
			}
			hasProjectConversations ||= workspaces.size > 0;
		}
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
				orderedRecent.push(sectionFor(`grouping:${grouping}:${id}`, bucket.label, bucket.rows, 'subgroup'));
			}
		}
		const showEmpty = orderedRecent.length === 0 && pinned.length === 0 && chatGroups.length === 0 && !hasProjectConversations;
		const loading = this.sessionService.state === 'loading';
		this.tree.element.setAttribute('aria-busy', String(loading || this.projectsLoading));
		const emptyStatus = loading ? localize('sessions.list.loading', 'Loading sessions…') : this.sessionService.error
			?? (this.search.hasQuery ? localize({ bundle: 'ash.sessions', key: 'sessions.list.searchEmpty' }, 'No matching sessions.') : undefined);
		if (showEmpty && emptyStatus) { this.empty.textContent = emptyStatus; }
		const ordered: HTMLElement[] = [];
		if (pinned.length) ordered.push(sectionFor('pinned', localize('sessions.list.pinned', 'Pinned'), pinned));
		ordered.push(sectionFor('projects', localize('projects.title', 'Projects'), projects));
		ordered.push(...reorderChildren(chatGroups, ids => this.sectionOrder.getOrder(this.mode, ids), 'sectionOrderId'));
		if (orderedRecent.length || !this.search.hasQuery && (pinned.length || hasProjectConversations)) {
			ordered.push(sectionFor('recent', this.mode === 'chat' ? localize('sessions.list.chats', 'Chats') : localize('sessions.list.recents', 'Recents'), orderedRecent));
		}
		if (showEmpty && emptyStatus) ordered.push(this.empty);
		// Keep filtered rows available so closing search can restore the original focus target.
		if (!this.search.hasQuery) {
			for (const key of this.items.keys()) if (!present.has(key)) this.items.deleteAndDispose(key);
			for (const key of this.sections.keys()) if (!activeSections.has(key)) this.sections.deleteAndDispose(key);
		}
		const project = (element: HTMLElement, parent?: ObjectTreeElement<HTMLElement>): ObjectTreeElement<HTMLElement> => {
			const key = element.dataset.section;
			const children: ObjectTreeElement<HTMLElement>[] = [];
			const rowChildren = childrenByRow.get(element) ?? [];
			const projectSection = key === 'projects' || element.dataset.projectId !== undefined;
			const collapsible = key !== undefined && (!projectSection || rowChildren.length > 0);
			let collapsed: ObjectTreeElementCollapseState | undefined;
			if (key !== undefined && collapsible) {
				const saved = this.storage.getBoolean(this.collapseKey(key), StorageScope.PROFILE, false);
				collapsed = saved && !this.search.hasQuery ? ObjectTreeElementCollapseState.Collapsed : ObjectTreeElementCollapseState.Expanded;
			}
			const branch = { element, children, collapsible, collapsed };
			const parentProject = parent?.element.dataset.projectId;
			const projectId = parentProject ?? parent?.element.dataset.parentProjectId;
			if (projectId) element.dataset.parentProjectId = projectId;
			else delete element.dataset.parentProjectId;
			const groupDropTarget = parent?.element.dataset.groupDropTarget;
			if (key === undefined) {
				if (groupDropTarget) element.dataset.groupDropTarget = groupDropTarget;
				else delete element.dataset.groupDropTarget;
			}
			if (parent) {
				const { section, parentSection } = parent.element.dataset;
				element.dataset.parentSection = (parentProject === undefined ? section : undefined) ?? parentSection ?? '';
			} else delete element.dataset.parentSection;
			for (const child of rowChildren) children.push(project(child, branch));
			return branch;
		};
		this.tree.setChildren(ordered.map(element => project(element)));
		if (this.mode === 'code') this.syncTreeSelection();
		if (focused?.isConnected && !focused.closest('[hidden]') && ownerDocument.activeElement !== focused) focused.focus({ preventScroll: true });
		else if (focusedRow && !focusedRow.isConnected && this.tree.model.has(SessionsListTree.id(focusedRow))) this.tree.focusRow(focusedRow, true);
	}

	private syncTreeSelection(): void {
		const current = this.tree.getVisibleElements().find(element => element.classList.contains('selected'));
		this.tree.setSelection(current ? [SessionsListTree.id(current)] : []);
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

/** Shared Projects header controls for the conversation catalogs. */
export function createSessionsListToolbar(container: HTMLElement, disposables: DisposableStore, menus: IMenuService,
	contextMenus: IContextMenuService, notifications: INotificationService, contextKeys: IContextKeyService | undefined,
	menuId: MenuId, submenu: MenuId, getActions: (contributed: readonly IAction[]) => readonly IAction[]): MenuWorkbenchToolBar {
	const toolbar = disposables.add(new MenuWorkbenchToolBar(container, menus, contextMenus, menuId, {
		ariaLabel: localize('sessions.list.headerActions', 'Sessions List Actions'),
		contextKeyService: contextKeys,
		// The popup reads list state even when the submenu has no registered commands.
		menuOptions: { preserveEmptySubmenus: true },
		actionViewItemProvider: (action, options) => {
			if (!(action instanceof SubmenuItemAction) || action.item.submenu !== submenu) {
				return undefined;
			}
			return new DropdownMenuActionViewItem(
				action,
				() => getActions(action.actions),
				{
					showContextMenu: delegate => contextMenus.showContextMenu({
						...delegate,
						getMenuClassName: () => 'ash-sessions-list-menu',
						submenuClassName: 'ash-sessions-list-menu',
						getCheckedActionsRepresentation: item => item.id.startsWith('sessions.list.groupBy.') || item.id.startsWith('sessions.list.sort') ? 'radio' : 'checkbox',
					}),
				},
				{ ...options, iconOnly: true },
			);
		},
	}));
	disposables.add(toolbar.actionRunner.onDidRun(({ action, error }) => {
		if (action.id === 'sessionsViewPane.createGroup' && error !== undefined) {
			notifications.error(toErrorMessage(error));
		}
	}));
	toolbar.element.classList.add('ash-sessions-list-more');
	// Toolbar inputs stay within the header without activating tree rows.
	disposables.add(addDisposableListener(toolbar.element, 'click', event => event.stopPropagation()));
	disposables.add(addDisposableListener(toolbar.element, 'keydown', event => {
		if (['Enter', ' ', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(event.key)) {
			event.stopPropagation();
		}
	}));
	return toolbar;
}

class SessionListItem extends AbstractDisposable {
	readonly domNode: HTMLElement;
	target: { readonly sessionId: string; readonly threadId: string; } | undefined;
	private readonly button: HTMLButtonElement;
	private readonly actions: WorkbenchToolBar;
	private readonly row: SessionListRowRenderer;
	private readonly pullRequest: HTMLSpanElement;
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
			id, kind, label: this.row.title, ...this.target,
			...(children.length ? { children } : {})
		};
	}

	constructor(ownerDocument: Document, contextMenus: IContextMenuService, private readonly statusIcons: typeof managementIcons,
		kind: 'conversation' | 'draft' | 'project', icon?: ThemeIcon, readonly leadingIcon?: SessionLeadingIcon,
	) {
		super();
		this.row = new SessionListRowRenderer(ownerDocument, kind === 'project' ? 'static' : 'scrollOnHover', leadingIcon?.element);
		this.domNode = this.row.element;
		this.button = this.row.button;
		this.actions = new WorkbenchToolBar(this.domNode, contextMenus, {
			ariaLabel: localize('sessions.list.actions', 'Chat actions'),
		});
		this.actions.setActions([{
			id: 'sessions.list.more', label: localize('sessions.list.more', 'More actions'),
			tooltip: localize('sessions.list.more', 'More actions'), icon: Lxicon.ellipsis, enabled: true,
			run: () => this.contextMenu?.(this.actions.element),
		}]);
		this.actions.element.classList.add('ash-sessions-list-actions');
		this.actions.element.hidden = true;
		this.actions.element.querySelector('button')?.setAttribute('aria-haspopup', 'menu');
		this.statusAnnouncement = h(ownerDocument, 'span', {
			className: 'ash-aria-live',
			attributes: { 'aria-live': 'polite' },
		});
		this.domNode.append(this.statusAnnouncement);
		this.pullRequest = h(ownerDocument, 'span');
		this.pullRequest.className = 'ash-sessions-list-pr';
		this.pullRequest.setAttribute('aria-hidden', 'true');
		this.pullRequest.hidden = true;
		// Keep attention metadata clear of the trailing hover actions.
		this.button.prepend(this.pullRequest);
		if (icon && !leadingIcon) {
			this.button.prepend(appendIcon(icon, this.button));
		}
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
		this.row.setTitle(title);
		this.leadingIcon?.setTitle(title);
		const state = sessionManagementLabel(management);
		const icon = management && this.statusIcons[management.status];
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
		const parts = [this.row.title, this.managementDescription, this.pullRequestDescription].filter(Boolean);
		if (!this.summaryHover.value) this.button.title = parts.join('\n');
		this.button.setAttribute('aria-label', parts.join('. '));
	}

	updateSummary(hoverService: IHoverService | undefined, metadata: readonly string[]): void {
		if (!hoverService) return;
		const title = this.row.title;
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

type SessionListSectionKind = 'section' | 'subgroup' | 'project';

export class SessionListSection extends Disposable {
	readonly domNode: HTMLElement;
	readonly button: HTMLButtonElement;
	readonly toolbar: MenuWorkbenchToolBar | undefined;
	private readonly heading: HTMLElement;
	private readonly label: HTMLElement;
	private readonly icon: HTMLElement;
	private readonly appearanceIcon: HTMLElement;
	private open: (() => void) | undefined;
	private contextMenu: ((anchor: ContextMenuAnchor) => void) | undefined;

	private get subgroup(): boolean { return this.kind !== 'section'; }
	get title(): string { return this.label.textContent ?? ''; }
	get rowClassName(): string { return this.subgroup ? 'ash-sessions-list-subgroup-row' : 'ash-sessions-list-section-row'; }

	constructor(document: Document, key: string, private readonly kind: SessionListSectionKind, toggle: (collapsed?: boolean) => void,
		createToolbar?: (container: HTMLElement, disposables: DisposableStore) => MenuWorkbenchToolBar) {
		super();
		this.domNode = h(document, 'section', { className: this.subgroup ? 'ash-sessions-list-subgroup' : 'ash-sessions-list-section' });
		this.domNode.dataset.section = key;
		collapseRenderers.set(this.domNode, this);
		this.heading = h(document, 'h3');
		this.button = h(document, 'button', { className: 'ash-sessions-list-section-toggle' });
		this.button.type = 'button';
		this.icon = h(document, 'span', { className: 'ash-sessions-list-section-icon' });
		if (kind === 'project') this.icon.classList.add('ash-sessions-list-project-icon');
		this.appearanceIcon = h(document, 'span', { className: 'ash-sessions-list-section-icon' });
		this.label = h(document, 'span', { className: 'ash-sessions-list-section-label' });
		this.button.append(...(this.subgroup ? [this.icon, this.label] : [this.label, this.icon]));
		this.heading.append(this.button);
		this.domNode.append(this.heading);
		if (createToolbar) {
			this.domNode.classList.add('ash-sessions-list-section-with-actions');
			this.toolbar = createToolbar(this.domNode, this._store);
		}
		this._register(addDisposableListener(this.button, 'click', event => { event.stopPropagation(); if (this.open) this.open(); else toggle(); }));
		this._register(addDisposableListener(this.button, 'contextmenu', event => {
			if (!this.contextMenu) return;
			event.preventDefault();
			this.contextMenu({ x: event.clientX, y: event.clientY, targetWindow: getWindow(this.button) });
		}));
		this._register(addDisposableListener(this.button, 'keydown', event => {
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
		}));
	}

	setContextMenu(menu: (anchor: ContextMenuAnchor) => void): void {
		this.contextMenu = menu;
		this.button.setAttribute('aria-haspopup', 'menu');
	}

	update(title: string, options?: { readonly open?: () => void; readonly actionLabel?: string; readonly icon?: Icon; readonly color?: string; }): void {
		this.open = options?.open;
		this.label.textContent = title;
		this.button.title = options?.actionLabel ?? title;
		if (options?.actionLabel) this.button.setAttribute('aria-label', options.actionLabel);
		else this.button.removeAttribute('aria-label');
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

	renderCollapse(collapsed: boolean, collapsible: boolean): void {
		if (!collapsible) {
			if (this.label.parentElement !== this.heading) {
				this.heading.classList.add('ash-sessions-list-section-static');
				this.heading.replaceChildren(...(this.subgroup ? [this.icon, this.label] : [this.label]));
			}
			if (!this.subgroup) return;
		} else {
			if (this.button.parentElement !== this.heading) {
				this.button.append(...(this.subgroup ? [this.icon, this.label] : [this.label, this.icon]));
				this.heading.replaceChildren(this.button);
				this.heading.classList.remove('ash-sessions-list-section-static');
			}
			this.button.setAttribute('aria-expanded', String(!collapsed));
		}
		const chevron = collapsed ? Lxicon.chevronRight : Lxicon.chevronDown;
		const icon = this.subgroup ? (collapsed ? Lxicon.folder : Lxicon.folderOpened) : chevron;
		if (this.icon.firstElementChild?.getAttribute('data-ash-icon-id') !== icon.id) {
			this.icon.replaceChildren();
			appendIcon(icon, this.icon);
			if (this.kind === 'project') {
				appendIcon(chevron, this.icon).classList.add('ash-sessions-list-project-chevron');
			}
		}
	}

	protected override disposeCore(): void {
		super.disposeCore();
		this.domNode.remove();
	}
}

export class SessionListRowRenderer extends Disposable {
	readonly element: HTMLElement;
	readonly button: HTMLButtonElement;
	private readonly titleText: HTMLSpanElement;
	private readonly titleViewport: HTMLSpanElement;
	private readonly titleResize = this._register(new MutableDisposable());

	constructor(document: Document, titleBehavior: 'static' | 'scrollOnHover', leading?: HTMLElement) {
		super();
		this.element = h(document, 'div', { className: 'ash-sessions-list-row' });
		this.button = h(document, 'button', { className: 'ash-sessions-list-item', attributes: { type: 'button' } });
		this.titleViewport = h(document, 'span', { className: 'ash-sessions-list-label' });
		this.titleText = titleBehavior === 'scrollOnHover' ? h(document, 'span') : this.titleViewport;
		if (titleBehavior === 'scrollOnHover') {
			this.titleViewport.append(this.titleText);
			this._register(addDisposableListener(this.element, 'pointerenter', event => {
				if (event.pointerType === 'touch') {
					return;
				}
				this.updateTitleOverflow();
				this.titleResize.value = observeResize(this.titleViewport, () => this.updateTitleOverflow());
			}));
			this._register(addDisposableListener(this.element, 'pointerleave', () => {
				this.titleResize.clear();
				this.titleViewport.classList.remove('title-overflows');
			}));
		}
		this.button.append(this.titleViewport);
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

	get title(): string {
		return this.titleText.textContent ?? '';
	}

	setTitle(title: string): void {
		if (this.title === title) {
			return;
		}
		this.titleText.textContent = title;
		if (this.titleResize.value) {
			this.updateTitleOverflow();
		}
	}

	private updateTitleOverflow(): void {
		const width = this.titleViewport.clientWidth;
		const overflow = this.titleText.offsetWidth - width;
		const hasOverflow = width > 0 && overflow > 0;
		this.titleViewport.classList.toggle('title-overflows', hasOverflow);
		if (hasOverflow) {
			this.titleViewport.style.setProperty('--sessions-row-title-distance', `${overflow}px`);
			this.titleViewport.style.setProperty('--sessions-row-title-duration', `${Math.max(650, overflow * 18)}ms`);
		}
	}

	protected setCollapseRenderer(renderCollapse: (collapsed: boolean) => void): void {
		collapseRenderers.set(this.element, { renderCollapse });
	}
}

/** Shared tree renderer for the retained controls supplied by each session sidebar. */
export class SessionsListTree extends WorkbenchObjectTree<HTMLElement> {
	constructor(container: HTMLElement, title: string, configurationService: IConfigurationService, mode: 'chat' | 'code', scrolling: 'external' | 'managed', dragOptions?: SessionsListDragOptions) {
		const dnd = dragOptions && new SessionsListDragAndDrop(container.ownerDocument, dragOptions);
		super(container, {
			configurationService,
			ariaLabel: title,
			styles: mode === 'code' ? {
				...defaultListStyles,
				listHoverBackground: 'var(--ash-sessions-sidebar-hover-background)',
				listActiveSelectionBackground: 'var(--ash-sessions-sidebar-selection-background)',
				listInactiveSelectionBackground: 'var(--ash-sessions-sidebar-selection-background)',
				listActiveSelectionForeground: 'var(--ash-foreground)',
			} : {
				...defaultListStyles,
				listHoverBackground: 'transparent',
				listActiveSelectionBackground: 'transparent',
				listInactiveSelectionBackground: 'transparent',
			},
			accessibilityProvider: {
				getAriaLabel: element => {
					const title = element.querySelector('h3, .ash-sessions-list-item');
					return title?.getAttribute('aria-label') ?? title?.textContent ?? element.textContent ?? '';
				},
			},
			scrolling,
			dnd,
			expandOnDoubleClick: false,
			indent: 0,
			defaultIndent: 0,
			indentGuides: 'none',
			twistieAdditionalCssClass: () => 'ash-tree-twistie-hidden',
			modelOptions: { identityProvider: { getId: SessionsListTree.id } },
			reuseRows: true,
			renderElement: element => element,
			rowClassName: element => collapseRenderers.get(element)?.rowClassName,
			renderTwistie: (element, state) => {
				collapseRenderers.get(element)?.renderCollapse(!state.expanded, state.collapsible);
			},
		});
		if (dnd) this._register(dnd);
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
			const section = this.model.getElement(id);
			this.collapse(id);
			if (active && !active.isConnected && section) this.focusRow(section, true);
		} else {
			this.expand(id);
		}
	}

	focusRow(row: HTMLElement, preventScroll = false): void {
		let node = this.model.getNode(SessionsListTree.id(row));
		while (node && !node.element.isConnected) node = this.model.getParent(node.id);
		const target = node?.element ?? (row.isConnected ? row : this.getVisibleElements().find(element => element.dataset.section === row.dataset.parentSection));
		target?.querySelector<HTMLButtonElement>('.ash-sessions-list-item, .ash-sessions-list-section-toggle')?.focus({ preventScroll });
	}
}

const collapseRenderers = new WeakMap<HTMLElement, {
	readonly rowClassName?: string;
	renderCollapse(collapsed: boolean, collapsible: boolean): void;
}>();
