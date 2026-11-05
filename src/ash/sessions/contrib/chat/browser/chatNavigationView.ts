import { addDisposableListener, getActiveElement, getWindow, h, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { disposableWindowTimeout } from '../../../../base/browser/scheduler.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { LabelActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { appendIcon, getRegisteredIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { ProgressBar } from '../../../../base/browser/ui/progressbar/progressbar.js';
import type { ObjectTreeElement } from '../../../../base/browser/ui/tree/objectTreeModel.js';
import { Separator, type IAction } from '../../../../base/common/actions.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import type { Icon } from '../../../../base/common/icon.js';
import { Disposable, DisposableMap, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { IProjectsService } from '../../projects/browser/projectsService.js';
import { localize } from '../../../../nls.js';
import type { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProjectService } from '../../../../platform/projects/common/projectService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { defaultButtonStyles, defaultProgressBarStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { PaneComposite, type PaneCompositeOptions } from '../../../../workbench/browser/panecomposite.js';
import { SessionLeadingIcon } from '../../../browser/ui/sessionLeadingIcon.js';
import { getProjectSessionRows, groupChatList, IChatListCatalog, type ChatListEntry, type ChatListGroup, type ChatListSnapshot } from './chatListModel.js';
import { sessionListProjectActions, sessionProjectOrganization, SessionListRowRenderer, SessionListSection, SessionsListTree, type SessionListOrganization } from '../../sessions/browser/views/sessionsList.js';
import '../../../../base/browser/ui/button/button.css';
import './media/chatNavigationView.css';

export const chatNavigationFocusContext = 'chatNavigationFocused';

export interface ChatNavigationAccessibilityHint {
	readonly verbositySetting: AccessibilityVerbositySettingId;
	hint(): string;
}

export class ChatNavigationViewPaneContainer extends PaneComposite {
	private readonly sections = this._register(new DisposableMap<string, SessionListSection>());
	private readonly rows = this._register(new DisposableMap<string, ChatNavigationRow>());
	private readonly opening = this._register(new MutableDisposable());
	private scheduleLoad: () => void = () => { };

	constructor(accessibility: ChatNavigationAccessibilityHint | undefined, parent: HTMLElement, options: PaneCompositeOptions,
		@IConfigurationService configuration: IConfigurationService,
		@IStorageService storage: IStorageService,
		@IThemeService theme: IThemeService,
		@IMenuService menus: IMenuService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@INotificationService notifications: INotificationService,
		@IChatListCatalog catalog: IChatListCatalog,
		@IProjectsService projects: IProjectsService,
		@IProjectService projectService: IProjectService,
	) {
		super(parent, {
			...options, paneLayout: 'content', stateScope: StorageScope.PROFILE, mergeViewWithContainerWhenSingleView: false,
		}, storage, theme, menus, configuration, instantiationService, contextKeys);
		const { sources } = catalog;
		const projectRows = this._register(new DisposableMap<string, ChatProjectNavigationRow>());
		// A project revision changes whenever its durable session references change.
		const membership = new Map<string, { revision: number; sessionIds?: readonly string[]; failed?: boolean; }>();
		void projects.reload();
		const root = this.element;
		const document = root.ownerDocument;
		root.classList.add('ash-chat-navigation');
		this.scopedContextKeyService.createKey(chatNavigationFocusContext, true);
		if (accessibility) {
			this._register(addDisposableListener(root, 'focusin', event => {
				if (!root.contains(event.relatedTarget as Node) && configuration.getValue<boolean>(accessibility.verbositySetting)) {
					status(accessibility.hint());
				}
			}));
		}
		const scrollable = this.scrollable!;
		scrollable.element.classList.add('ash-chat-navigation-scrollable');
		const list = h(document, 'div', { className: 'ash-chat-navigation-list' });
		scrollable.contentElement.append(list);
		const conversationsLabel = localize('sessions.chatList.conversations', 'Conversations');
		const tree = this._register(new SessionsListTree(list, conversationsLabel, configuration, 'external', {
			organization: element => this.rows.get(element.dataset.item ?? '')?.organization,
			didMove: source => {
				const id = source.dataset.item;
				if (id && source.contains(getActiveElement(document))) focusConversation(id, false, source.dataset.conversationId);
			},
			onError: error => notifications.error(toErrorMessage(error)),
		}));
		const focusConversation = (key: string, preventScroll = false, conversationId?: string): void => {
			if (!root.isConnected || root.closest('[hidden]')) return;
			const row = this.rows.get(key)?.element ?? projectRows.get(key)?.element
				?? tree.getVisibleElements().find(element => element.dataset.item === key || conversationId !== undefined && element.dataset.conversationId === conversationId);
			if (row) {
				if (!row.isConnected && row.dataset.parentProject) {
					const parent = projectRows.get(row.dataset.parentProject)?.element;
					if (parent?.isConnected) { tree.focusRow(parent, preventScroll); return; }
				}
				tree.focusRow(row, preventScroll);
				return;
			}
			list.querySelector<HTMLButtonElement>('.ash-sessions-list-section-toggle')?.focus({ preventScroll });
		};
		const progressHost = h(document, 'div', { className: 'ash-view-pane-progress' });
		scrollable.element.before(progressHost);
		const progress = this._register(new ProgressBar(progressHost, defaultProgressBarStyles));
		progress.element.classList.add('thin');
		progress.element.setAttribute('aria-label', conversationsLabel);
		progress.element.hidden = true;
		const pendingProgress = this._register(new MutableDisposable());
		this._register(addDisposableListener(list, 'keydown', event => {
			const active = getActiveElement(document);
			const parent = active?.closest<HTMLElement>('[data-parent-project]')?.dataset.parentProject;
			if (event.key === 'ArrowLeft' && parent) {
				event.preventDefault();
				event.stopPropagation();
				focusConversation(parent);
				return;
			}
			if (!active || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { return; }
			const header = active.classList.contains('ash-sessions-list-section-toggle');
			const selector = header ? '.ash-sessions-list-section-toggle' : '.ash-chat-navigation-item';
			const items = [...list.querySelectorAll<HTMLButtonElement>(selector)].filter(item => !item.closest('[hidden]') && !item.disabled);
			const index = items.findIndex(item => item === active);
			if (index < 0) { return; }
			event.preventDefault();
			const step = index + (event.key === 'ArrowDown' ? 1 : -1);
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
				: header ? Math.max(0, Math.min(items.length - 1, step)) : (step + items.length) % items.length;
			items[next]?.focus();
		}, true));
		const loadMoreIfNeeded = (retry: boolean): void => {
			const viewport = scrollable.state;
			if (!this.isVisible() || !viewport.height) { return; }
			const last = tree.getVisibleElements().at(-1);
			if (last && tree.isCollapsed(SessionsListTree.id(last))) { return; }
			if (viewport.maximumTop - viewport.top <= 96) {
				for (const source of sources) { source.loadMore?.(retry); }
			}
		};
		const pendingLoad = this._register(new MutableDisposable());
		let retryLoad = false;
		const scheduleLoad = (retry = false): void => {
			retryLoad ||= retry;
			pendingLoad.value = scheduleAtNextAnimationFrame(getWindow(root), () => {
				pendingLoad.clear();
				const retry = retryLoad; retryLoad = false;
				loadMoreIfNeeded(retry);
			});
		};
		this.scheduleLoad = scheduleLoad;
		this._register(scrollable.onDidScroll(event => scheduleLoad(event.current.top !== event.previous.top)));
		this._register(observeResize(scrollable.element, () => scheduleLoad()));
		this._register(observeResize(list, () => { scrollable.layout(); scheduleLoad(); }));
		// Keep the keys written by the previous ViewPane implementation.
		const collapseKey = (key: string): string => this.stateKey(`${this.id}.${key}`, 'collapsed');
		const previousPrefix = 'sessions.chatgpt.navigation.collapsed.';
		for (const previousKey of storage.keys(StorageScope.PROFILE, StorageTarget.MACHINE)) {
			if (!previousKey.startsWith(previousPrefix)) { continue; }
			const key = previousKey.slice(previousPrefix.length);
			if (key && key !== 'projects') {
				const nextKey = collapseKey(key);
				const previous = storage.getBoolean(previousKey, StorageScope.PROFILE);
				if (previous !== undefined && storage.getBoolean(nextKey, StorageScope.PROFILE) === undefined) {
					storage.store(nextKey, previous, StorageScope.PROFILE, StorageTarget.MACHINE);
				}
			}
			storage.remove(previousKey, StorageScope.PROFILE);
		}
		let syncingCollapse = false;
		this._register(tree.onDidChangeCollapseState(({ element, node, collapsed }) => {
			const key = element.dataset.section ?? element.dataset.item;
			if (key === undefined) return;
			if (collapsed) {
				const descendants = [...node.children];
				while (descendants.length) {
					const child = descendants.pop()!;
					this.rows.get(child.element.dataset.item!)?.closeTransientUI();
					descendants.push(...child.children);
				}
			}
			if (!syncingCollapse) storage.store(collapseKey(key), collapsed, StorageScope.PROFILE, StorageTarget.MACHINE);
			scrollable.layout();
			scheduleLoad();
		}));
		const openConversation = (entry: ChatListEntry): void => {
			const controller = new AbortController();
			this.opening.value = toDisposable(() => controller.abort());
			void entry.open(controller.signal).catch(error => {
				if (!controller.signal.aborted) notifications.error(toErrorMessage(error));
			});
		};
		let menuRow: ChatNavigationRow | undefined;
		const beforeOpenMenu = (row: ChatNavigationRow): void => {
			if (menuRow !== row) menuRow?.closeTransientUI();
			menuRow = row;
		};
		const render = (snapshots: readonly ChatListSnapshot[]): void => {
			const focused = getActiveElement(document) as HTMLElement | null;
			const hadFocus = root.contains(focused);
			const focusedRow = focused?.closest<HTMLElement>('[data-item]');
			const focusedId = focusedRow?.dataset.item;
			const focusedGroup = focused?.closest<HTMLElement>('[data-group]')?.dataset.group;
			const top = scrollable.state.top;
			const projectState = projects.state.get();
			const activeProjects = projectState.projects.filter(project => !project.archived);
			const activeIds = new Set(activeProjects.map(project => project.id));
			for (const id of membership.keys()) {
				if (!activeIds.has(id)) membership.delete(id);
			}
			const projectGroups = new Map(groupChatList(snapshots, 'projects')
				.filter(group => group.project).map(group => [group.key, group]));
			const entries = snapshots.flatMap(snapshot => snapshot.entries);
			const projectEntryIds = new Set<string>();
			for (const project of activeProjects) {
				let current = membership.get(project.id);
				if (project.sessionCount && current?.revision !== project.revision) {
					const request = { revision: project.revision, sessionIds: current?.sessionIds, failed: false };
					membership.set(project.id, request);
					current = request;
					const finish = (sessionIds?: readonly string[]) => {
						if (this.isDisposed || membership.get(project.id) !== request) return;
						request.failed = sessionIds === undefined;
						request.sessionIds = sessionIds ?? request.sessionIds;
						render(snapshotsNow());
					};
					void projectService.read(project.id).then(value => finish(value.sessionIds), () => finish());
				} else if (!project.sessionCount) {
					membership.delete(project.id);
					current = undefined;
				}
				const existing = projectGroups.get(project.id);
				const rows = getProjectSessionRows(entries, current?.sessionIds ?? []);
				for (const row of rows) projectEntryIds.add(row.id);
				projectGroups.set(project.id, { key: project.id, title: project.name, rows: [...rows, ...(existing?.rows ?? [])], project: existing?.project });
			}
			const pinnedProjects = [...projectGroups.values()].filter(project => projects.isPinned(project.key));
			const otherProjects = [...projectGroups.values()].filter(project => !projects.isPinned(project.key));
			const groups = [...groupChatList(snapshots, 'chat', pinnedProjects.length > 0)];
			if (!groups.some(group => group.key === 'recent') && entries.some(entry => entry.pinned || entry.projectId || projectEntryIds.has(entry.id))) {
				groups.push({ key: 'recent', title: localize('sessions.chatList.recentGroup', 'Recent'), rows: [] });
			}
			const recent = groups.find(group => group.key === 'recent');
			const grouped = new Set<string>();
			for (const group of snapshots.flatMap(snapshot => snapshot.groups ?? [])) {
				const members = new Set(group.sessionIds);
				const rows = (recent?.rows ?? []).filter(entry => entry.sessionId && members.has(entry.sessionId)
					&& !projectEntryIds.has(entry.id) && !grouped.has(entry.id));
				for (const row of rows) grouped.add(row.id);
				groups.splice(recent ? groups.indexOf(recent) : groups.length, 0, { key: `group:${group.sectionId}`, title: group.name, rows });
			}
			if (otherProjects.length) groups.splice(groups[0]?.key === 'pinned' ? 1 : 0, 0,
				{ key: 'projects', title: localize('projects.title', 'Projects'), rows: [] });
			const usedProjectRows = new Set<string>();
			const usedRows = new Set<string>();
			const usedSections = new Set<string>();
			const idleProjects: { row: HTMLElement; load: () => void; }[] = [];
			const chatNode = (entry: ChatListEntry, group: string, parentProject?: string): ObjectTreeElement<HTMLElement> => {
				// A conversation can be pinned independently and can belong to more than one local project.
				const rowKey = parentProject ? JSON.stringify([`project:${parentProject}`, entry.id]) : entry.id;
				usedRows.add(rowKey);
				let row = this.rows.get(rowKey);
				if (!row) {
					row = this.rows.set(rowKey, instantiationService.createInstance(ChatNavigationRow, document, entry,
						openConversation, () => focusConversation(rowKey, false, entry.id), beforeOpenMenu));
					row.element.dataset.item = rowKey;
					row.element.dataset.conversationId = entry.id;
					if (parentProject) {
						row.element.dataset.parentProject = `project:${parentProject}`;
						row.element.dataset.parentProjectId = parentProject;
					}
				}
				row.element.dataset.groupDropTarget = String(group.startsWith('group:'));
				const project = entry.sessionId ? () => {
					const memberships = activeProjects.filter(project => membership.get(project.id)?.sessionIds?.includes(entry.sessionId!));
					const current = parentProject ?? (memberships.length === 1 ? memberships[0]!.id : undefined);
					return sessionProjectOrganization(projectService, entry.sessionId!, current, activeProjects);
				} : undefined;
				row.update(entry, group, project);
				return { element: row.element };
			};
			const projectNode = (project: ChatListGroup, group: string): ObjectTreeElement<HTMLElement> => {
				const itemId = `project:${project.key}`;
				const collapsed = storage.getBoolean(collapseKey(itemId), StorageScope.PROFILE, true);
				usedProjectRows.add(itemId);
				let row = projectRows.get(itemId);
				if (!row) {
					row = projectRows.set(itemId, new ChatProjectNavigationRow(document, itemId, collapsed => {
						if (collapsed === undefined) tree.toggleCollapsed(itemId);
						else if (collapsed) tree.collapse(itemId);
						else if (!tree.expand(itemId)) {
							const child = tree.getVisibleElements().find(element => element.dataset.parentProject === itemId
								&& element.querySelector('button:not([hidden]):not(:disabled)'));
							if (child) tree.focusRow(child);
						}
					}));
				}
				row.element.dataset.parentSection = group;
				row.element.dataset.projectId = project.key;
				row.update(project.title, collapsed);
				const nodes = project.rows.map(entry => chatNode(entry, group, project.key));
				const current = membership.get(project.key);
				const history = project.project?.history;
				if (history?.state === 'idle' && !collapsed) idleProjects.push({ row: row.element, load: history.load });
				const retry = current?.failed ? () => {
					membership.delete(project.key);
					render(snapshotsNow());
				} : undefined;
				const action = history?.state === 'error' || history?.state === 'more' ? history.load : retry;
				const label = history?.state === 'more' ? localize('sessions.chatList.loadMoreProjectChats', 'Load more project chats')
					: history?.state === 'error' || retry ? localize('sessions.chatList.retryProjectChats', 'Could not load project chats. Retry')
						: history?.state === 'unavailable' ? localize('sessions.chatList.projectChatsOffline', 'Connect to load project chats.')
							: history?.state === 'idle' || history?.state === 'loading' || (current && !current.sessionIds)
								? localize('sessions.chatList.loadingProjectChats', 'Loading project chats…')
								: !nodes.length ? localize('sessions.chatList.emptyProject', 'No chats in this project') : undefined;
				if (label) nodes.push({ element: row.updateHistory(label, action) });
				return { element: row.element, children: nodes, collapsible: true, collapsed };
			};
			const children = groups.map(group => {
				const { key } = group;
				const rows = group.rows.filter(entry => key !== 'recent' || !projectEntryIds.has(entry.id) && !grouped.has(entry.id))
					.map(entry => chatNode(entry, key));
				if (key === 'pinned') rows.push(...pinnedProjects.map(project => projectNode(project, key)));
				if (key === 'projects') rows.push(...otherProjects.map(project => projectNode(project, key)));
				if (!rows.length && key !== 'recent' && !key.startsWith('group:')) return undefined;
				usedSections.add(key);
				let section = this.sections.get(key);
				if (!section) {
					section = this.sections.set(key, new SessionListSection(document, key, false,
						collapsed => tree.setSectionCollapsed(key, collapsed)));
					section.domNode.classList.add('ash-chat-navigation-group');
					section.domNode.dataset.group = key;
				}
				section.domNode.dataset.groupDropTarget = String(key.startsWith('group:'));
				section.update(group.title, rows.map(row => row.element));
				return {
					element: section.domNode, children: rows, collapsible: true,
					collapsed: storage.getBoolean(collapseKey(key), StorageScope.PROFILE, false),
				};
			}).filter(node => node !== undefined);
			for (const [key] of projectRows) {
				if (!usedProjectRows.has(key)) projectRows.deleteAndDispose(key);
			}
			for (const [key, row] of this.rows) {
				if (usedRows.has(key)) continue;
				if (menuRow === row) menuRow = undefined;
				this.rows.deleteAndDispose(key);
			}
			for (const [key] of this.sections) {
				if (!usedSections.has(key)) this.sections.deleteAndDispose(key);
			}
			syncingCollapse = true;
			try {
				tree.setChildren(children);
				for (const section of children) {
					tree.setSectionCollapsed(section.element.dataset.section!, section.collapsed);
					for (const branch of section.children) {
						if (branch.collapsible && tree.isCollapsed(SessionsListTree.id(branch.element)) !== branch.collapsed) {
							tree.toggleCollapsed(SessionsListTree.id(branch.element));
						}
					}
				}
			} finally {
				syncingCollapse = false;
			}
			for (const { row, load } of idleProjects) {
				// Loading can synchronously update the source. Let the tree commit first.
				if (row.isConnected) queueMicrotask(() => {
					if (!this.isDisposed && row.isConnected && !tree.isCollapsed(row.dataset.item!)) load();
				});
			}
			const readingHistory = snapshots.some(snapshot => snapshot.loading);
			list.setAttribute('aria-busy', String(readingHistory));
			if (readingHistory && !pendingProgress.value && progress.element.hidden) {
				pendingProgress.value = disposableWindowTimeout(getWindow(root), () => { progress.element.hidden = false; }, 150);
			} else if (!readingHistory) {
				pendingProgress.clear();
				progress.element.hidden = true;
			}
			scrollable.layout();
			if (focusedId && hadFocus && !root.contains(getActiveElement(document))) { focusConversation(focusedId, true, focusedRow?.dataset.conversationId); }
			if (focusedGroup && !root.contains(getActiveElement(document))) {
				this.sections.get(focusedGroup)?.button.focus({ preventScroll: true });
			}
			scrollable.scrollTo(0, top);
			scheduleLoad();
		};
		const snapshotsNow = () => sources.map(source => source.snapshot.get());
		this._register(autorun(reader => {
			projects.state.read(reader);
			render(sources.map(source => source.snapshot.read(reader)));
		}));
		this._register(storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key.endsWith('.collapsed')
				&& event.key.startsWith(`workbench.viewContainer.${this.id}.${this.id}.`)) {
				render(snapshotsNow());
			}
		}));
		for (const source of sources) {
			if (source.attach) this._register(source.attach(getWindow(root), () => this.isVisible()));
		}
	}

	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (!visible) { for (const [, row] of this.rows) row.closeTransientUI(); }
		this.scrollable?.layout(); this.scheduleLoad();
	}

	public override focus(): void { this.element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }
}


