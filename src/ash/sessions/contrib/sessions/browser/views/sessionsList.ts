import { IContextKeyService, type IScopedContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { CodeConversationPageContext, SessionsMenuActiveConversationContext, SessionsMenuCanMoveConversationContext, SessionsMenuCanSetFolderContext, SessionsMenuConversationPinnedContext, SessionsMenuWorkspaceIdleContext } from '../../../../common/contextkeys.js';
import { ISessionsListModelService, type ISessionsListTreeNode, type SessionGrouping } from '../../../../services/sessions/browser/sessionsListModelService.js';
import { Separator, SubmenuAction, type IAction } from '../../../../../base/common/actions.js';
import { ISessionSectionOrderService } from '../../../../services/sessions/browser/sessionSectionOrderService.js';
import * as chatInputStatePersistence from '../../../../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { COPY_PATH_COMMAND_ID } from '../../../../../workbench/contrib/files/browser/fileConstants.js';
import { projectForFolder, projectFolders, readCodeProjects, unassignedCodeFolder, workspaceFolderKey } from '../../../chat/browser/sessionWorkspaceProjects.js';
import { MenuWorkbenchToolBar, WorkbenchToolBar } from '../../../../../platform/actions/browser/toolbar.js';
import { ISessionGroupsService, type SessionGroup } from '../../../../services/sessions/browser/sessionGroupsService.js';
import { CHANGE_PROJECT_APPEARANCE, CHANGE_SESSION_GROUP_APPEARANCE, pickProjectAppearance } from './sessionGroupAppearancePicker.js';
import '../media/sessionsList.css';
import { addDisposableListener, getWindow, h, isHTMLElement, isNode } from '../../../../../base/browser/dom.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { ButtonActionViewItem } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { AnchorAlignment, AnchorAxisAlignment, AnchorPosition, ContextView, ContextViewFocusRestore, ContextViewHideReason } from '../../../../../base/browser/ui/contextview/contextview.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputbox.js';
import { createLoadingSpinner } from '../../../../../base/browser/ui/loadingSpinner/loadingSpinner.js';
import { observeResize } from '../../../../../base/browser/observer.js';
import { appendIcon, getRegisteredIcon } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Event } from '../../../../../base/common/event.js';
import { AbstractDisposable, Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { getFlatContextMenuActions } from '../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { SessionActionFeedback } from '../sessionActionFeedback.js';
import { getSessionsListEntries, sessionSortTime } from './sessionsListFilters.js';
import { sessionListProjectActions, sessionProjectOrganization, sessionSortActions, type SessionListOrganization, type SessionListProjectOrganization } from './sessionsListActions.js';
import { SessionsListSearch } from './sessionsListSearch.js';
import { DomWidget } from '../../../../../platform/domWidget/browser/domWidget.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { OPEN_SESSION_COMPARISON_COMMAND_ID } from '../../../../services/sessions/common/sessionComparison.js';
import { IGitHubService } from '../../../github/browser/githubService.js';
import { getPullRequestLabel } from '../../../github/common/types.js';
import { getHighestPriorityPullRequestIcon } from '../../../../../workbench/common/chatPullRequest.js';
import { sessionManagementLabel } from '../../../../browser/sessionManagementLabels.js';
import { sessionExecutionWorkspace, type IChat, type ISession, type SessionManagementInfo } from '../../../../services/sessions/common/session.js';
import type { ThemeIcon } from '../../../../../base/common/themables.js';
import { colorCssVariable } from '../../../../../platform/theme/common/colorUtils.js';
import { autorun, derived, observableFromEvent, type IObservable } from '../../../../../base/common/observable.js';
import { IMenuService, SubmenuItemAction, type MenuId } from '../../../../../platform/actions/common/actions.js';
import { WebAppServerUnavailableError } from '../../../../../platform/agentHost/browser/disconnectedAppServer.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { ICustomViewService } from '../../../../services/customView/browser/customViewService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IProjectService, type Project, type ProjectSummary } from '../../../../../platform/projects/common/projectService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextMenuService, type IContextMenuMenuDelegate } from '../../../../../platform/contextview/browser/contextView.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ARCHIVE_PROJECT_COMMAND, confirmProjectDelete, showSidebarProjectMenu } from '../../../projects/browser/projectsActions.js';
import { IProjectsService } from '../../../projects/browser/projectsService.js';
import { WorkbenchObjectTree } from '../../../../../platform/list/browser/listService.js';
import { defaultButtonStyles, defaultInputBoxStyles, defaultListStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import type { ObjectTreeElement, ObjectTreeNode } from '../../../../../base/browser/ui/tree/objectTreeModel.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ContextMenuAnchor } from '../../../../../base/browser/contextmenu.js';
import { Menus } from '../../../../browser/menus.js';
import type { SessionGroupingContext, SessionsCatalogAccessibility, SessionsCatalogListInput, SessionsCatalogProjectAppearance, SessionsCatalogProjectOperations, SessionsCatalogRow } from './sessionsCatalogList.js';
import { CancellationTokenSource, type CancellationToken } from '../../../../../base/common/cancellation.js';
import { DeferredPromise, raceCancellationError, RunOnceScheduler } from '../../../../../base/common/async.js';
import { basename, extUriBiasedIgnorePathCase } from '../../../../../base/common/resources.js';
import { sessionWorkspaceUri } from '../../../../common/sessionWorkspace.js';
import { ISessionProviderScopeService } from '../../../../browser/agentHost/sessionProviderScopeService.js';
import { DropdownMenuActionViewItem } from '../../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js';
import { createSessionItemActions, getSessionWorkspaceMenuState } from '../../../../browser/agentSessionsModel.js';
import type { SessionsViewSelection } from '../../../../services/sessions/browser/sessionsService.js';
import { readNewChatDraftState } from '../../../chat/common/newChatDraftState.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { Icon } from '../../../../../base/common/icon.js';
import { SessionLeadingIcon } from '../../../../browser/ui/sessionLeadingIcon.js';
import { createSessionPreviewHover, loadSessionHoverBranch } from '../sessionHoverContent.js';
import { IHoverService, type IManagedHover } from '../../../../../platform/hover/browser/hoverService.js';
import { LocalChatSessionUri } from '../../../../../workbench/contrib/chat/common/model/chatUri.js';
import { fillChatReferenceDragData } from '../../../../browser/dnd.js';
import { DragAndDropDataKind } from '../../../../../base/browser/ui/dnd/dnd.js';
import { ObjectTreeElementCollapseState, type TreeDragAndDrop, type TreeDragData } from '../../../../../base/browser/ui/tree/tree.js';
import type { URI } from '../../../../../base/common/uri.js';
import { IBlockedSessionsIndicatorService, type IBlockedSession } from '../blockedSessionsIndicatorModel.js';

const attentionSection = 'attention';
const codeFolderProjectMigrationKey = 'sessions.code.folderProjectsMigrated';
const createCodeProjectAction = 'sessions.list.createCodeProject';

type ProjectMenuRow = Pick<SessionListItem, 'domNode' | 'button' | 'getMenuTrigger' | 'setMenuVisible'>;

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

export type SessionsListPresentation = 'chat' | 'code'
	| { readonly createProject: () => Promise<void>; }
	| { readonly openCommand: string; readonly activeContext: string; }
	| { readonly catalog: SessionsCatalogListInput; readonly accessibility: SessionsCatalogAccessibility; };

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
	private readonly entry: Extract<SessionsListPresentation, { openCommand: string; }> | undefined;
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
	private migratingCodeFolderProjects = false;
	private projectsFailed = false;
	private projectsLoading = false;
	private readonly projectLoadNotice = this._register(new MutableDisposable());
	private readonly empty: HTMLParagraphElement;
	private readonly catalog: SessionsCatalogListInput | undefined;
	private readonly menuContext: IScopedContextKeyService | undefined;
	private readonly attention: IObservable<ReadonlyMap<string, IBlockedSession>>;
	private readonly catalogViewport: HTMLElement | null | undefined;
	private readonly catalogRows = new Map<string, SessionsCatalogRow>();
	private readonly catalogMenu = this._register(new MutableDisposable());
	private readonly projectRename = this._register(new MutableDisposable());
	private readonly catalogProjects = new Map<string, { readonly load?: () => void; readonly anchor?: HTMLElement; }>();
	private readonly catalogPaging = this._register(new RunOnceScheduler(() => {
		if (!this.domNode.isConnected || !this.domNode.clientHeight) return;
		const viewport = this.catalogViewport;
		if (viewport && !this.search.hasQuery && this.tree.isCollapsed('section:recent') === false
			&& viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 32) {
			this.catalog?.loadMore();
		}
		for (const [key, project] of this.catalogProjects) {
			const id = `section:${key}`;
			const anchor = project.anchor ? SessionsListTree.id(project.anchor) : id;
			if (project.load && this.tree.isCollapsed(id) === false && this.tree.getRelativeTop(anchor) !== null) project.load();
		}
	}, 0));

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
		@IMenuService private readonly menus: IMenuService,
		@INotificationService private readonly notifications: INotificationService,
		@ISessionsListModelService private readonly listModel: ISessionsListModelService,
		@ISessionSectionOrderService private readonly sectionOrder: ISessionSectionOrderService,
		@IBlockedSessionsIndicatorService indicator: IBlockedSessionsIndicatorService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IDialogService private readonly dialogs: IDialogService,
		@ILogService private readonly logService: ILogService,
		@IProjectsService private readonly projectPreferences: IProjectsService,
		@IContextKeyService private readonly contextKeys?: IContextKeyService,
		@IHoverService private readonly hoverService?: IHoverService,
		@ISessionProviderScopeService private readonly providerScopes?: ISessionProviderScopeService,
		@IInstantiationService private readonly instantiation?: IInstantiationService,
		@IConfigurationService configuration?: IConfigurationService,
	) {
		super();
		const contributed = typeof presentation !== 'string' && 'catalog' in presentation ? presentation : undefined;
		this.catalog = contributed?.catalog;
		const code = typeof presentation !== 'string' && 'createProject' in presentation ? presentation : undefined;
		const mode = this.mode = typeof presentation === 'string' ? presentation : code ? 'code' : 'chat';
		this.entry = typeof presentation !== 'string' && 'openCommand' in presentation ? presentation : undefined;
		const showAttention = observableFromEvent(this, listModel.onDidChange, () => !this.entry && listModel.showAttentionGroup);
		this.attention = derived(reader => new Map(showAttention.read(reader)
			? indicator.blockedSessions.read(reader).map(alert => [alert.session.sessionId, alert] as const) : []));
		const nativeLoading = observableFromEvent(this, sessionService.onDidChange, () => sessionService.state === 'loading' && sessionService.sessions.length > 0);
		this.loading = nativeLoading.map((loading, reader) => loading || !!this.catalog?.snapshot.read(reader).loading);
		const ownerDocument = container.ownerDocument;
		this.domNode = h(ownerDocument, 'section');
		this.domNode.className = 'ash-sessions-list';
		if (contributed) this.domNode.classList.add('ash-chat-navigation');
		this.domNode.tabIndex = -1;
		this.domNode.dataset.mode = mode;
		const config = configuration ?? this._register(new InMemoryConfigurationService());
		// Embedded Sessions shares Chat's viewport with the conversation history.
		this.tree = this._register(new SessionsListTree(this.domNode, title, config, mode === 'code' || !!contributed, this.entry ? 'external' : 'managed', {
			organization: element => this.getOrganization(element),
			reference: element => {
				const target = this.items.get(element.dataset.item ?? '')?.target;
				return target && LocalChatSessionUri.forSession(target.sessionId, target.threadId);
			},
			canReorder: element => !!element.dataset.sectionOrderId,
			reorder: (source, target) => {
				if (target.dataset.parentSection === attentionSection) return undefined;
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
		if (contributed) {
			this.list.classList.add('ash-chat-navigation-scrollable');
			this.tree.element.classList.add('ash-chat-navigation-list');
			this.catalogViewport = this.list.querySelector(':scope > .ash-scrollbar-viewport');
		}
		if (mode === 'code' || contributed) {
			this._register(this.tree.onDidChangeSelection(({ browserEvent }) => {
				// The active conversation owns selection. Tree input can still move focus.
				if (browserEvent) this.syncTreeSelection();
			}));
		}
		this._register(this.tree.onDidChangeCollapseState(({ element, collapsed }) => {
			const key = element.dataset.section;
			if (!collapsed && key && this.catalogProjects.has(key)) this.catalogPaging.schedule();
			if (key === undefined || this.search.hasQuery) return;
			this.storage.store(this.collapseKey(key), collapsed, StorageScope.PROFILE, StorageTarget.MACHINE);
		}));
		this.search = this._register(new SessionsListSearch(this.domNode, this.list, () => this.render(), () => {
			const row = [...this.list.querySelectorAll<HTMLButtonElement>('.ash-sessions-list-item')].find(button => !button.closest('[hidden]'));
			row?.focus();
		}));
		if (!this.entry) this._register(listModel.registerTree(mode, () => this.readTree()));
		const activeContext = this.entry?.activeContext ?? (mode === 'code' ? CodeConversationPageContext.key : undefined);
		if (activeContext && contextKeys) {
			const keys = new Set([activeContext]);
			this._register(contextKeys.onDidChangeContext(event => { if (event.affectsSome(keys)) this.render(); }));
		}
		this.empty = h(ownerDocument, 'p');
		this.empty.className = 'ash-sessions-empty';
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(addDisposableListener(this.list, 'keydown', event => {
			if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
			const buttons = [...this.list.querySelectorAll<HTMLButtonElement>('button:not(.ash-session-leading-icon button, .ash-sessions-list-more button, .ash-sessions-list-actions button)')]
				.filter(button => !button.closest('[hidden]'));
			const index = buttons.indexOf(ownerDocument.activeElement as HTMLButtonElement);
			if (index < 0) return;
			event.preventDefault();
			event.stopPropagation();
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
			const button = buttons[next];
			const row = button?.closest<HTMLElement>('[data-item], [data-section]');
			if (row) this.tree.reveal(SessionsListTree.id(row));
			button?.focus({ preventScroll: !!row });
		}, true));
		this._register(sessionService.onDidChange(() => {
			if (this.shouldMigrateCodeFolderProjects() && !this.projectsFailed) void this.loadProjects();
			else this.render();
		}));
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
		const menuContext = this.menuContext = contextKeys && this._register(contextKeys.createScoped(this.domNode));
		const createProjectLabel = localize('sessions.activity.createProject', 'Create project');
		const createProject: IAction | undefined = code ? {
			id: createCodeProjectAction,
			label: createProjectLabel,
			tooltip: createProjectLabel,
			icon: Lxicon.add,
			enabled: true,
			run: code.createProject,
		} : undefined;
		this.createListToolbar = (container, disposables) => createSessionsListToolbar(
			container, disposables, menus, contextMenus, menuContext,
			Menus.SidebarSessionsHeader, Menus.SessionsViewFilter, actions => this.getFilterActions(actions), createProject,
		);
		if (contributed) {
			const { accessibility, catalog } = contributed;
			menuContext?.createKey(accessibility.focusContext, true);
			this._register(addDisposableListener(this.domNode, 'focusin', event => {
				if (!this.domNode.contains(event.relatedTarget as Node) && config.getValue<boolean>(accessibility.verbositySetting)) {
					status(accessibility.hint());
				}
			}));
			this._register(this.tree.onDidScroll(() => this.catalogPaging.schedule()));
			this._register(addDisposableListener(this.list, 'focusin', () => this.catalogPaging.schedule()));
			this._register(observeResize(this.domNode, () => this.catalogPaging.schedule()));
			this._register(autorun(reader => {
				catalog.snapshot.read(reader);
				this.render();
			}));
		}
		this._register(autorun(reader => {
			customViews.activeCustomView.read(reader);
			this.attention.read(reader);
			if (!this.catalog) this.projectPreferences.state.read(reader);
			this.render();
		}));
		this.render();
		if (!this.catalog) {
			this._register(projectService.onDidChange(() => { void this.loadProjects(); }));
			void this.loadProjects();
		}
	}

	private async openRow(open: (options: Parameters<ISessionsService['openSession']>[2]) => Promise<void>): Promise<void> {
		try {
			if (this.entry && !this.contextKeys?.getValue(this.entry.activeContext)) {
				await this.commands.executeCommand(this.entry.openCommand);
			}
			if (!this.isDisposed) await open(this.mode === 'code' ? { reveal: 'code' } : undefined);
		} catch (error) {
			if (!this.isDisposed) this.notifications.error(String(error));
		}
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
				...(!this.entry ? [choice('sessions.list.showAttentionGroup', localize('sessions.list.needsAttention', 'Needs Attention'),
					model.showAttentionGroup, () => model.setShowAttentionGroup(!model.showAttentionGroup))] : []),
				...(!this.catalog ? [
					choice('sessions.list.showComparisonGroups', localize('sessions.list.showComparisonGroups', 'Comparison Groups'),
						model.showComparisonGroups, () => model.setShowComparisonGroups(!model.showComparisonGroups)),
					new Separator(),
				] : []),
				choice('sessions.list.toggleAutomationSessions', localize('sessions.list.showAutomationSessions', 'Show Task Run Conversations'),
					automation === 'always', () => model.setAutomationSessionsMode(automation === 'always' ? 'never' : 'always')),
				choice('sessions.list.showAutomationSessionsAfterReply', localize('sessions.list.showAutomationSessionsAfterReply', 'Show Task Run Conversations After Reply'),
					automation === 'afterReply', () => model.setAutomationSessionsMode(automation === 'afterReply' ? 'never' : 'afterReply')),
			]),
		], [...contributed]);
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

	public closePopups(): void {
		this.catalogMenu.clear();
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
		// The migration itself publishes Project changes. Refresh once its writes finish.
		if (this.migratingCodeFolderProjects) return;
		const generation = ++this.projectLoad;
		const migrate = this.shouldMigrateCodeFolderProjects();
		this.migratingCodeFolderProjects = migrate;
		this.projectsLoading = true;
		this.render();
		try {
			let projects: readonly Project[];
			if (migrate) {
				await this.migrateCodeFolderProjects();
				projects = await readCodeProjects(this.projectService);
			} else {
				const summaries = await this.projectService.list(this.mode);
				projects = await Promise.all(summaries.filter(project => !project.archived).map(project => this.projectService.read(project.id, this.mode)));
			}
			if (this.isDisposed || generation !== this.projectLoad) return;
			this.projects = projects.filter(project => !project.archived);
			this.projectsFailed = false;
			this.projectLoadNotice.clear();
		} catch (error) {
			if (this.isDisposed || generation !== this.projectLoad) return;
			this.projectsFailed = true;
			const cause = error instanceof Error ? error.cause ?? error : error;
			// A browser host without App Server support has nothing to retry.
			if (!(cause instanceof WebAppServerUnavailableError)) {
				this.logService.error('sessions.projects', `Could not load ${this.mode} projects`, cause instanceof Error ? cause : toErrorMessage(cause));
				this.notifyProjectLoadFailure();
			}
		} finally {
			if (migrate) this.migratingCodeFolderProjects = false;
		}
		this.projectsLoading = false;
		this.render();
		// Recovery can arrive while this load still owns the migration lock.
		if (migrate && !this.projectsFailed && this.shouldMigrateCodeFolderProjects()) void this.loadProjects();
	}

	private notifyProjectLoadFailure(): void {
		if (this.projectLoadNotice.value) return;
		const notice = this.notifications.notify({
			severity: Severity.Error,
			message: localize('sessions.list.projectsLoadFailed', 'Could not load projects.'),
			actions: {
				primary: [{
					id: `sessions.list.retryProjects.${this.mode}`,
					label: localize('sessions.list.retryProjects', 'Retry'),
					tooltip: '',
					enabled: true,
					keepOpen: true,
					run: async () => {
						if (!this.isDisposed && !this.projectsLoading) await this.loadProjects();
					},
				}],
			},
		});
		this.projectLoadNotice.value = toDisposable(() => notice.close());
		Event.once(notice.onDidClose)(() => this.projectLoadNotice.clear());
	}

	private shouldMigrateCodeFolderProjects(): boolean {
		return this.mode === 'code' && this.sessionService.state === 'ready' && this.sessionService.primaryCatalogReady
			&& !this.storage.getBoolean(codeFolderProjectMigrationKey, StorageScope.PROFILE, false);
	}

	private async migrateCodeFolderProjects(): Promise<void> {
		const projects = await readCodeProjects(this.projectService);
		if (this.isDisposed || !this.shouldMigrateCodeFolderProjects()) return;
		const organized = new Set([...projects.flatMap(project => project.sessionIds), ...this.groups.groups.flatMap(group => group.sessionIds)]);
		const folders = new Map<string, { readonly resource: URI; readonly sessionIds: string[]; }>();
		for (const session of this.sessionService.sessions) {
			const resource = unassignedCodeFolder(session, organized);
			if (!resource) continue;
			const key = workspaceFolderKey(resource);
			let entry = folders.get(key);
			if (!entry) folders.set(key, entry = { resource, sessionIds: [] });
			entry.sessionIds.push(session.sessionId);
		}
		for (const [key, { resource, sessionIds }] of folders) {
			if (this.isDisposed || !this.shouldMigrateCodeFolderProjects()) return;
			const matching = projects.filter(project => projectFolders(project).some(folder => workspaceFolderKey(folder) === key));
			if (matching.length && matching.every(project => project.archived)) continue;
			let project = matching.find(project => !project.archived) ?? await projectForFolder(this.projectService, projects, resource);
			for (const id of sessionIds) {
				if (project.sessionIds.includes(id)) continue;
				try {
					project = await this.projectService.addSession(project, id);
				} catch (error) {
					const current = (await readCodeProjects(this.projectService)).find(candidate => candidate.id === project.id);
					// Another window may have removed this project, including one replayed by the creation command.
					if (!current || current.archived) break;
					if (current.sessionIds.includes(id)) {
						project = current;
						continue;
					}
					if (current.revision === project.revision) throw error;
					project = await this.projectService.addSession(current, id);
				}
			}
		}
		// A removed project or membership stays removed on subsequent opens.
		if (!this.isDisposed && this.shouldMigrateCodeFolderProjects()) {
			this.storage.store(codeFolderProjectMigrationKey, true, StorageScope.PROFILE, StorageTarget.MACHINE);
		}
	}

	private getOrganization(element: HTMLElement): SessionListOrganization | undefined {
		const external = this.catalogRows.get(element.dataset.item ?? '');
		if (external) return external.organization();
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

	private async showCatalogMenu(row: SessionsCatalogRow, item: SessionListItem, anchor: ContextMenuAnchor): Promise<void> {
		if (row.disabled || row.actionsDisabled) return;
		const controller = new AbortController();
		this.catalogMenu.value = toDisposable(() => controller.abort());
		try {
			const focus = () => this.tree.focusRow(item.domNode);
			const actions = [...await row.getActions(controller.signal, focus)];
			if (controller.signal.aborted || !item.domNode.isConnected) return;
			const project = row.organization()?.project;
			if (project) {
				const separator = actions.map(action => action instanceof Separator).lastIndexOf(true);
				actions.splice(separator < 0 ? actions.length : separator, 0, ...this.projectActions(item, project));
			}
			this.showConversationMenu(item, anchor, actions, row.sessionId ? { sessionId: row.sessionId } : { catalogId: row.id }, row.pinned);
		} catch (error) {
			if (!controller.signal.aborted) this.notifications.error(toErrorMessage(error));
		}
	}

	private projectActions(item: SessionListItem, project: SessionListProjectOrganization): readonly IAction[] {
		return sessionListProjectActions(this.mode, project, async run => {
			try {
				await run();
			} catch (error) {
				if (!this.isDisposed && !isCancellationError(error)) this.notifications.error(toErrorMessage(error));
			} finally {
				if (!this.isDisposed) this.tree.focusRow(item.domNode);
			}
		}, async () => {
			const name = (await this.quickInput.input({
				title: localize('sessions.list.newProject', 'New project'),
				validateInput: async value => {
					if (!value.trim()) return localize('sessions.list.projectNameRequired', 'Enter a project name.');
					if (value.trim().length > 200) return localize('sessions.list.projectNameTooLong', 'Use at most {0} characters for the project name.', 200);
					return undefined;
				},
			}))?.trim();
			return this.isDisposed ? undefined : name;
		});
	}

	private showRowMenu(item: SessionListItem, anchor: ContextMenuAnchor,
		delegate: Omit<IContextMenuMenuDelegate, 'getAnchor' | 'autoSelectFirstItem'>): void {
		const trigger = item.getMenuTrigger(anchor);
		this.contextMenus.showContextMenu({
			...delegate,
			getAnchor: () => anchor,
			autoSelectFirstItem: anchor === trigger || !!trigger?.matches(':focus-visible'),
			getActions: () => {
				item.setMenuVisible(true);
				return (delegate.getActions?.() ?? []).map(action => action.id === 'agentSession.archive' ? {
					...action,
					run: () => this.feedback.archive(item.domNode, () => action.run()),
				} : action);
			},
			onHide: (cancelled, reason) => {
				item.setMenuVisible(false);
				delegate.onHide?.(cancelled, reason);
				if (reason === ContextViewHideReason.OutsidePointer) {
					item.dismissMenuFromPointer();
				} else if (cancelled && trigger?.isConnected) {
					trigger.focus({ preventScroll: true });
				}
			},
		});
	}

	private moveOrderedItem(element: HTMLElement, attribute: 'rowOrderId' | 'sectionOrderId', targetId: string): void {
		const parent = this.parentOf(element);
		const id = element.dataset[attribute];
		if (!id || parent?.element.dataset.section === attentionSection) return;
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
		if (!id || parent?.element.dataset.section === attentionSection) {
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
			actions.push(...this.appearanceActions(CHANGE_SESSION_GROUP_APPEARANCE,
				field => this.commands.executeCommand(CHANGE_SESSION_GROUP_APPEARANCE, group.sectionId, field),
				localize('sessions.list.changeGroupIcon', 'Change group icon'),
				localize('sessions.list.changeGroupColor', 'Change group color')));
		}
		if (actions.length) {
			this.contextMenus.showContextMenu({ getAnchor: () => anchor, getActions: () => actions, autoSelectFirstItem: true });
		}
	}

	private showLocalProjectMenu(title: string, project: ProjectSummary, row: ProjectMenuRow, anchor: ContextMenuAnchor): void {
		this.showProjectMenu(project.id, title, field => this.commands.executeCommand(CHANGE_PROJECT_APPEARANCE, project.id, field), {
			rename: async (name, signal) => {
				const current = await this.projectService.read(project.id, this.mode);
				signal.throwIfAborted();
				await this.projectService.update(current, name, current.description, current.materials);
			},
			archive: () => this.commands.executeCommand<boolean>(ARCHIVE_PROJECT_COMMAND, project.id, this.mode),
			remove: { removesContents: false, run: () => this.projectService.remove(project) },
		}, row, anchor);
	}

	private showWorkspaceMenu(resource: URI, anchor: ContextMenuAnchor): void {
		const label = localize({ bundle: 'ash', key: 'workbench.copyPath' }, 'Copy Path');
		const actions: IAction[] = [{
			id: COPY_PATH_COMMAND_ID, label, tooltip: label, icon: Lxicon.copy, enabled: true,
			run: () => this.commands.executeCommand(COPY_PATH_COMMAND_ID, resource),
		}];
		this.contextMenus.showContextMenu({ getAnchor: () => anchor, getActions: () => actions, autoSelectFirstItem: true });
	}

	private showProjectMenu(projectId: string, title: string, change: ((field: 'icon' | 'color') => Promise<void>) | undefined,
		operations: SessionsCatalogProjectOperations, row: ProjectMenuRow, anchor: ContextMenuAnchor): void {
		if (!this.menuContext) return;
		const { rename, archive, remove } = operations;
		const trigger = row.getMenuTrigger(anchor);
		const pinned = this.projectPreferences.isPinned(projectId);
		const runRemoval = async (operation: () => Promise<boolean | void>): Promise<void> => {
			if (this.isDisposed) return;
			const completed = await operation();
			if (completed !== false && !this.isDisposed) this.focus();
		};
		showSidebarProjectMenu(this.contextMenus, this.menuContext, this.mode, {
			projectId,
			actions: {
				pin: pinned ? undefined : () => this.setProjectPinned(projectId, true),
				unpin: pinned ? () => this.setProjectPinned(projectId, false) : undefined,
				rename: rename && (() => this.renameProject(title, row.domNode, trigger ?? row.button, rename)),
				icon: change && (() => change('icon')),
				color: change && (() => change('color')),
				archive: archive && (() => runRemoval(archive)),
				remove: remove && (async () => {
					if (!await confirmProjectDelete(this.dialogs, title, remove.removesContents)) return;
					await runRemoval(async () => {
						await remove.run();
						if (this.projectPreferences.isPinned(projectId)) this.projectPreferences.togglePinned(projectId);
					});
				}),
			},
		}, {
			getAnchor: () => {
				row.setMenuVisible(true);
				return anchor;
			},
			onHide: () => row.setMenuVisible(false),
		});
	}

	private setProjectPinned(projectId: string, pinned: boolean): void {
		if (this.isDisposed) return;
		if (this.projectPreferences.isPinned(projectId) !== pinned) this.projectPreferences.togglePinned(projectId);
		this.tree.setSectionCollapsed(pinned ? 'pinned' : 'projects', false);
		const row = this.tree.getVisibleElements().find(element => element.dataset.projectId === projectId);
		if (row) this.tree.focusRow(row);
	}

	private async renameProject(title: string, anchor: HTMLElement, trigger: HTMLElement, rename: NonNullable<SessionsCatalogProjectOperations['rename']>): Promise<void> {
		if (this.isDisposed || !anchor.isConnected) return;
		const controller = new AbortController();
		const lifetime = new DisposableStore();
		lifetime.add(toDisposable(() => controller.abort()));
		this.projectRename.value = lifetime;
		try {
			const name = await this.promptProjectName(title, anchor, trigger, lifetime);
			if (controller.signal.aborted || !name || name === title) return;
			await rename(name, controller.signal);
			if (!controller.signal.aborted) status(localize('sessions.list.projectRenamed', 'Project renamed to {0}.', name));
		} catch (error) {
			if (!controller.signal.aborted && !isCancellationError(error)) this.notifications.error(toErrorMessage(error));
		} finally {
			if (this.projectRename.value === lifetime) this.projectRename.clear();
		}
	}

	private promptProjectName(title: string, anchor: HTMLElement, trigger: HTMLElement, lifetime: DisposableStore): Promise<string | undefined> {
		const document = anchor.ownerDocument;
		const heading = localize('sessions.list.renameProject', 'Rename project');
		const form = h(document, 'form', {
			className: 'ash-sessions-project-rename',
			attributes: { role: 'dialog', 'aria-label': heading },
		});
		const view = lifetime.add(new ContextView(this.domNode));
		const header = h(document, 'header', { className: 'ash-sessions-project-rename-header' });
		header.append(h(document, 'h2', { attributes: { title: heading } }, heading));
		const close = localize('sessions.list.closeProjectRename', 'Close rename dialog');
		lifetime.add(new Button(header, {
			...defaultButtonStyles,
			label: close,
			title: close,
			icon: Lxicon.dialogClose,
			iconOnly: true,
			onClick: () => view.hide(),
		}));
		form.append(header);
		const input = lifetime.add(new InputBox(form, {
			ariaLabel: localize('sessions.list.projectName', 'Project name'),
			inputBoxStyles: defaultInputBoxStyles,
			presentation: 'field',
		}));
		input.value = title;
		const actions = h(document, 'div', { className: 'ash-sessions-project-rename-actions' });
		form.append(actions);
		const result = new DeferredPromise<string | undefined>();
		lifetime.add(new Button(actions, {
			...defaultButtonStyles,
			size: 'small',
			label: localize('sessions.list.cancelProjectRename', 'Cancel'),
			onClick: () => view.hide(),
		}));
		lifetime.add(new Button(actions, {
			...defaultButtonStyles,
			presentation: 'primary',
			size: 'small',
			label: localize('sessions.list.rename', 'Rename'),
			type: 'submit',
		}));
		lifetime.add(input.onDidChange(() => input.showValidation('')));
		lifetime.add(addDisposableListener(form, 'submit', event => {
			event.preventDefault();
			const name = input.value.trim();
			if (!name) {
				input.showValidation(localize('sessions.list.projectNameRequired', 'Enter a project name.'));
				input.focus();
				return;
			}
			void result.complete(name);
			view.hide();
		}));
		trigger.focus({ preventScroll: true });
		if (view.show({
			anchor,
			content: form,
			presentation: 'dialog',
			anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
			gap: 8,
			focusRestore: ContextViewFocusRestore.Previous,
			onHide: () => { if (!result.isSettled) void result.complete(undefined); },
		})) {
			input.focus();
			input.select();
		} else if (!result.isSettled) {
			void result.complete(undefined);
		}
		return result.p;
	}

	private appearanceActions(id: string, change: (field: 'icon' | 'color') => Promise<void>, iconLabel: string, colorLabel: string): IAction[] {
		return ([['icon', iconLabel], ['color', colorLabel]] as const).map(([field, label]) => ({
			id: `${id}.${field}`,
			label,
			tooltip: '',
			enabled: true,
			run: () => change(field).catch(error => this.notifications.error(toErrorMessage(error))),
		}));
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
		this.catalogMenu.clear();
		const actions = this.orderActions(item.domNode, 'row');
		if (selection.kind === 'untitled') {
			this.showConversationMenu(item, anchor, [...actions, ...createSessionItemActions(selection, this.commands, this.listModel, this.notifications,
				() => this.commands.executeCommand('sessions.openInNewWindow', selection),
				sessionId => this.restoreViewState({ top: this.tree.scrollTop, focus: `session:${sessionId}` }))]);
			return;
		}
		const { session, threadId } = selection.active;
		const project = this.getOrganization(item.domNode)?.project;
		if (project) actions.push(...this.projectActions(item, project));
		actions.push(...this.automationVisibilityActions(selection));
		this.showConversationMenu(item, anchor, actions, { sessionId: session.sessionId, threadId }, this.listModel.isSessionPinned(session));
	}

	private showConversationMenu(item: SessionListItem, anchor: ContextMenuAnchor, actions: IAction[],
		target?: { readonly sessionId: string; readonly threadId?: string; } | { readonly catalogId: string; }, pinned = false): void {
		this.rowMenuContext.clear();
		const context = this.rowMenuContext.value = this.contextKeys?.createScoped(item.domNode);
		const workspace = this.mode === 'code' && target && 'sessionId' in target && target.threadId
			? getSessionWorkspaceMenuState(target.sessionId, target.threadId, this.sessionService)
			: undefined;
		if (context && target && 'sessionId' in target) {
			const { sessionId, threadId } = target;
			SessionsMenuActiveConversationContext.bindTo(context).set(true);
			SessionsMenuConversationPinnedContext.bindTo(context).set(pinned);
			if (this.mode === 'code' && threadId) {
				SessionsMenuCanSetFolderContext.bindTo(context).set(!!workspace);
				SessionsMenuWorkspaceIdleContext.bindTo(context).set(workspace?.enabled === true);
				SessionsMenuCanMoveConversationContext.bindTo(context).set(!!this.sessionService.getChatMoveDestinations?.(sessionId, threadId).length);
			}
		}
		const menu = this.mode === 'code' ? Menus.SidebarCodeSessionContext : Menus.SidebarChatSessionContext;
		this.showRowMenu(item, anchor, {
			getActions: () => Separator.join(actions, getFlatContextMenuActions(this.menus.getMenuActions(menu, { arg: target }, context)).map(action => {
				if (action.id === 'agentSession.changeDirectory' && workspace) {
					return { ...action, label: workspace.label, tooltip: workspace.label, badge: workspace.busyBadge, run: () => action.run() };
				}
				if (action.id === 'agentSession.delete') return { ...action, class: 'ash-session-delete-action', run: () => action.run() };
				if (action.id === 'sessions.list.togglePin') return {
					...action, run: async () => {
						const id = await action.run();
						if (typeof id === 'string' && !this.isDisposed) {
							if (this.catalog) {
								// A pinned Chat conversation keeps its row inside the project.
								if (item.domNode.isConnected) this.tree.focusRow(item.domNode);
							} else this.restoreViewState({ top: this.tree.scrollTop, focus: `session:${id}` });
						}
					}
				};
				return action;
			})),
			onHide: () => {
				if (this.rowMenuContext.value === context) this.rowMenuContext.clear();
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

	private repositoryKey(session: SessionGroupingContext): string {
		return JSON.stringify([session.sessionId, session.workspace?.authorityId, session.workspace?.root]);
	}

	private repositoryGroupingContext(session: SessionGroupingContext, catalog: ReadonlyMap<string, ISession>): SessionGroupingContext {
		const owner = catalog.get(session.sessionId);
		return owner ? { ...session, workspace: sessionExecutionWorkspace(owner) } : session;
	}

	private async loadRepositoryGroups(sessions: readonly SessionGroupingContext[], catalog: ReadonlyMap<string, ISession>): Promise<void> {
		const scopes = this.providerScopes;
		if (!scopes || this.repositoryLookup.value) {
			return;
		}
		const needsDirectory = (session: SessionGroupingContext): boolean => catalog.get(session.sessionId)?.chats.some(chat =>
			chat.origin.type === 'root' && chat.status === 'active' && chat.workspace === undefined) ?? false;
		const missing = sessions.filter(session => {
			const context = this.repositoryGroupingContext(session, catalog);
			return (context.workspace || needsDirectory(session)) && !this.repositoryGroups.has(this.repositoryKey(context));
		});
		if (!missing.length) {
			return;
		}
		const lookup = this.repositoryLookup.value = new CancellationTokenSource();
		const token = lookup.token;
		await Promise.resolve();
		if (missing.some(needsDirectory)) {
			// Catalog rows can arrive before their Thread directories. Use the hydrated
			// checkout when it is available, even for rows supplied by a separate sidebar.
			await raceCancellationError(this.sessionService.whenDirectoriesReady(), token).catch(() => undefined);
			catalog = new Map(this.sessionService.sessions.map(session => [session.sessionId, session]));
		}
		for (const session of missing) {
			if (token.isCancellationRequested || this.isDisposed) {
				return;
			}
			const context = this.repositoryGroupingContext(session, catalog);
			const workspace = context.workspace;
			const key = this.repositoryKey(context);
			if (this.repositoryGroups.has(key)) continue;
			if (!workspace) {
				this.repositoryGroups.set(key, undefined);
				continue;
			}
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
			this.repositoryGroups.set(key, bucket);
		}
		this.repositoryLookup.clear();
		this.render();
	}

	private sessionBucket(session: SessionGroupingContext | undefined, grouping: Exclude<SessionGrouping, 'none'>, projects: ReadonlyMap<string, Project>): SessionBucket {
		switch (grouping) {
			case 'projects': {
				const project = session && projects.get(session.sessionId);
				return project ? { id: project.id, label: project.name } : { id: '', label: localize('sessions.list.noProjectGroup', 'No Project') };
			}
			case 'repository':
				return (session && this.repositoryGroups.get(this.repositoryKey(session))) ?? { id: '', label: localize('sessions.list.noRepositoryGroup', 'No Repository Information') };
			case 'status':
				return { id: session?.management?.status ?? '', label: sessionManagementLabel(session?.management) ?? localize('sessions.list.unknownStatusGroup', 'Unknown Status') };
			case 'environment': {
				const workspace = session?.workspace;
				if (workspace?.runtime) {
					const runtime = workspace.runtime;
					return { id: JSON.stringify([runtime.providerId, runtime.hostAuthority, runtime.workspace]), label: runtime.workspace };
				}
				if (workspace) {
					return { id: workspace.authorityId, label: workspace.authorityId === 'local' ? localize('sessions.list.localEnvironmentGroup', 'Local') : session?.providerLabel || workspace.authorityId };
				}
				return { id: '', label: localize('sessions.list.noEnvironmentGroup', 'No Environment') };
			}
		}
	}

	private updateSessionPreview(item: SessionListItem, session: ISession, chat: IChat, projectName: string | undefined): void {
		const scopes = this.providerScopes;
		const { sessionId } = session;
		const { threadId } = chat;
		item.updatePreview(this.hoverService, projectName, chat.updatedAt, scopes && {
			key: JSON.stringify([sessionId, threadId, session.providerId, session.workspace, chat.workspace === undefined, chat.workspace]),
			load: token => loadSessionHoverBranch(this.sessionService, scopes, sessionId, threadId, token),
		});
	}

	private render(): void {
		const ownerDocument = this.domNode.ownerDocument;
		const focused = this.list.contains(ownerDocument.activeElement) ? ownerDocument.activeElement as HTMLElement : undefined;
		const focusedRow = focused?.closest<HTMLElement>('[data-section], [data-item]');
		const present = new Set<string>();
		const activeSections = new Set<string>();
		const pinned: HTMLElement[] = [];
		const attentionRows: HTMLElement[] = [];
		const alerts = this.attention.get();
		const attentionLabel = alerts.size ? localize('sessions.list.needsAttention', 'Needs Attention') : '';
		const recent: HTMLElement[] = [];
		const remaining = new Map<string, HTMLElement>();
		const childrenByRow = new Map<HTMLElement, readonly HTMLElement[]>();
		const sort = this.listModel.getSort(this.mode);
		const grouping = this.listModel.grouping;
		const sortKeys = new Map<HTMLElement, string | number>();
		const sortRows = (rows: readonly HTMLElement[]): readonly HTMLElement[] => {
			const sign = sort.direction === 'ascending' ? 1 : -1;
			const sortable = rows.filter(row => sortKeys.has(row)).sort((left, right) => {
				const a = sortKeys.get(left)!;
				const b = sortKeys.get(right)!;
				return sign * (typeof a === 'string' ? a.localeCompare(String(b), undefined, { numeric: true }) : a - Number(b));
			});
			let index = 0;
			return rows.map(row => sortKeys.has(row) ? sortable[index++]! : row);
		};
		this.catalogRows.clear();
		this.catalogProjects.clear();
		const activeSelection = this.catalog || this.customViews.activeCustomView.get() || this.entry && !this.contextKeys?.getValue(this.entry.activeContext)
			|| !this.entry && this.mode === 'code' && this.contextKeys?.getValue(CodeConversationPageContext.key) === false
			? undefined : this.viewService.activeSelection;
		const restingIcon = this.mode === 'code' ? quietSessionIcon : undefined;
		const statusIcons = this.mode === 'code' ? codeManagementIcons : managementIcons;
		const itemFor = (key: string, kind: 'conversation' | 'draft' | 'project', icon = restingIcon): SessionListItem => {
			present.add(key);
			let item = this.items.get(key);
			if (!item) {
				const entry = this.catalogRows.get(key);
				const setIcon = entry ? entry.setIcon && ((icon: Icon | undefined) => this.catalogRows.get(key)?.setIcon?.(icon))
					: (icon: Icon | undefined) => this.listModel.setRowIcon(key, icon?.id);
				const leading = kind === 'conversation' && this.instantiation
					? this.instantiation.createInstance(SessionLeadingIcon, ownerDocument, '', setIcon)
					: undefined;
				item = this.items.set(key, new SessionListItem(ownerDocument, this.contextMenus, statusIcons, kind, icon, leading));
			}
			item.domNode.dataset.item = key;
			if (item.leadingIcon && !this.catalogRows.has(key)) {
				const customId = this.listModel.getRowIcon(key);
				item.leadingIcon.setRestingIcon((customId ? getRegisteredIcon(customId, ownerDocument) : undefined) ?? icon);
			}
			return item;
		};
		const sectionFor = (key: string, title: string, children: readonly HTMLElement[], kind: SessionListSectionKind = 'section',
			options?: { readonly open?: () => void; readonly group?: SessionGroup; readonly project?: ProjectSummary; readonly projectAppearance?: SessionsCatalogProjectAppearance; readonly projectOperations?: SessionsCatalogProjectOperations; readonly workspace?: URI; readonly catalogProjectId?: string; }): HTMLElement => {
			activeSections.add(key);
			const section = this.sections.get(key) ?? this.sections.set(key, new SessionListSection(ownerDocument, key, kind, this.mode, this.contextMenus,
				collapsed => this.tree.setSectionCollapsed(key, collapsed), key === 'projects' ? this.createListToolbar : undefined));
			const sorted = sortRows(children);
			childrenByRow.set(section.domNode, key === attentionSection ? sorted
				: reorderChildren(sorted, ids => this.listModel.getSessionOrder(this.mode, key, ids), 'rowOrderId'));
			const { open, group, project, projectAppearance, projectOperations, workspace, catalogProjectId } = options ?? {};
			const appearance = project ?? projectAppearance ?? group;
			section.update(title, {
				open,
				actionLabel: open ? localize('sessions.list.openComparison', 'Open comparison {0}', title) : undefined,
				icon: appearance?.icon ? getRegisteredIcon(appearance.icon, ownerDocument) : undefined,
				color: appearance?.color ? `var(${colorCssVariable(appearance.color)})` : undefined,
			});
			if (group) {
				section.domNode.dataset.sectionOrderId = key;
				section.domNode.dataset.groupDropTarget = String(group.kind !== 'comparison');
				section.setContextMenu(anchor => this.showSectionMenu(section, group, anchor));
			}
			if (workspace) {
				section.setContextMenu(anchor => this.showWorkspaceMenu(workspace, anchor));
			}
			if (kind === 'project') {
				if (project) {
					section.setContextMenu(anchor => this.showLocalProjectMenu(title, project, section, anchor));
				} else if (catalogProjectId) {
					section.setContextMenu(anchor => this.showProjectMenu(catalogProjectId, title, projectAppearance && (field =>
						pickProjectAppearance(this.quickInput, field, projectAppearance[field], value => projectAppearance.set(field, value))), projectOperations ?? {}, section, anchor));
				} else {
					section.setContextMenu(undefined);
				}
			}
			return section.domNode;
		};
		const projectRows: HTMLElement[] = [];
		const contributedGroups = new Map<string, readonly HTMLElement[]>();
		const contributedRecent: [HTMLElement, SessionGroupingContext | undefined][] = [];
		const external = this.catalog?.snapshot.get();
		const externalRow = (row: SessionsCatalogRow, project?: string, alert?: IBlockedSession): HTMLElement => {
			const key = project ? JSON.stringify([row.id, project]) : row.id;
			this.catalogRows.set(key, row);
			const item = itemFor(key, 'conversation');
			item.updateCatalogRow(row, alert?.threadId);
			item.target = alert && { sessionId: alert.session.sessionId, threadId: alert.threadId };
			item.setContextMenu(anchor => void this.showCatalogMenu(row, item, anchor));
			if (project) item.domNode.dataset.parentProject = `project:${project}`;
			const value = sort.field === 'name' ? row.title : sort.field === 'created' ? row.createdAt : row.updatedAt ?? row.createdAt;
			if (value !== undefined) sortKeys.set(item.domNode, value);
			return item.domNode;
		};
		const placedAlerts = new Set<string>();
		const catalogRowsFor = (rows: readonly SessionsCatalogRow[], sectionKey: string, project?: { readonly key: string; readonly title: string; }): HTMLElement[] => {
			const children: HTMLElement[] = [];
			for (const row of rows) {
				const alert = sectionKey !== 'pinned' && !row.pinned && !row.disabled && row.sessionId ? alerts.get(row.sessionId) : undefined;
				if (!this.search.matches(row.title, project?.title, alert && attentionLabel)) continue;
				if (!alert) {
					const node = externalRow(row, project?.key);
					if (!project && sectionKey === 'recent' && grouping !== 'none') contributedRecent.push([node, row.groupingContext]);
					children.push(node);
				} else if (!placedAlerts.has(alert.session.sessionId)) {
					placedAlerts.add(alert.session.sessionId);
					attentionRows.push(externalRow(row, project?.key, alert));
				}
			}
			return children;
		};
		for (const section of external?.sections ?? []) {
			const rows = catalogRowsFor(section.rows, section.key);
			if (section.key === 'pinned') pinned.push(...rows);
			else if (section.key === 'recent') {
				if (grouping === 'none') recent.push(...rows);
			}
			else contributedGroups.set(section.key, rows);
			for (const project of section.projects) {
				const children = catalogRowsFor(project.rows, section.key, project);
				if (!children.length && !this.search.matches(project.title)) continue;
				const key = `catalog-project:${project.key}`;
				if (project.onExpand) this.catalogProjects.set(key, { load: project.onExpand });
				else if (project.loadMore) this.catalogProjects.set(key, { load: project.loadMore, anchor: children.at(-1) });
				// Keep the project expandable while its first page is in flight.
				else if (project.loading) this.catalogProjects.set(key, {});
				const action = project.history ?? (project.loadMore && {
					label: localize({ bundle: 'ash.sessions', key: 'sessions.list.moreProjectConversations' }, 'Load more conversations'), action: project.loadMore,
				});
				if (action) {
					const item = itemFor(`${key}:history`, 'project');
					item.update(action.label, false, action.action);
					children.push(item.domNode);
				}
				const node = sectionFor(key, project.title, children, 'project', {
					project: project.localProject, catalogProjectId: project.key, projectAppearance: project.appearance,
					projectOperations: project.operations && {
						...project.operations,
						archive: project.operations.archive && (() => this.commands.executeCommand<boolean>(ARCHIVE_PROJECT_COMMAND, project.key, 'catalog')),
					},
				});
				node.dataset.catalogProject = 'true';
				node.dataset.projectId = project.key;
				node.dataset.item = `project:${project.key}`;
				node.classList.add('ash-chat-navigation-project');
				this.sections.get(key)!.setLoading(project.loading);
				(section.key === 'pinned' ? pinned : projectRows).push(node);
			}
		}
		// Content belongs to the composer store; an open blank welcome page is not a recent conversation.
		// Include parked drafts too, so switching conversations does not hide their only sidebar entry.
		const nestedDrafts = new Map<string, HTMLElement[]>();
		const projectDrafts = new Map<string, HTMLElement[]>();
		for (const session of this.catalog ? [] : this.sessionService.untitledSessions) {
			if (session.kind === 'chat') continue;
			let draft: ReturnType<typeof readNewChatDraftState>;
			try { draft = readNewChatDraftState(this.storage, `untitled:${session.untitledSessionId}`, chatInputStatePersistence); }
			catch { continue; } // The composer reports unreadable drafts; one must not break the whole list.
			if (!session.forkSource && (!draft || (!draft.text.trim() && draft.contexts.length === 0))) continue;
			if (!this.search.matches(session.title)) continue;
			const selected = activeSelection?.kind === 'untitled' && activeSelection.session.untitledSessionId === session.untitledSessionId;
			const item = itemFor(`untitled:${session.untitledSessionId}`, 'draft');
			item.update(localize('sessions.list.draft', '{0} (draft)', session.title || localize('chat.sessions.new', 'New Session')), selected, () => this.openRow(options => this.viewService.openUntitledSession(session.untitledSessionId, options)));
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
		const catalog = getSessionsListEntries(this.catalog ? [] : this.sessionService.sessions.filter(session => session.kind === 'code'), this.listModel,
			activeSelection?.kind === 'session' ? activeSelection.active.session.sessionId : undefined);
		const groupNames = new Map(this.groups.groups.flatMap(group => group.sessionIds.map(id => [id, group.name] as const)));
		const projectNames = new Map(this.projects.flatMap(project => project.sessionIds.map(id => [id, project.name] as const)));
		for (const session of catalog) {
			const isPinned = this.listModel.isSessionPinned(session);
			const alert = isPinned ? undefined : alerts.get(session.sessionId);
			const current = activeSelection?.kind === 'session' && activeSelection.active.session.sessionId === session.sessionId ? activeSelection.active : undefined;
			const activeChats = session.chats.filter(chat => chat.status === 'active');
			const thread = activeChats.find(chat => chat.threadId === session.sessionId)
				?? activeChats.find(chat => chat.origin.type === 'root') ?? activeChats[0];
			if (!thread) continue;
			const workspace = session.workspace;
			const projectName = projectNames.get(session.sessionId)
				?? (workspace ? basename(sessionWorkspaceUri(workspace)) || workspace.root : undefined);
			const requests = this.github.getSessionPullRequests(session.sessionId);
			const fields = [session.title, session.providerLabel, session.workspace?.root, groupNames.get(session.sessionId), projectNames.get(session.sessionId), alert && attentionLabel,
			...requests.map(getPullRequestLabel)];
			const matchesSession = this.search.matches(thread.title, ...fields);
			const nested = activeChats.filter(chat => chat !== thread && chat.origin.type !== 'agentSpawn'
				&& (matchesSession || this.search.matches(chat.title, chat.workspace?.root, ...fields)));
			if (!matchesSession && !nested.length && !nestedDrafts.has(session.sessionId)) continue;
			const item = itemFor(`session:${session.sessionId}`, 'conversation', restingIcon ?? Lxicon.cowork);
			sortKeys.set(item.domNode, sort.field === 'name' ? session.title : sessionSortTime(session, sort.field));
			const target = { sessionId: session.sessionId, threadId: alert?.threadId ?? thread.threadId };
			item.target = target;
			const open = () => this.openRow(options => this.viewService.openSession(target.sessionId, target.threadId, options));
			const management = alert?.reason === 'input' ? activeChats.find(chat => chat.threadId === alert.threadId)?.management ?? session.management : session.management;
			item.update(session.title || localize('sessions.list.untitled', 'Untitled Session'), current?.threadId === thread.threadId, open, management);
			item.setContextMenu(anchor => this.showItemMenu({ kind: 'session', active: { session, threadId: thread.threadId } }, item, anchor));
			item.updatePullRequests(getHighestPriorityPullRequestIcon(requests.map(request => request.icon)), requests.map(getPullRequestLabel).join('\n'));
			this.updateSessionPreview(item, session, thread, projectName);
			const children = nested.map(chat => {
				const child = itemFor(`chat:${JSON.stringify([session.sessionId, chat.threadId])}`, 'conversation', restingIcon ?? Lxicon.chatSession);
				child.target = { sessionId: session.sessionId, threadId: chat.threadId };
				child.update(chat.title || localize('sessions.list.untitledChat', 'Untitled Chat'), current?.threadId === chat.threadId,
					() => this.openRow(options => this.viewService.openSession(session.sessionId, chat.threadId, options)), chat.management);
				this.updateSessionPreview(child, session, chat, projectName);
				child.setContextMenu(anchor => this.showItemMenu({ kind: 'session', active: { session, threadId: chat.threadId } }, child, anchor));
				return child.domNode;
			});
			childrenByRow.set(item.domNode, [...children, ...(nestedDrafts.get(session.sessionId) ?? [])]);
			item.domNode.dataset.rowOrderId = session.sessionId;
			if (isPinned) pinned.push(item.domNode);
			else if (alert) attentionRows.push(item.domNode);
			else remaining.set(session.sessionId, item.domNode);
		}
		const projects = projectRows;
		let hasProjectConversations = projectRows.length > 0;
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
			const destination = this.projectPreferences.isPinned(project.id) ? pinned : projects;
			if (this.mode === 'code') {
				const section = sectionFor(key, project.name, [...members, ...drafts], 'project', { project });
				section.dataset.projectId = project.id;
				destination.push(section);
			} else {
				const item = itemFor(key, 'project');
				item.domNode.dataset.projectId = project.id;
				item.update(project.name, false, () => { void this.commands.executeCommand('sessions.open.projects', project.id).catch(error => this.notifications.error(String(error))); });
				item.updateProjectAppearance(project);
				item.setContextMenu(anchor => this.showLocalProjectMenu(project.name, project, item, anchor));
				destination.push(item.domNode);
			}
		}
		const catalogIds = new Set(catalog.map(session => session.sessionId));
		for (const group of this.groups.groups) {
			const contributed = contributedGroups.get(`group:${group.sectionId}`);
			if (this.catalog ? !contributed : group.sessionIds.length && !group.sessionIds.some(id => catalogIds.has(id))) continue;
			if (group.kind === 'comparison' && !this.listModel.showComparisonGroups) {
				continue;
			}
			const members = [...contributed ?? []];
			for (const id of group.sessionIds) {
				const item = remaining.get(id);
				if (item) { members.push(item); remaining.delete(id); }
			}
			if (this.search.hasQuery && !members.length && !this.search.matches(group.name)) continue;
			(this.mode === 'code' ? recent : chatGroups).push(sectionFor(`group:${group.sectionId}`, group.name, members, this.mode === 'code' ? 'subgroup' : 'section', {
				open: group.kind === 'comparison' ? () => {
					void this.commands.executeCommand(OPEN_SESSION_COMPARISON_COMMAND_ID, group.sectionId).catch(error => this.notifications.error(String(error)));
				} : undefined,
				group,
			}));
		}
		const orderedRecent = reorderChildren(recent, ids => this.sectionOrder.getOrder(this.mode, ids), 'sectionOrderId');
		const groupCodeWorkspaces = this.mode === 'code' && (grouping === 'none' || grouping === 'projects');
		if (groupCodeWorkspaces) {
			// Saved sessions can have a creation workspace without a Code project membership.
			// Use the Session workspace so managed checkouts of the same folder stay together.
			const workspaces = new Map<string, { readonly label: string; readonly resource: URI; readonly rows: HTMLElement[]; }>();
			for (const session of catalog) {
				const row = remaining.get(session.sessionId);
				if (!row || !session.workspace) continue;
				const resource = sessionWorkspaceUri(session.workspace);
				const key = workspaceFolderKey(resource);
				let workspace = workspaces.get(key);
				if (!workspace) {
					workspace = { label: basename(resource) || session.workspace.root, resource, rows: [] };
					workspaces.set(key, workspace);
				}
				workspace.rows.push(row);
				remaining.delete(session.sessionId);
			}
			for (const [key, workspace] of [...workspaces].sort((left, right) => left[1].label.localeCompare(right[1].label))) {
				orderedRecent.push(sectionFor(`workspace:${key}`, workspace.label, workspace.rows, 'subgroup', { workspace: workspace.resource }));
			}
		}
		if (grouping === 'none' || groupCodeWorkspaces) {
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
			const ungrouped = contributedRecent;
			for (const session of catalog) {
				const row = remaining.get(session.sessionId);
				if (row) ungrouped.push([row, session]);
			}
			const repositoryCatalog = grouping === 'repository' ? new Map(this.sessionService.sessions.map(session => [session.sessionId, session])) : undefined;
			if (repositoryCatalog) void this.loadRepositoryGroups(ungrouped.flatMap(([, session]) => session ? [session] : []), repositoryCatalog);
			const buckets = new Map<string, { readonly label: string; readonly rows: HTMLElement[]; }>();
			for (const [row, session] of ungrouped) {
				const context = repositoryCatalog && session ? this.repositoryGroupingContext(session, repositoryCatalog) : session;
				const { id, label } = this.sessionBucket(context, grouping, projectsBySession);
				let bucket = buckets.get(id);
				if (!bucket) {
					bucket = { label, rows: [] };
					buckets.set(id, bucket);
				}
				bucket.rows.push(row);
			}
			for (const [id, bucket] of [...buckets].sort((left, right) => left[1].label.localeCompare(right[1].label))) {
				orderedRecent.push(sectionFor(`grouping:${grouping}:${id}`, bucket.label, bucket.rows, 'subgroup'));
			}
		}
		const showEmpty = orderedRecent.length === 0 && pinned.length === 0 && attentionRows.length === 0 && chatGroups.length === 0 && !hasProjectConversations;
		const loading = this.sessionService.state === 'loading' || external?.loading;
		this.tree.element.setAttribute('aria-busy', String(loading || this.projectsLoading));
		const emptyStatus = loading ? localize('sessions.list.loading', 'Loading sessions…') : this.sessionService.error
			?? (this.search.hasQuery ? localize({ bundle: 'ash.sessions', key: 'sessions.list.searchEmpty' }, 'No matching sessions.') : undefined);
		if (showEmpty && emptyStatus) { this.empty.textContent = emptyStatus; }
		const ordered: HTMLElement[] = [];
		if (pinned.length) ordered.push(sectionFor('pinned', localize('sessions.list.pinned', 'Pinned'), pinned));
		if (attentionRows.length) ordered.push(sectionFor(attentionSection, attentionLabel, attentionRows));
		ordered.push(sectionFor('projects', localize('projects.title', 'Projects'), projects));
		ordered.push(...reorderChildren(chatGroups, ids => this.sectionOrder.getOrder(this.mode, ids), 'sectionOrderId'));
		if (orderedRecent.length || !this.search.hasQuery && (pinned.length || hasProjectConversations)) {
			const label = this.mode === 'chat' && !this.catalog ? localize('sessions.list.chats', 'Chats') : localize('sessions.list.recents', 'Recents');
			ordered.push(sectionFor('recent', label, orderedRecent));
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
			const collapsible = key !== undefined && (!projectSection || rowChildren.length > 0 || this.catalogProjects.has(key));
			let collapsed: ObjectTreeElementCollapseState | undefined;
			if (key !== undefined && collapsible) {
				const saved = this.storage.getBoolean(this.collapseKey(key), StorageScope.PROFILE, element.dataset.catalogProject === 'true');
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
		if (this.catalog) this.catalogPaging.schedule();
		if (this.mode === 'code' || this.catalog) this.syncTreeSelection();
		if (focused?.isConnected && !focused.closest('[hidden]') && ownerDocument.activeElement !== focused) focused.focus({ preventScroll: true });
		else if (focusedRow && !focusedRow.isConnected && this.tree.model.has(SessionsListTree.id(focusedRow))) this.tree.focusRow(focusedRow, true);
		else if (focusedRow?.dataset.section === attentionSection && !attentionRows.length) this.focus();
	}

	private syncTreeSelection(): void {
		const current = this.tree.getVisibleElements().find(element => element.classList.contains('selected'));
		this.tree.setSelection(current ? [SessionsListTree.id(current)] : []);
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
function createSessionsListToolbar(container: HTMLElement, disposables: DisposableStore, menus: IMenuService,
	contextMenus: IContextMenuService, contextKeys: IContextKeyService | undefined,
	menuId: MenuId, submenu: MenuId, getActions: (contributed: readonly IAction[]) => readonly IAction[],
	createProject: IAction | undefined): MenuWorkbenchToolBar {
	const toolbar = disposables.add(new MenuWorkbenchToolBar(container, menus, contextMenus, menuId, {
		ariaLabel: localize('sessions.list.headerActions', 'Sessions List Actions'),
		contextKeyService: contextKeys,
		leadingActions: createProject && [createProject],
		// The popup reads list state even when the submenu has no registered commands.
		menuOptions: { preserveEmptySubmenus: true },
		actionViewItemProvider: (action, options) => {
			if (action === createProject) {
				return new CreateProjectActionViewItem(action, { ...options, iconOnly: true });
			}
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
						iconPlacement: 'trailing',
						getCheckedActionsRepresentation: item => item.id.startsWith('sessions.list.groupBy.') || item.id.startsWith('sessions.list.sort') ? 'radio' : 'checkbox',
					}),
				},
				{ ...options, iconOnly: true },
			);
		},
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

class CreateProjectActionViewItem extends ButtonActionViewItem {
	override render(container: HTMLElement): void {
		super.render(container);
		this.button.domNode.setAttribute('aria-haspopup', 'dialog');
	}
}

function rowMoreAction(run: () => void, project: boolean): IAction {
	const label = project
		? localize('sessions.list.projectActions', 'More project actions')
		: localize('sessions.list.more', 'More actions');
	return { id: 'sessions.list.more', label, tooltip: label, icon: Lxicon.ellipsis, enabled: true, run };
}

class SessionListItem extends AbstractDisposable {
	readonly domNode: HTMLElement;
	target: { readonly sessionId: string; readonly threadId: string; } | undefined;
	readonly button: HTMLButtonElement;
	private readonly actions: WorkbenchToolBar;
	private readonly moreAction: IAction;
	private readonly row: SessionListRowRenderer;
	private readonly pullRequest: HTMLSpanElement;
	private readonly statusAnnouncement: HTMLSpanElement;
	private managementDescription: string | undefined;
	private pullRequestDescription = '';
	private readonly previewHover = new MutableDisposable<IManagedHover>();
	private previewKey: string | undefined;
	private open: () => void = () => { };
	private readonly clickListener;
	private readonly contextListeners;
	private contextMenu: ((anchor: ContextMenuAnchor) => void) | undefined;
	private catalogRow: SessionsCatalogRow | undefined;
	private projectIcon: HTMLSpanElement | undefined;

	describe(children: readonly ISessionsListTreeNode[]): ISessionsListTreeNode {
		const id = this.domNode.dataset.item!;
		const kind = id.startsWith('session:') ? 'session' : id.startsWith('chat:') || this.domNode.classList.contains('ash-chat-navigation-row')
			? 'chat' : id.startsWith('project:') ? 'project' : 'draft';
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
		this.moreAction = rowMoreAction(() => this.contextMenu?.(this.actions.element), kind === 'project');
		if (kind === 'project') this.domNode.classList.add('ash-sessions-list-project-row');
		this.actions.element.classList.add('ash-sessions-list-actions');
		this.actions.element.hidden = true;
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
			addDisposableListener(this.domNode, 'focusout', event => {
				if (!isNode(event.relatedTarget) || !this.domNode.contains(event.relatedTarget)) {
					this.domNode.classList.remove('menu-dismissed-by-pointer');
				}
			}),
			addDisposableListener(this.domNode, 'keydown', event => {
				this.domNode.classList.remove('menu-dismissed-by-pointer');
				if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) showMenu(event);
			}),
		];
	}

	setContextMenu(menu: (anchor: ContextMenuAnchor) => void): void {
		this.contextMenu = menu;
		if (!this.moreButton) this.actions.setActions([this.moreAction]);
		this.moreButton?.setAttribute('aria-haspopup', 'menu');
		if (this.domNode.dataset.projectId && !this.domNode.classList.contains('menu-visible')) {
			this.moreButton?.setAttribute('aria-expanded', 'false');
		}
		this.actions.element.hidden = false;
		if (this.catalogRow) this.setDisabled(!!this.catalogRow.disabled, !!this.catalogRow.actionsDisabled);
	}

	setMenuVisible(visible: boolean): void {
		this.domNode.classList.toggle('menu-visible', visible);
		this.moreButton?.setAttribute('aria-expanded', String(visible));
	}

	dismissMenuFromPointer(): void {
		// The shield can return focus to More without a new browser focus modality.
		this.domNode.classList.toggle('menu-dismissed-by-pointer', this.domNode.matches(':focus-within'));
	}

	get moreButton(): HTMLButtonElement | null {
		return this.actions.element.querySelector('[data-action-id="sessions.list.more"] button');
	}

	getMenuTrigger(anchor: ContextMenuAnchor): HTMLButtonElement | undefined {
		if (anchor === this.button) return this.button;
		const more = this.moreButton;
		return more && (more.matches(':focus') || !!this.domNode.dataset.projectId && anchor === this.actions.element) ? more : undefined;
	}

	setDisabled(disabled: boolean, actionsDisabled: boolean): void {
		this.button.disabled = disabled;
		for (const button of this.domNode.querySelectorAll('button')) {
			if (button !== this.button) button.disabled = disabled || actionsDisabled;
		}
	}

	updateCatalogRow(entry: SessionsCatalogRow, threadId?: string): void {
		const previous = this.catalogRow;
		this.catalogRow = entry;
		this.update(entry.title, entry.selected, () => entry.open(threadId));
		this.domNode.classList.add('ash-chat-navigation-row');
		this.button.classList.add('ash-chat-navigation-item');
		const icon = entry.iconId && getRegisteredIcon(entry.iconId, this.domNode.ownerDocument);
		this.leadingIcon?.setRestingIcon(icon || entry.defaultIcon);
		this.leadingIcon?.setStatus(entry.status);
		if (entry.status) {
			this.managementDescription = entry.status.label;
			this.updateDescription();
		}
		if (entry.setPinned && (!previous?.setPinned || previous.pinned !== entry.pinned)) {
			const label = entry.pinned ? localize('sessions.chatList.unpin', 'Unpin chat') : localize('sessions.chatList.pin', 'Pin chat');
			this.actions.setActions([{
				id: 'sessions.chatList.pin', label, tooltip: label, enabled: true, checked: !!entry.pinned,
				icon: entry.pinned ? Lxicon.pinFilled : Lxicon.pin,
				run: async () => {
					const row = this.catalogRow;
					await row?.setPinned?.(!row.pinned);
					if (this.button.isConnected) this.button.focus({ preventScroll: true });
				},
			}, this.moreAction]);
		} else if (previous?.setPinned && !entry.setPinned) {
			this.actions.setActions([this.moreAction]);
		}
	}

	updateProjectAppearance(project: ProjectSummary): void {
		const icon = (project.icon && getRegisteredIcon(project.icon, this.button.ownerDocument)) || Lxicon.projects;
		if (this.projectIcon?.dataset.ashIconId !== icon.id) {
			this.projectIcon?.remove();
			this.projectIcon = appendIcon(icon, this.button);
			this.button.prepend(this.projectIcon);
		}
		this.projectIcon!.style.color = project.color ? `var(${colorCssVariable(project.color)})` : '';
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
		if (!this.previewHover.value) this.button.title = parts.join('\n');
		this.button.setAttribute('aria-label', parts.join('. '));
	}

	updatePreview(
		hoverService: IHoverService | undefined,
		projectName: string | undefined,
		updatedAt: Date | undefined,
		branchSource?: { readonly key: string; readonly load: (token: CancellationToken) => Promise<string | undefined>; },
	): void {
		if (!hoverService) return;
		const title = this.row.title;
		const timestamp = updatedAt?.getTime() ?? NaN;
		const key = JSON.stringify([title, projectName, timestamp, branchSource?.key]);
		if (this.previewKey === key) return;
		this.previewKey = key;
		const content = createSessionPreviewHover(this.button.ownerDocument, { title, projectName, timestamp, loadBranch: branchSource?.load });
		if (this.previewHover.value) {
			this.previewHover.value.update(content);
		} else {
			this.button.removeAttribute('title');
			this.previewHover.value = hoverService.setupHover({
				target: this.button,
				anchor: this.domNode,
				content,
				anchorAlignment: AnchorAlignment.Left,
				anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
				anchorPosition: AnchorPosition.Below,
			});
		}
	}

	protected override disposeCore(): void {
		this.previewHover.dispose();
		this.leadingIcon?.dispose();
		this.clickListener.dispose();
		this.actions.dispose();
		for (const listener of this.contextListeners) listener.dispose();
		this.row.dispose();
	}
}

type SessionListSectionKind = 'section' | 'subgroup' | 'project';

class SessionListSection extends Disposable {
	readonly domNode: HTMLElement;
	readonly button: HTMLButtonElement;
	readonly toolbar: MenuWorkbenchToolBar | undefined;
	private readonly heading: HTMLElement;
	private readonly label: HTMLElement;
	private readonly icon: HTMLElement;
	private readonly appearanceIcon: HTMLElement;
	private readonly actions: WorkbenchToolBar | undefined;
	private spinner: HTMLSpanElement | undefined;
	private open: (() => void) | undefined;
	private contextMenu: ((anchor: ContextMenuAnchor) => void) | undefined;
	private projectIcon: Icon | undefined;
	private collapsed = true;

	private get subgroup(): boolean { return this.kind !== 'section'; }
	get title(): string { return this.label.textContent ?? ''; }
	get rowClassName(): string { return this.subgroup ? 'ash-sessions-list-subgroup-row' : 'ash-sessions-list-section-row'; }

	constructor(document: Document, key: string, private readonly kind: SessionListSectionKind, private readonly mode: 'chat' | 'code', contextMenus: IContextMenuService,
		toggle: (collapsed?: boolean) => void,
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
		if (kind === 'project') {
			this.domNode.classList.add('ash-sessions-list-project-row');
			this.actions = this._register(new WorkbenchToolBar(this.domNode, contextMenus, {
				ariaLabel: localize('sessions.list.projectActions', 'More project actions'),
			}));
			this.actions.element.classList.add('ash-sessions-list-actions');
			this.actions.element.hidden = true;
			// The toolbar owns activation. A tree click would return focus to the row and dismiss the menu.
			this._register(addDisposableListener(this.actions.element, 'click', event => event.stopPropagation()));
			this.actions.setActions([rowMoreAction(() => {
				if (this.moreButton) this.contextMenu?.(this.moreButton);
			}, true)]);
			this.moreButton?.setAttribute('aria-haspopup', 'menu');
			this.moreButton?.setAttribute('aria-expanded', 'false');
		}
		this._register(addDisposableListener(this.button, 'click', event => {
			event.stopPropagation();
			if (this.open) this.open();
			else if (this.button.hasAttribute('aria-expanded')) toggle();
		}));
		this._register(addDisposableListener(this.domNode, 'contextmenu', event => {
			if (!this.contextMenu) return;
			event.preventDefault();
			event.stopPropagation();
			this.contextMenu({ x: event.clientX, y: event.clientY, targetWindow: getWindow(this.button) });
		}));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.stopPropagation();
				return;
			}
			if (this.contextMenu && (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) {
				event.preventDefault();
				event.stopPropagation();
				const more = this.moreButton;
				this.contextMenu(more && event.target === more ? more : this.button);
			}
		}));
		this._register(addDisposableListener(this.button, 'keydown', event => {
			if (!this.button.hasAttribute('aria-expanded') || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
			event.preventDefault();
			event.stopPropagation();
			toggle(event.key === 'ArrowLeft');
		}));
	}

	setContextMenu(menu: ((anchor: ContextMenuAnchor) => void) | undefined): void {
		this.contextMenu = menu;
		if (this.actions) this.actions.element.hidden = !menu;
		if (menu) this.button.setAttribute('aria-haspopup', 'menu');
		else this.button.removeAttribute('aria-haspopup');
	}

	private get moreButton(): HTMLButtonElement | null | undefined {
		return this.actions?.element.querySelector('[data-action-id="sessions.list.more"] button');
	}

	getMenuTrigger(anchor: ContextMenuAnchor): HTMLButtonElement | undefined {
		if (anchor === this.button) return this.button;
		const more = this.moreButton;
		return more && (anchor === more || more.matches(':focus')) ? more : undefined;
	}

	setMenuVisible(visible: boolean): void {
		this.domNode.classList.toggle('menu-visible', visible);
		this.moreButton?.setAttribute('aria-expanded', String(visible));
	}

	setLoading(loading: boolean): void {
		this.button.setAttribute('aria-busy', String(loading));
		this.icon.classList.toggle('loading', loading);
		if (loading) {
			this.spinner ??= createLoadingSpinner(this.button.ownerDocument);
			if (!this.spinner.parentElement) this.icon.append(this.spinner);
		} else {
			this.spinner?.remove();
		}
	}

	update(title: string, options?: { readonly open?: () => void; readonly actionLabel?: string; readonly icon?: Icon; readonly color?: string; }): void {
		this.open = options?.open;
		this.label.textContent = title;
		this.button.title = options?.actionLabel ?? title;
		if (options?.actionLabel) this.button.setAttribute('aria-label', options.actionLabel);
		else this.button.removeAttribute('aria-label');
		const customIcon = options?.icon;
		const color = options?.color ?? '';
		if (this.kind === 'project') {
			this.projectIcon = customIcon;
			this.icon.style.color = color;
			this.renderIcon();
			return;
		}
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
		this.collapsed = collapsed;
		if (!collapsible && !(this.kind === 'project' && this.contextMenu)) {
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
		}
		if (collapsible) this.button.setAttribute('aria-expanded', String(!collapsed));
		else this.button.removeAttribute('aria-expanded');
		this.renderIcon();
	}

	private renderIcon(): void {
		const chevron = this.collapsed ? Lxicon.chevronRight : Lxicon.chevronDown;
		let icon = chevron;
		if (this.kind === 'project' && this.mode === 'chat') {
			icon = this.collapsed ? Lxicon.projects : Lxicon.projectsFilled;
		} else if (this.subgroup) {
			icon = this.collapsed ? Lxicon.folder : Lxicon.folderOpened;
		}
		icon = this.projectIcon ?? icon;
		const showChevron = this.kind === 'project' && this.button.hasAttribute('aria-expanded');
		const glyphs = this.icon.querySelectorAll(':scope > .ash-icon');
		if (glyphs[0]?.getAttribute('data-ash-icon-id') !== icon.id
			|| glyphs[1]?.getAttribute('data-ash-icon-id') !== (showChevron ? chevron.id : undefined)) {
			for (const glyph of glyphs) glyph.remove();
			appendIcon(icon, this.icon);
			if (showChevron) {
				appendIcon(chevron, this.icon).classList.add('ash-sessions-list-project-chevron');
			}
		}
	}

	protected override disposeCore(): void {
		super.disposeCore();
		this.domNode.remove();
	}
}

class SessionListRowRenderer extends Disposable {
	readonly element: HTMLElement;
	readonly button: HTMLButtonElement;
	private readonly titleText: HTMLSpanElement;
	private readonly titleViewport: HTMLSpanElement;

	constructor(document: Document, titleBehavior: 'static' | 'scrollOnHover', leading?: HTMLElement) {
		super();
		this.element = h(document, 'div', { className: 'ash-sessions-list-row' });
		this.button = h(document, 'button', { className: 'ash-sessions-list-item', attributes: { type: 'button' } });
		this.titleViewport = h(document, 'span', { className: 'ash-sessions-list-label' });
		this.titleText = titleBehavior === 'scrollOnHover' ? h(document, 'span') : this.titleViewport;
		if (titleBehavior === 'scrollOnHover') {
			this.titleViewport.append(this.titleText);
			this._register(observeResize(this.titleViewport, () => this.updateTitleOverflow()));
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
		if (this.titleText !== this.titleViewport && this.titleViewport.isConnected) {
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
class SessionsListTree extends WorkbenchObjectTree<HTMLElement> {
	constructor(container: HTMLElement, title: string, configurationService: IConfigurationService, highlightRows: boolean, scrolling: 'external' | 'managed', dragOptions?: SessionsListDragOptions) {
		const dnd = dragOptions && new SessionsListDragAndDrop(container.ownerDocument, dragOptions);
		super(container, {
			configurationService,
			ariaLabel: title,
			styles: highlightRows ? {
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
		// Move real focus between the nested row buttons when navigating the hierarchy.
		this._register(addDisposableListener(this.element, 'keydown', event => {
			const button = event.target;
			if (!isHTMLElement(button) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
			let target: HTMLElement | undefined;
			if (event.key === 'ArrowRight' && button.matches('.ash-sessions-list-section-toggle[aria-expanded="true"]')) {
				const section = button.closest<HTMLElement>('[data-section]')!;
				target = this.model.getNode(SessionsListTree.id(section))?.children[0]?.element;
			} else if (event.key === 'ArrowLeft' && button.matches('.ash-sessions-list-item')) {
				const row = button.closest<HTMLElement>('[data-item]')!;
				target = this.model.getParent(SessionsListTree.id(row))?.element;
			}
			if (!target) return;
			event.preventDefault();
			event.stopPropagation();
			this.focusRow(target);
		}, true));
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
