import { addDisposableListener, getActiveElement, getWindow, h, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { observeResize } from '../../../../../base/browser/observer.js';
import { disposableWindowTimeout } from '../../../../../base/browser/scheduler.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { createLoadingSpinner } from '../../../../../base/browser/ui/loadingSpinner/loadingSpinner.js';
import { appendIcon, getRegisteredIcon } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { ProgressBar } from '../../../../../base/browser/ui/progressbar/progressbar.js';
import { ScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import type { ObjectTreeElement } from '../../../../../base/browser/ui/tree/objectTreeModel.js';
import { ObjectTreeElementCollapseState } from '../../../../../base/browser/ui/tree/tree.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import type { Icon } from '../../../../../base/common/icon.js';
import { Disposable, DisposableMap, type DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun, type IObservable } from '../../../../../base/common/observable.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';
import type { AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { WorkbenchToolBar } from '../../../../../platform/actions/browser/toolbar.js';
import { IMenuService, type MenuId } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { defaultProgressBarStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { SessionLeadingIcon } from '../../../../browser/ui/sessionLeadingIcon.js';
import type { ISessionStatusIcon } from '../../../../browser/sessionStatusIcon.js';
import { SessionListRowRenderer, SessionListSection, createSessionsListToolbar, SessionsListTree } from './sessionsList.js';
import type { SessionListOrganization } from './sessionsListActions.js';
import '../../../../../base/browser/ui/button/button.css';
import '../media/sessionsCatalogList.css';

export interface SessionsCatalogAccessibility {
	readonly focusContext: string;
	readonly verbositySetting: AccessibilityVerbositySettingId;
	hint(): string;
}

export interface SessionsCatalogRow {
	readonly id: string;
	readonly title: string;
	readonly selected: boolean;
	readonly status?: ISessionStatusIcon;
	readonly disabled?: boolean;
	readonly actionsDisabled?: boolean;
	readonly defaultIcon: Icon;
	readonly iconId?: string;
	readonly setIcon?: (icon: Icon | undefined) => void;
	readonly pinned?: boolean;
	readonly setPinned?: (pinned: boolean) => void | Promise<void>;
	organization(): SessionListOrganization | undefined;
	open(): void;
	getActions(signal: AbortSignal, restoreFocus: () => void): readonly IAction[] | Promise<readonly IAction[]>;
}

export interface SessionsCatalogProject {
	readonly key: string;
	readonly title: string;
	readonly rows: readonly SessionsCatalogRow[];
	readonly loading: boolean;
	readonly history?: { readonly label: string; readonly action?: () => void; };
	readonly onExpand?: () => void;
	readonly loadMore?: () => void;
}

interface SessionsCatalogSection {
	readonly key: string;
	readonly title: string;
	readonly rows: readonly SessionsCatalogRow[];
	readonly projects: readonly SessionsCatalogProject[];
	readonly groupDropTarget: boolean;
	readonly showActions: boolean;
	readonly collapsible: boolean;
}

export interface SessionsCatalogSnapshot {
	readonly sections: readonly SessionsCatalogSection[];
	readonly loading: boolean;
	readonly historyStatus?: string;
}

export interface SessionsCatalogListInput {
	readonly snapshot: IObservable<SessionsCatalogSnapshot>;
	readonly collapseStatePrefix: string;
	readonly headerActions: {
		readonly menu: MenuId;
		readonly submenu: MenuId;
		getActions(contributed: readonly IAction[]): readonly IAction[];
	};
	loadMore(retry: boolean): void;
}

/** Presents an ordered session tree supplied by the host. */
export class SessionsCatalogList extends Disposable {
	private readonly sections = this._register(new DisposableMap<string, SessionListSection>());
	private readonly rows = this._register(new DisposableMap<string, SessionsCatalogRowRenderer>());
	private readonly scrollable: ScrollableElement;
	private readonly scheduleLoad: (retry?: boolean) => void;
	private visible = false;

	constructor(private readonly root: HTMLElement, input: SessionsCatalogListInput, accessibility: SessionsCatalogAccessibility,
		@IConfigurationService configuration: IConfigurationService,
		@IStorageService storage: IStorageService,
		@IMenuService menus: IMenuService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@INotificationService notifications: INotificationService,
		@IContextMenuService contextMenus: IContextMenuService,
	) {
		super();
		const projectRows = this._register(new DisposableMap<string, SessionsCatalogProjectRenderer>());
		const document = root.ownerDocument;
		root.classList.add('ash-chat-navigation');
		const context = this._register(contextKeys.createScoped(root));
		context.createKey(accessibility.focusContext, true);
		this._register(addDisposableListener(root, 'focusin', event => {
			if (!root.contains(event.relatedTarget as Node) && configuration.getValue<boolean>(accessibility.verbositySetting)) {
				status(accessibility.hint());
			}
		}));
		const scrollable = this.scrollable = this._register(new ScrollableElement(root, { direction: 'vertical', vertical: 'auto', tabIndex: -1 }));
		scrollable.element.classList.add('ash-view-pane-scrollable', 'ash-chat-navigation-scrollable');
		const historyStatus = h(document, 'div', { className: 'ash-chat-navigation-history-status', attributes: { role: 'status' } });
		const list = h(document, 'div', { className: 'ash-chat-navigation-list' });
		scrollable.contentElement.append(list);
		const { menu, submenu } = input.headerActions;
		const createToolbar = (container: HTMLElement, disposables: DisposableStore) =>
			createSessionsListToolbar(container, disposables, menus, contextMenus, notifications, context, menu, submenu, actions => input.headerActions.getActions(actions));
		const conversationsLabel = localize('sessions.chatList.conversations', 'Conversations');
		const tree = this._register(new SessionsListTree(list, conversationsLabel, configuration, 'chat', 'external', {
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
				if (!tree.model.has(SessionsListTree.id(row)) && row.dataset.parentProject) {
					const parent = projectRows.get(row.dataset.parentProject)?.element;
					if (parent?.isConnected) { tree.focusRow(parent, preventScroll); return; }
				}
				tree.focusRow(row, preventScroll);
				return;
			}
			list.querySelector<HTMLButtonElement>('.ash-sessions-list-section-toggle')?.focus({ preventScroll });
		};
		const progressHost = h(document, 'div', { className: 'ash-view-pane-progress' });
		scrollable.element.before(progressHost, historyStatus);
		const progress = this._register(new ProgressBar(progressHost, defaultProgressBarStyles));
		progress.element.classList.add('thin');
		progress.element.setAttribute('aria-label', conversationsLabel);
		progress.element.hidden = true;
		const pendingProgress = this._register(new MutableDisposable());
		this._register(addDisposableListener(list, 'keydown', event => {
			const active = getActiveElement(document);
			const child = event.key === 'ArrowLeft' ? active?.closest<HTMLElement>('[data-parent-project]') : undefined;
			const parent = child && tree.model.getParent(SessionsListTree.id(child));
			if (parent) {
				event.preventDefault();
				event.stopPropagation();
				tree.focusRow(parent.element);
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
		let projectPages: readonly { anchor: HTMLElement; load: () => void; }[] = [];
		const loadMoreIfNeeded = (retry: boolean): void => {
			const viewport = scrollable.state;
			if (!this.visible || !viewport.height) { return; }
			if (projectPages.length) {
				const { top, bottom } = scrollable.scrollableElement.getBoundingClientRect();
				const visiblePages = projectPages.filter(({ anchor }) => {
					if (!anchor.isConnected) return false;
					const bounds = anchor.getBoundingClientRect();
					return bounds.top < bottom && bounds.bottom > top;
				});
				for (const { load } of visiblePages) load();
			}
			const last = tree.getVisibleElements().at(-1);
			if (last && tree.isCollapsed(SessionsListTree.id(last))) { return; }
			if (viewport.maximumTop - viewport.top <= 96) {
				input.loadMore(retry);
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
		const collapseKey = (key: string): string => `${input.collapseStatePrefix}${key}.collapsed`;
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
			storage.store(collapseKey(key), collapsed, StorageScope.PROFILE, StorageTarget.MACHINE);
			scrollable.layout();
			scheduleLoad();
		}));
		let menuRow: SessionsCatalogRowRenderer | undefined;
		const beforeOpenMenu = (row: SessionsCatalogRowRenderer): void => {
			if (menuRow !== row) menuRow?.closeTransientUI();
			menuRow = row;
		};
		const render = ({ sections, loading, historyStatus: message = '' }: SessionsCatalogSnapshot): void => {
			const focused = getActiveElement(document) as HTMLElement | null;
			const hadFocus = root.contains(focused);
			const focusedRow = focused?.closest<HTMLElement>('[data-item]');
			const focusedId = focusedRow?.dataset.item;
			const focusedGroup = focused?.closest<HTMLElement>('[data-section]')?.dataset.section;
			const previousVisible = tree.getVisibleElements();
			const top = scrollable.state.top;
			const usedProjectRows = new Set<string>();
			const usedRows = new Set<string>();
			const usedSections = new Set<string>();
			const idleProjects: { row: HTMLElement; load: () => void; }[] = [];
			const nextProjectPages: { anchor: HTMLElement; load: () => void; }[] = [];
			const chatNode = (entry: SessionsCatalogRow, group: string, groupDropTarget: boolean, parentProject?: string): ObjectTreeElement<HTMLElement> => {
				// A conversation can be pinned independently and can belong to more than one local project.
				const rowKey = parentProject ? JSON.stringify([`project:${parentProject}`, entry.id]) : entry.id;
				usedRows.add(rowKey);
				let row = this.rows.get(rowKey);
				if (!row) {
					row = this.rows.set(rowKey, instantiationService.createInstance(SessionsCatalogRowRenderer, document, entry,
						() => focusConversation(rowKey, false, entry.id), beforeOpenMenu));
					row.element.dataset.item = rowKey;
					row.element.dataset.conversationId = entry.id;
					if (parentProject) {
						row.element.dataset.parentProject = `project:${parentProject}`;
						row.element.dataset.parentProjectId = parentProject;
					}
				}
				row.element.dataset.groupDropTarget = String(groupDropTarget);
				row.update(entry, group);
				return { element: row.element };
			};
			const projectNode = (project: SessionsCatalogProject, group: string): ObjectTreeElement<HTMLElement> => {
				const itemId = `project:${project.key}`;
				const collapsed = storage.getBoolean(collapseKey(itemId), StorageScope.PROFILE, true);
				usedProjectRows.add(itemId);
				let row = projectRows.get(itemId);
				if (!row) {
					row = projectRows.set(itemId, new SessionsCatalogProjectRenderer(document, itemId, collapsed => {
						if (collapsed === undefined) tree.toggleCollapsed(itemId);
						else if (collapsed) tree.collapse(itemId);
						else if (!tree.expand(itemId)) {
							const child = tree.model.getNode(itemId)?.children.find(({ element }) => element.isConnected
								&& element.querySelector('button:not([hidden]):not(:disabled)'));
							if (child) tree.focusRow(child.element);
						}
					}));
				}
				row.element.dataset.parentSection = group;
				row.element.dataset.projectId = project.key;
				row.update(project.title, project.loading);
				const nodes = project.rows.map(entry => chatNode(entry, group, false, project.key));
				if (project.onExpand && !collapsed) idleProjects.push({ row: row.element, load: project.onExpand });
				if (project.loadMore && !collapsed) {
					// A page can have no visible chats and still have a continuation.
					nextProjectPages.push({ anchor: nodes.at(-1)?.element ?? row.element, load: project.loadMore });
				}
				if (project.history) nodes.push({ element: row.updateHistory(project.history.label, project.history.action) });
				return {
					element: row.element, children: nodes, collapsible: true,
					collapsed: collapsed ? ObjectTreeElementCollapseState.Collapsed : ObjectTreeElementCollapseState.Expanded,
				};
			};
			const children = sections.map(section => {
				const { key } = section;
				const rows = [...section.rows.map(entry => chatNode(entry, key, section.groupDropTarget)), ...section.projects.map(project => projectNode(project, key))];
				usedSections.add(key);
				let control = this.sections.get(key);
				if (!control) {
					control = this.sections.set(key, new SessionListSection(document, key, 'section',
						collapsed => tree.setSectionCollapsed(key, collapsed), section.showActions ? createToolbar : undefined));
				}
				control.domNode.dataset.groupDropTarget = String(section.groupDropTarget);
				control.update(section.title);
				return {
					element: control.domNode, children: rows, collapsible: section.collapsible,
					collapsed: storage.getBoolean(collapseKey(key), StorageScope.PROFILE, false)
						? ObjectTreeElementCollapseState.Collapsed : ObjectTreeElementCollapseState.Expanded,
				};
			});
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
			projectPages = nextProjectPages;
			tree.setChildren(children);
			// A restored collapse state is applied during the splice, outside the user collapse event.
			for (const element of previousVisible) {
				if (!list.contains(element) && element.dataset.item !== undefined) this.rows.get(element.dataset.item)?.closeTransientUI();
			}
			for (const { row, load } of idleProjects) {
				// Loading can synchronously update the source. Let the tree commit first.
				if (row.isConnected) queueMicrotask(() => {
					if (!this.isDisposed && row.isConnected && !tree.isCollapsed(row.dataset.item!)) load();
				});
			}
			list.setAttribute('aria-busy', String(loading));
			if (historyStatus.textContent !== message) historyStatus.textContent = message;
			if (loading && !pendingProgress.value && progress.element.hidden) {
				pendingProgress.value = disposableWindowTimeout(getWindow(root), () => { progress.element.hidden = false; }, 150);
			} else if (!loading) {
				pendingProgress.clear();
				progress.element.hidden = true;
			}
			scrollable.layout();
			if (focusedId && hadFocus && !root.contains(getActiveElement(document))) { focusConversation(focusedId, true, focusedRow?.dataset.conversationId); }
			if (focusedGroup && !root.contains(getActiveElement(document))) {
				const section = this.sections.get(focusedGroup);
				if (focused && root.contains(focused)) focused.focus({ preventScroll: true });
				else if (section?.button.isConnected) section.button.focus({ preventScroll: true });
				else section?.toolbar?.focus();
			}
			scrollable.scrollTo(0, top);
			scheduleLoad();
		};
		this._register(autorun(reader => render(input.snapshot.read(reader))));
		this._register(storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key.endsWith('.collapsed') && event.key.startsWith(input.collapseStatePrefix)) {
				render(input.snapshot.get());
			}
		}));
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		if (!visible) { for (const [, row] of this.rows) row.closeTransientUI(); }
		this.scrollable.layout();
		this.scheduleLoad();
	}

	focus(): void { this.root.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }
}

class SessionsCatalogProjectRenderer extends SessionListRowRenderer {
	private readonly chevron: HTMLElement;
	private readonly spinner: HTMLSpanElement;
	private readonly history: HTMLElement;
	private readonly historyButton: HTMLButtonElement;
	private readonly historyStatus: HTMLElement;
	private historyAction: (() => void) | undefined;

	constructor(document: Document, id: string, toggle: (collapsed?: boolean) => void) {
		const leading = h(document, 'span', {
			className: 'ash-session-leading-icon ash-chat-navigation-project-icon',
			attributes: { 'aria-hidden': 'true' },
		});
		super(document, 'static', leading);
		this.element.dataset.item = id;
		this.element.classList.add('ash-chat-navigation-project');
		this.button.classList.add('ash-chat-navigation-item');
		appendIcon(Lxicon.projects, leading);
		this.chevron = h(document, 'span', {
			className: 'ash-chat-navigation-project-chevron',
			attributes: { 'aria-hidden': 'true' },
		});
		this.spinner = createLoadingSpinner(document);
		this.spinner.hidden = true;
		leading.append(this.chevron, this.spinner);
		this.setCollapseRenderer(collapsed => this.renderCollapse(collapsed));
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

	update(title: string, loading: boolean): void {
		this.setTitle(title);
		this.button.title = title;
		this.element.classList.toggle('loading', loading);
		this.spinner.hidden = !loading;
		this.button.setAttribute('aria-busy', String(loading));
	}

	private renderCollapse(collapsed: boolean): void {
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

class SessionsCatalogRowRenderer extends Disposable {
	readonly element: HTMLElement;
	private readonly row: SessionListRowRenderer;
	private readonly button: HTMLButtonElement;
	private readonly leadingIcon: SessionLeadingIcon;
	private readonly toolbar: WorkbenchToolBar;
	private readonly more: IAction;
	private readonly menuRequest = this._register(new MutableDisposable());
	private menuVisible = false;
	private entry: SessionsCatalogRow;

	get organization(): SessionListOrganization | undefined {
		return this.entry.organization();
	}

	constructor(document: Document, entry: SessionsCatalogRow, private readonly focus: () => void,
		private readonly beforeOpenMenu: (row: SessionsCatalogRowRenderer) => void,
		@IInstantiationService instantiation: IInstantiationService,
		@IContextMenuService private readonly menus: IContextMenuService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.entry = entry;
		this.leadingIcon = this._register(instantiation.createInstance(SessionLeadingIcon, document, entry.title,
			entry.setIcon && ((icon: Icon | undefined) => this.entry.setIcon?.(icon))));
		const row = this.row = this._register(new SessionListRowRenderer(document, 'scrollOnHover', this.leadingIcon.element));
		this.element = row.element;
		this.element.classList.add('ash-chat-navigation-row');
		this.element.dataset.item = entry.id;
		this.button = row.button;
		this.button.classList.add('ash-chat-navigation-item');
		this._register(addDisposableListener(this.button, 'click', () => this.entry.open()));
		this.more = this.action('more', localize('sessions.chatList.more', 'More actions'), Lxicon.ellipsis,
			() => this.showMore(this.moreButton.matches(':focus-visible')));
		this.toolbar = this._register(new WorkbenchToolBar(this.element, this.menus, {
			ariaLabel: localize('sessions.chatList.conversationActions', 'Actions for {0}', entry.title),
		}));
		this.toolbar.element.classList.add('ash-sessions-list-actions', 'ash-chat-navigation-actions');
		const updateActions = () => {
			const current = this.entry;
			const label = current.pinned ? localize('sessions.chatList.unpin', 'Unpin chat') : localize('sessions.chatList.pin', 'Pin chat');
			const pin = this.action('pin', label, current.pinned ? Lxicon.pinFilled : Lxicon.pin, async () => {
				await current.setPinned?.(!current.pinned);
				focus();
			});
			this.toolbar.setActions(current.setPinned ? [{ ...pin, checked: current.pinned === true }, this.more] : [this.more]);
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
		return this.toolbar.element.querySelector<HTMLButtonElement>(`[data-action-id="${this.more.id}"] button`)!;
	}

	update(entry: SessionsCatalogRow, group: string): void {
		const previous = this.entry;
		this.entry = entry;
		this.element.dataset.parentSection = group;
		if (this.row.title !== entry.title) {
			this.row.setTitle(entry.title);
			this.button.title = entry.title;
			this.leadingIcon.setTitle(entry.title);
			this.toolbar.setAriaLabel(localize('sessions.chatList.conversationActions', 'Actions for {0}', entry.title));
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

	protected override disposeCore(): void {
		this.closeTransientUI();
		super.disposeCore();
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
			const actions = await this.entry.getActions(controller.signal, this.focus);
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