class ChatProjectNavigationRow extends SessionListRowRenderer {
	private readonly label: HTMLElement;
	private readonly chevron: HTMLElement;
	private readonly history: HTMLElement;
	private readonly historyButton: HTMLButtonElement;
	private readonly historyStatus: HTMLElement;
	private historyAction: (() => void) | undefined;

	constructor(document: Document, id: string, toggle: (collapsed?: boolean) => void) {
		const leading = h(document, 'span', {
			className: 'ash-session-leading-icon ash-chat-navigation-project-icon',
			attributes: { 'aria-hidden': 'true' },
		});
		super(document, leading);
		this.element.dataset.item = id;
		this.element.classList.add('ash-chat-navigation-project');
		this.button.classList.add('ash-chat-navigation-item');
		this.label = h(document, 'span', { className: 'ash-sessions-list-label' });
		this.button.append(this.label);
		appendIcon(Lxicon.projects, leading);
		this.chevron = h(document, 'span', {
			className: 'ash-chat-navigation-project-chevron',
			attributes: { 'aria-hidden': 'true' },
		});
		leading.append(this.chevron);
		this._register(addDisposableListener(this.button, 'click', () => toggle()));
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
			event.preventDefault();
			event.stopPropagation();
			toggle(event.key === 'ArrowLeft');
		}));
		this.history = h(document, 'div', { className: 'ash-chat-navigation-project-history' });
		this.history.dataset.item = JSON.stringify([id, 'history']);
		this.history.dataset.parentProject = id;
		this.historyButton = h(document, 'button', {
			className: 'ash-button ash-button-quiet ash-sessions-list-item ash-chat-navigation-item',
			properties: { type: 'button' },
		});
		this.historyStatus = h(document, 'span', { attributes: { role: 'status' } });
		this.history.append(this.historyButton, this.historyStatus);
		this._register(addDisposableListener(this.historyButton, 'click', () => this.historyAction?.()));
		this._register(addDisposableListener(this.historyButton, 'keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
		}));
	}

	update(title: string, collapsed: boolean): void {
		this.button.title = this.label.textContent = title;
		this.button.setAttribute('aria-expanded', String(!collapsed));
		const icon = collapsed ? Lxicon.chevronRight : Lxicon.chevronDown;
		if (this.chevron.firstElementChild?.getAttribute('data-ash-icon-id') !== icon.id) {
			this.chevron.replaceChildren();
			appendIcon(icon, this.chevron);
		}
	}

	updateHistory(label: string, action: (() => void) | undefined): HTMLElement {
		this.historyAction = action;
		this.historyButton.hidden = !action;
		this.historyStatus.hidden = !!action;
		(action ? this.historyButton : this.historyStatus).textContent = label;
		return this.history;
	}
}

