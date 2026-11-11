import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { TaskQueue } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchCompressibleAsyncDataTree, type WorkbenchCompressibleAsyncDataTreeOptions } from '../../../../../platform/list/browser/listService.js';
import type { ContextMenuAnchor } from '../../../../../base/browser/contextmenu.js';
import { AgentSessionsFilter } from './agentSessionsFilter.js';
import { isAgentSessionSection, type IAgentSession, type IAgentSessionsModel } from './agentSessionsModel.js';
import { prepareSessionOpen } from './agentSessionsOpener.js';
import type { AgentSessionListItem } from './agentSessionsViewer.js';
import { IAgentSessionsService } from './agentSessionsService.js';
import type { IAction } from '../../../../../base/common/actions.js';
import {
	AgentSessionRenderer,
	AgentSessionsAccessibilityProvider,
	AgentSessionsDataSource,
	AgentSessionsDragAndDrop,
	AgentSessionsKeyboardNavigationLabelProvider,
	agentSessionSectionId,
} from './agentSessionsViewer.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';

export interface IAgentSessionsControlOptions {
	getActions(session: IAgentSession): readonly IAction[];
}

/** Owns the shared Tree and projects session navigation without owning session state. */
export class AgentSessionsControl extends Disposable {
	public readonly element: HTMLElement;
	private readonly searchInput: HTMLInputElement;
	private readonly emptyDomNode: HTMLParagraphElement;
	private readonly model: IAgentSessionsModel;
	private readonly sessionOpened = this._register(new Emitter<{ readonly preserveFocus: boolean; }>());
	readonly onDidOpenSession = this.sessionOpened.event;
	private readonly sessionsList: WorkbenchCompressibleAsyncDataTree<IAgentSessionsModel, AgentSessionListItem>;
	private readonly updates = new TaskQueue();
	private readonly newSessionRequested = this._register(new Emitter<void>());
	readonly onDidRequestNewSession = this.newSessionRequested.event;
	private readonly toggleLayoutRequested = this._register(new Emitter<void>());
	readonly onDidRequestToggleLayout = this.toggleLayoutRequested.event;
	private readonly filter: AgentSessionsFilter;
	private readonly header: HTMLElement;
	private visible = true;
	private focusRevision = 0;
	private menuItemId: string | undefined;
	private updatePending = false;
	private sectionsBeforeSearch: Map<string, boolean> | undefined;