class ChatNavigationRow extends Disposable {
	readonly element: HTMLElement;
	private readonly button: HTMLButtonElement;
	private readonly label: HTMLElement;
	private readonly leadingIcon: SessionLeadingIcon;
	private readonly bar: ActionBar;
	private readonly more: IAction;
	private readonly menuRequest = this._register(new MutableDisposable());
	private menuVisible = false;
	private entry: ChatListEntry;
	private project?: () => SessionListOrganization['project'];

	get organization(): SessionListOrganization | undefined {
		if (this.entry.disabled || this.entry.actionsDisabled) return;
		return { ...this.entry, project: this.project?.() ?? this.entry.project };
	}

	constructor(document: Document, entry: ChatListEntry, open: (entry: ChatListEntry) => void, private readonly focus: () => void,
		private readonly beforeOpenMenu: (row: ChatNavigationRow) => void,
		@IInstantiationService instantiation: IInstantiationService,
		@IContextMenuService private readonly menus: IContextMenuService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.entry = entry;
		this.leadingIcon = this._register(instantiation.createInstance(SessionLeadingIcon, document, entry.title,
			entry.setIcon && ((icon: Icon | undefined) => this.entry.setIcon?.(icon))));
		const row = this._register(new SessionListRowRenderer(document, this.leadingIcon.element));
		this.element = row.element;
		this.element.classList.add('ash-chat-navigation-row');
		this.element.dataset.item = entry.id;
		this.button = row.button;
		this.button.classList.add('ash-chat-navigation-item');
		this.label = h(document, 'span', { className: 'ash-sessions-list-label' });
		this.button.append(this.label);
		this._register(addDisposableListener(this.button, 'click', () => open(this.entry)));
		this.more = this.action('more', localize('sessions.chatList.more', 'More actions'), Lxicon.ellipsis,
			() => this.showMore(this.moreButton.matches(':focus-visible')));
		this.bar = this._register(new ActionBar(this.element, {
			actionViewItemOptions: { buttonStyles: defaultButtonStyles },
			ariaLabel: localize('sessions.chatList.conversationActions', 'Actions for {0}', entry.title),
			actionViewItemProvider: action => new LabelActionViewItem(action, { label: '', ariaLabel: action.label }),
		}));
		this.bar.domNode.classList.add('ash-sessions-list-actions', 'ash-chat-navigation-actions');
		const updateActions = () => {
			const current = this.entry;
			const label = current.pinned ? localize('sessions.chatList.unpin', 'Unpin chat') : localize('sessions.chatList.pin', 'Pin chat');
			const pin = this.action('pin', label, current.pinned ? Lxicon.pinFilled : Lxicon.pin, async () => {
				await current.setPinned?.(!current.pinned);
				focus();
			});
			this.bar.setActions(current.setPinned ? [{ ...pin, checked: current.pinned === true }, this.more] : [this.more]);
			this.moreButton.setAttribute('aria-haspopup', 'menu');
			this.moreButton.setAttribute('aria-expanded', String(this.menuVisible));
		};
		this.updateActions = updateActions;
		updateActions();
		const openMenu = (event: Event): void => {
			if (this.moreButton.disabled) return;
			event.preventDefault();
			void this.showMore(event.type === 'keydown');
		};
		this._register(addDisposableListener(this.button, 'contextmenu', openMenu));
		this._register(addDisposableListener(this.button, 'keydown', event => {
			if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openMenu(event);
		}));
	}

	private readonly updateActions: () => void;

	private get moreButton(): HTMLButtonElement {
		return this.bar.domNode.querySelector<HTMLButtonElement>(`[data-action-id="${this.more.id}"] button`)!;
	}

	update(entry: ChatListEntry, group: string, project?: () => SessionListOrganization['project']): void {
		this.project = project;
		const previous = this.entry;
		this.entry = entry;
		this.element.dataset.parentSection = group;
		if (this.label.textContent !== entry.title) {
			this.button.title = this.label.textContent = entry.title;
			this.leadingIcon.setTitle(entry.title);
			this.bar.setAriaLabel(localize('sessions.chatList.conversationActions', 'Actions for {0}', entry.title));
		}
		if (previous.pinned !== entry.pinned || !!previous.setPinned !== !!entry.setPinned) this.updateActions();
		const customIcon = entry.iconId && getRegisteredIcon(entry.iconId, this.element.ownerDocument);
		this.leadingIcon.setRestingIcon(customIcon || entry.defaultIcon);
		this.leadingIcon.setStatus(entry.status);
		const label = entry.status && localize('sessionRow.titleWithStatus', '{0}, {1}', entry.title, entry.status.label);
		if (label) this.button.setAttribute('aria-label', label);
		else this.button.removeAttribute('aria-label');
		for (const button of this.element.querySelectorAll('button')) {
			button.disabled = !!entry.disabled || (button !== this.button && !!entry.actionsDisabled);
		}
		this.element.classList.toggle('selected', entry.selected);
		if (entry.selected) this.button.setAttribute('aria-current', 'page');
		else this.button.removeAttribute('aria-current');
	}