	constructor(
		container: HTMLElement,
		private readonly options: IAgentSessionsControlOptions,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@IInstantiationService instantiation: IInstantiationService,
		@IStorageService storage: IStorageService,
		@IEditorService private readonly editors: IEditorService,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
	) {
		super();
		this.model = agentSessionsService.model;
		this.filter = instantiation.createInstance(AgentSessionsFilter);
		const document = container.ownerDocument;
		this.element = h(document, 'div');
		this.element.className = 'ash-agent-sessions-control';
		this.header = h(document, 'header', { className: 'ash-agent-sessions-header' });
		const title = h(document, 'h2');
		title.textContent = localize('chat.sessions.title', 'Sessions');
		const toolbar = h(document, 'div', { className: 'ash-agent-sessions-toolbar' });
		this.header.append(title, toolbar);
		this.element.append(this.header);
		const button = (label: string, icon: typeof Lxicon.add, run: () => void) => this._register(new Button(toolbar, {
			...defaultButtonStyles, presentation: 'quiet', iconOnly: true, label, icon, onClick: run,
		}));
		button(localize('chat.sessions.new', 'New Session'), Lxicon.add, () => this.newSessionRequested.fire()).domNode.classList.add('ash-chat-sessions-new');
		const refresh = button(localize('chat.sessions.refresh', 'Refresh Sessions'), Lxicon.refresh, () => {
			refresh.enabled = false;
			void this.model.refresh!().then(() => this.update()).catch(onUnexpectedError).finally(() => {
				if (!this.isDisposed) refresh.enabled = true;
			});
		});
		refresh.enabled = this.model.refresh !== undefined;
		button(localize('sessions.list.search', 'Search sessions'), Lxicon.search, () => this.searchInput.focus());
		const filter = button(localize('chat.sessions.filter', 'Filter Sessions'), Lxicon.filter, () => {
			if (this.menuItemId !== undefined) this.contextMenus.hideContextMenu();
			this.menuItemId = '@filter';
			filter.domNode.setAttribute('aria-expanded', 'true');
			const choices = [
				['all', localize('chat.sessions.filter.all', 'All Sessions')],
				['running', localize('chat.sessions.filter.running', 'In Progress')],
				['drafts', localize('chat.sessions.drafts', 'Drafts')],
				['pinned', localize('sessions.list.pinned', 'Pinned')],
			] as const;
			this.contextMenus.showContextMenu({
				getAnchor: () => filter.domNode,
				getActions: () => choices.map(([id, label]) => ({
					id, label, tooltip: '', enabled: true, checked: this.filter.selection === id,
					run: () => {
						this.filter.setSelection(id);
						filter.checked = !this.filter.isDefault();
						void this.update().catch(onUnexpectedError);
					},
				})),
				onHide: () => {
					this.menuItemId = undefined;
					filter.domNode.setAttribute('aria-expanded', 'false');
					if (this.visible && !this.isDisposed) filter.focus();
					if (this.updatePending) void this.update().catch(onUnexpectedError);
				},
			});
		});
		filter.domNode.setAttribute('aria-haspopup', 'menu');
		filter.domNode.setAttribute('aria-expanded', 'false');
		filter.checked = !this.filter.isDefault();
		button(localize('chat.sessions.toggleLayout', 'Toggle Session Layout'), Lxicon.layoutSidebarRight, () => this.toggleLayoutRequested.fire());
		this.searchInput = h(document, 'input');
		this.searchInput.type = 'search';
		this.searchInput.className = 'ash-agent-sessions-search';
		this.searchInput.placeholder = localize('sessions.list.search', 'Search sessions');
		this.searchInput.setAttribute('aria-label', this.searchInput.placeholder);
		this.element.append(this.searchInput);
		const treeContainer = h(document, 'div');
		treeContainer.className = 'ash-agent-sessions-viewer';
		this.element.append(treeContainer);
		const renderer = this._register(instantiation.createInstance(AgentSessionRenderer, document, () => {
			const item = this.sessionsList.focus;
			return item && !isAgentSessionSection(item) ? item.id : undefined;
		}));
		const accessibilityProvider = new AgentSessionsAccessibilityProvider();
		this.sessionsList = this._register(instantiation.createInstance(WorkbenchCompressibleAsyncDataTree<IAgentSessionsModel, AgentSessionListItem>, treeContainer,
			new AgentSessionsDataSource(() => this.searchInput.value, item => !this.filter.exclude(item)), {
				ariaLabel: accessibilityProvider.getWidgetAriaLabel(),
				accessibilityProvider,
				scrolling: 'managed',
				// Session sections are meaningful rows, rather than compressible path segments.
				compressionEnabled: false,
				multipleSelectionSupport: false,
				indent: 0,
				indentGuides: 'none',
				// Each section refreshes independently; resource-only IDs need atomic reparenting in AsyncDataTree first.
				identityProvider: { getId: item => isAgentSessionSection(item) ? `section:${item.id}` : `session:${agentSessionSectionId(item)}:${item.id}` },
				collapseByDefault: item => isAgentSessionSection(item) && storage.getBoolean(`chat.agentSessions.collapsed.${encodeURIComponent(item.id)}`, StorageScope.PROFILE, false),
				getHeight: elements => isAgentSessionSection(elements[0]!) ? 28 : 64,
				expandOnlyOnTwistieClick: elements => !isAgentSessionSection(elements[0]!),
				twistieAdditionalCssClass: item => isAgentSessionSection(item) ? undefined : 'ash-agent-session-no-twistie',
				keyboardNavigationLabelProvider: new AgentSessionsKeyboardNavigationLabelProvider(),
				renderCompressedElements: elements => renderer.render(elements[0]!),
				reuseRows: true,
				onDidRemoveRow: row => renderer.releaseRow(row),
				dnd: this._register(instantiation.createInstance(AgentSessionsDragAndDrop)),
			} satisfies WorkbenchCompressibleAsyncDataTreeOptions<AgentSessionListItem>));
		this._register(this.sessionsList.onDidChangeFocus(event => {
			if (event.browserEvent) {
				this.focusRevision++;
			}
			renderer.updateFocus();
		}));
		this._register(renderer.onDidRequestContextMenu(event => this.showContextMenu(event.item, event.anchor, event.onHide)));
		this._register(this.sessionsList.onDidChangeCollapseState(event => {
			if (!event.browserEvent || !isAgentSessionSection(event.element) || this.sectionsBeforeSearch) return;
			storage.store(`chat.agentSessions.collapsed.${encodeURIComponent(event.element.id)}`, event.collapsed, StorageScope.PROFILE, StorageTarget.USER);
		}));
		this._register(renderer.onDidRemoveSession(id => {
			if (this.menuItemId === id) {
				this.contextMenus.hideContextMenu();
			}
		}));
		this._register(this.sessionsList.onDidOpen(event => {
			if (isAgentSessionSection(event.element)) {
				return;
			}
			// Keyboard navigation changes Tree focus; activation opens the conversation.
			if (event.browserEvent.type === 'keydown' && !['Enter', ' '].includes((event.browserEvent as KeyboardEvent).key)) {
				return;
			}
			const preserveFocus = event.editorOptions.preserveFocus === true;
			const open = prepareSessionOpen(this.agentSessionsService, event.element.resource, { preserveFocus });
			if (!open) return;
			const opened = open();
			const notify = () => { if (!this.isDisposed) this.sessionOpened.fire({ preserveFocus }); };
			if (opened) void opened.then(notify).catch(onUnexpectedError);
			else notify();
		}));
		this._register(this.sessionsList.onContextMenu(event => {
			const item = event.element;
			if (!item || isAgentSessionSection(item)) {
				return;
			}
			event.browserEvent.preventDefault();
			event.browserEvent.stopPropagation();
			this.showContextMenu(item, event.anchor, () => { if (this.visible && !this.isDisposed) this.sessionsList.domFocus(); });
		}));
		// Managed list contents can be shorter than their viewport; include that empty space.
		this._register(addDisposableListener(this.sessionsList.domNode, 'dblclick', event => {
			if (event.button === 0 && !(event.target as Element).closest('[role="treeitem"]')) {
				this.newSessionRequested.fire();
			}
		}));
		this.emptyDomNode = h(document, 'p');
		this.emptyDomNode.className = 'ash-agent-sessions-empty';
		this.emptyDomNode.setAttribute('role', 'status');
		this.element.append(this.emptyDomNode);
		container.append(this.element);
		this._register(toDisposable(() => {
			this.updates.clearPending();
			if (this.menuItemId) {
				this.contextMenus.hideContextMenu();
			}
			this.element.remove();
		}));
		this._register(addDisposableListener(this.searchInput, 'input', () => { void this.update().catch(onUnexpectedError); }));
		this._register(addDisposableListener(this.searchInput, 'keydown', event => {
			if (event.key !== 'ArrowDown') {
				return;
			}
			event.preventDefault();
			void this.update().then(() => {
				if (this.isDisposed || !this.visible || document.activeElement !== this.searchInput) {
					return;
				}
				const first = this.sessionsList.getVisibleElements().find(item => !isAgentSessionSection(item));
				if (first) {
					this.sessionsList.setFocus(first, event);
					this.sessionsList.reveal(first);
					this.sessionsList.domFocus();
				}
			}).catch(onUnexpectedError);
		}));
		this._register(this.model.onDidChangeSessions(() => { void this.update().catch(onUnexpectedError); }));
	}