	closeTransientUI(): void {
		this.menuRequest.clear();
		this.leadingIcon.closePicker();
		if (this.menuVisible) this.menus.hideContextMenu();
		this.setMenuExpanded(false);
	}

	override dispose(): void {
		this.closeTransientUI();
		super.dispose();
	}

	private action(id: string, label: string, icon: Icon, run: () => unknown): IAction {
		return { id: `sessions.chatList.${id}`, label, tooltip: label, enabled: true, icon, run };
	}

	private setMenuExpanded(expanded: boolean): void {
		this.element.classList.toggle('menu-visible', expanded);
		this.moreButton.setAttribute('aria-expanded', String(expanded));
	}

	private async showMore(autoSelectFirstItem: boolean): Promise<void> {
		this.beforeOpenMenu(this);
		this.closeTransientUI();
		const controller = new AbortController();
		this.menuRequest.value = toDisposable(() => controller.abort());
		this.setMenuExpanded(true);
		try {
			const actions = [...await this.entry.getActions(controller.signal, this.focus)];
			const project = this.organization?.project;
			if (project && (project.current || project.destinations.length || project.loadDestinations)) {
				try {
					const destinations = project.loadDestinations ? await project.loadDestinations(controller.signal) : project.destinations;
					const organization = sessionListProjectActions(project, destinations, async run => {
						try {
							await run();
							this.focus();
						} catch (error) { this.notifications.error(toErrorMessage(error)); }
					});
					const separator = actions.map(action => action instanceof Separator).lastIndexOf(true);
					actions.splice(separator < 0 ? actions.length : separator, 0, ...organization);
				} catch (error) {
					if (!controller.signal.aborted) this.notifications.error(toErrorMessage(error));
				}
			}
			if (controller.signal.aborted) return;
			if (!this.element.isConnected || this.moreButton.disabled || this.element.closest('[hidden]')) {
				this.setMenuExpanded(false);
				return;
			}
			this.menuVisible = true;
			this.menus.showContextMenu({
				getAnchor: () => this.moreButton,
				autoSelectFirstItem,
				getActions: () => actions,
				onHide: cancelled => {
					this.menuVisible = false;
					this.setMenuExpanded(false);
					if (cancelled && this.element.isConnected && !this.element.closest('[hidden]')) this.moreButton.focus();
				},
			});
		} catch (error) {
			if (controller.signal.aborted) return;
			this.setMenuExpanded(false);
			this.notifications.error(toErrorMessage(error));
		}
	}
}