	public focus(): void {
		const revision = this.focusRevision;
		this.sessionsList.domFocus();
		void this.update().then(() => {
			if (this.isDisposed || !this.visible || revision !== this.focusRevision || this.element.ownerDocument.activeElement !== this.sessionsList.element) {
				return;
			}
			const items = this.sessionsList.getVisibleElements();
			const item = this.sessionsList.focus ?? items.find(item => !isAgentSessionSection(item) && item.active) ?? items[0];
			if (item) {
				this.sessionsList.setFocus(item);
				this.sessionsList.reveal(item);
			}
		}).catch(onUnexpectedError);
	}

	public layout(height: number, width: number): void {
		const gap = Number.parseFloat(this.element.ownerDocument.defaultView!.getComputedStyle(this.element).rowGap) || 0;
		this.sessionsList.layout(Math.max(0, height - this.header.offsetHeight - this.searchInput.offsetHeight - gap * 2), width);
	}

	public setVisible(visible: boolean): void {
		if (visible === this.visible) return;
		this.visible = visible;
		if (!visible) {
			this.updates.clearPending();
			if (this.menuItemId) {
				this.contextMenus.hideContextMenu();
			}
		}
		if (visible) {
			void this.update().catch(onUnexpectedError);
		}
	}

	public async update(): Promise<boolean> {
		if (this.isDisposed || !this.visible || this.menuItemId !== undefined) {
			this.updatePending = true;
			return false;
		}
		return await this.updates.scheduleSkipIfCleared(async () => {
			if (this.isDisposed || !this.visible) {
				return false;
			}
			if (this.menuItemId !== undefined) {
				this.updatePending = true;
				return false;
			}
			const searching = this.searchInput.value.trim().length > 0 || !this.filter.isDefault();
			if (searching && !this.sectionsBeforeSearch) {
				const sections = this.sessionsList.getInput() ? this.sessionsList.getNode().children ?? [] : [];
				this.sectionsBeforeSearch = new Map(sections.map(node => {
					const section = node.element as AgentSessionListItem;
					return [section.id, this.sessionsList.isCollapsed(section) === true];
				}));
			}
			const treeHadFocus = this.sessionsList.domNode.contains(this.element.ownerDocument.activeElement);
			const revision = this.focusRevision;
			const focused = this.sessionsList.focus;
			const focusedSessionId = focused && !isAgentSessionSection(focused) ? focused.id : undefined;
			if (this.sessionsList.getInput()) await this.sessionsList.updateChildren(this.model, { deferIfCollapsed: true });
			else {
				await this.sessionsList.setInput(this.model);
			}
			if (this.isDisposed || !this.visible) {
				return false;
			}
			for (const section of this.sessionsList.getNode().children ?? []) {
				const item = section.element as AgentSessionListItem;
				// A restored filter can reveal sections before an unfiltered tree has been shown.
				if (searching && !this.sectionsBeforeSearch?.has(item.id)) {
					this.sectionsBeforeSearch?.set(item.id, this.sessionsList.isCollapsed(item) === true);
				}
				if (searching || this.sectionsBeforeSearch?.get(item.id) === false) {
					await this.sessionsList.expand(item);
				}
				if (!searching && this.sectionsBeforeSearch?.get(item.id) === true) {
					this.sessionsList.collapse(item);
				}
				if (this.sessionsList.isCollapsed(section.element as AgentSessionListItem) === false && !section.children?.length) {
					await this.sessionsList.updateChildren(section.element as AgentSessionListItem);
				}
			}
			if (this.isDisposed || !this.visible) {
				return false;
			}
			if (!searching) {
				this.sectionsBeforeSearch = undefined;
			}
			const items = this.sessionsList.getVisibleElements();
			const previous = items.find(item => !isAgentSessionSection(item) && item.id === focusedSessionId);
			const active = items.find(item => !isAgentSessionSection(item) && item.active);
			// A refresh cannot replay focus captured before more recent keyboard or pointer input.
			if (revision === this.focusRevision) {
				const nextFocused = previous ?? (focusedSessionId ? active : undefined);
				if (nextFocused) {
					this.sessionsList.setFocus(nextFocused);
				}
			}
			if (treeHadFocus && this.element.ownerDocument.activeElement === this.element.ownerDocument.body) {
				this.sessionsList.domFocus();
			}
			// Preserve in-tree navigation; the active chat supplies selection when focus is elsewhere.
			const treeHasFocus = this.sessionsList.domNode.contains(this.element.ownerDocument.activeElement);
			if (active && (!treeHasFocus || this.sessionsList.selection.length === 0)) {
				this.sessionsList.setSelection([active]);
			}
			this.updatePending = false;
			const empty = !(this.sessionsList.getNode().children?.length);
			this.emptyDomNode.hidden = !empty;
			if (searching) {
				this.emptyDomNode.textContent = localize('sessions.list.noResults', 'No matching sessions');
			} else if (this.model.state === 'loading') {
				this.emptyDomNode.textContent = localize('chat.sessions.loading', 'Loading sessions…');
			} else {
				this.emptyDomNode.textContent = this.model.error ?? localize('chat.sessions.empty', 'Start a chat to begin.');
			}
			return true;
		}) ?? false;
	}

	private showContextMenu(item: IAgentSession, anchor: ContextMenuAnchor, onHide: () => void): void {
		if (this.menuItemId !== undefined) this.contextMenus.hideContextMenu();
		this.menuItemId = item.id;
		const actions = [...this.options.getActions(item)];
		if (item.getEditorInput) actions.push({
			id: 'workbench.action.chat.openSessionInEditorGroup',
			label: localize('chat.sessions.openInEditor', 'Open in Editor'),
			tooltip: '', enabled: true,
			run: () => this.editors.openEditor(item.getEditorInput!(), { pinned: true }),
		});
		this.contextMenus.showContextMenu({
			getAnchor: () => anchor, getActions: () => actions, onHide: () => {
				this.menuItemId = undefined;
				onHide();
				if (this.updatePending && !this.isDisposed) {
					void this.update().catch(onUnexpectedError);
				}
			}
		});
	}
}
