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
import { isAgentSessionSection, type AgentSessionListItem, type IAgentSessionListItem, type IAgentSessionsModel } from './agentSessionsModel.js';
import { AgentSessionRenderer, AgentSessionsDataSource, agentSessionSectionId } from './agentSessionsViewer.js';

/** Owns the shared Tree and projects session navigation without owning session state. */
export class AgentSessionsControl extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly searchInput: HTMLInputElement;
	private readonly emptyDomNode: HTMLParagraphElement;
	private readonly sessionsList: WorkbenchCompressibleAsyncDataTree<IAgentSessionsModel, AgentSessionListItem>;
	private readonly updates = new TaskQueue();
	private readonly newSessionRequested = this._register(new Emitter<void>());
	readonly onDidRequestNewSession = this.newSessionRequested.event;
	private visible = true;
	private focusRevision = 0;
	private menuItemId: string | undefined;
	private updatePending = false;
	private sectionsBeforeSearch: ReadonlyMap<string, boolean> | undefined;

	constructor(
		container: HTMLElement,
		private readonly model: IAgentSessionsModel,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@IInstantiationService instantiation: IInstantiationService,
		@IStorageService storage: IStorageService,
	) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-agent-sessions-control';
		this.searchInput = h(document, 'input');
		this.searchInput.type = 'search';
		this.searchInput.className = 'ash-agent-sessions-search';
		this.searchInput.placeholder = localize('sessions.list.search', 'Search sessions');
		this.searchInput.setAttribute('aria-label', this.searchInput.placeholder);
		this.domNode.append(this.searchInput);
		const treeContainer = h(document, 'div');
		treeContainer.className = 'ash-agent-sessions-viewer';
		this.domNode.append(treeContainer);
		const renderer = this._register(instantiation.createInstance(AgentSessionRenderer, document, () => {
			const item = this.sessionsList.focus;
			return item && !isAgentSessionSection(item) ? item.id : undefined;
		}));
		this.sessionsList = this._register(instantiation.createInstance(WorkbenchCompressibleAsyncDataTree<IAgentSessionsModel, AgentSessionListItem>, treeContainer,
			new AgentSessionsDataSource(() => this.searchInput.value), {
				ariaLabel: localize('chat.sessions.sidebar', 'Agent sessions'),
				accessibilityProvider: {
					getAriaLabel: item => {
						if (isAgentSessionSection(item)) {
							return item.label;
						}
						return item.description ? localize('chat.sessions.rowLabel', '{0}, {1}', item.title, item.description) : item.title;
					},
				},
				scrolling: 'managed',
				// Session sections are meaningful rows, rather than compressible path segments.
				compressionEnabled: false,
				multipleSelectionSupport: false,
				indent: 0,
				indentGuides: 'none',
				identityProvider: { getId: item => isAgentSessionSection(item) ? `section:${item.id}` : `session:${agentSessionSectionId(item)}:${item.id}` },
				collapseByDefault: item => isAgentSessionSection(item) && storage.getBoolean(`chat.agentSessions.collapsed.${encodeURIComponent(item.id)}`, StorageScope.PROFILE, false),
				getHeight: elements => isAgentSessionSection(elements[0]!) ? 28 : 64,
				expandOnlyOnTwistieClick: elements => !isAgentSessionSection(elements[0]!),
				twistieAdditionalCssClass: item => isAgentSessionSection(item) ? undefined : 'ash-agent-session-no-twistie',
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: item => isAgentSessionSection(item) ? item.label : item.title,
					getCompressedNodeKeyboardNavigationLabel: elements => elements.map(item => isAgentSessionSection(item) ? item.label : item.title).join(' / '),
				},
				renderCompressedElements: elements => renderer.render(elements[0]!),
				reuseRows: true,
				onDidRemoveRow: row => renderer.releaseRow(row),
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
			event.element.open({ preserveFocus: event.editorOptions.preserveFocus });
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
		this.domNode.append(this.emptyDomNode);
		container.append(this.domNode);
		this._register(toDisposable(() => {
			this.updates.clearPending();
			if (this.menuItemId) {
				this.contextMenus.hideContextMenu();
			}
			this.domNode.remove();
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
		this._register(this.model.onDidChange(() => { void this.update().catch(onUnexpectedError); }));
	}

	public focus(): void {
		const revision = this.focusRevision;
		this.sessionsList.domFocus();
		void this.update().then(() => {
			if (this.isDisposed || !this.visible || revision !== this.focusRevision || this.domNode.ownerDocument.activeElement !== this.sessionsList.element) {
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
		const gap = Number.parseFloat(this.domNode.ownerDocument.defaultView!.getComputedStyle(this.domNode).rowGap) || 0;
		this.sessionsList.layout(Math.max(0, height - this.searchInput.offsetHeight - gap), width);
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
			const searching = this.searchInput.value.trim().length > 0;
			if (searching && !this.sectionsBeforeSearch && this.sessionsList.getInput()) {
				this.sectionsBeforeSearch = new Map((this.sessionsList.getNode().children ?? []).map(node => {
					const section = node.element as AgentSessionListItem;
					return [section.id, this.sessionsList.isCollapsed(section) === true];
				}));
			}
			const treeHadFocus = this.sessionsList.domNode.contains(this.domNode.ownerDocument.activeElement);
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
			if (treeHadFocus && this.domNode.ownerDocument.activeElement === this.domNode.ownerDocument.body) {
				this.sessionsList.domFocus();
			}
			// Preserve in-tree navigation; the active chat supplies selection when focus is elsewhere.
			const treeHasFocus = this.sessionsList.domNode.contains(this.domNode.ownerDocument.activeElement);
			if (active && (!treeHasFocus || this.sessionsList.selection.length === 0)) {
				this.sessionsList.setSelection([active]);
			}
			this.updatePending = false;
			const empty = !(this.sessionsList.getNode().children?.length);
			this.emptyDomNode.hidden = !empty;
			if (this.searchInput.value.trim()) {
				this.emptyDomNode.textContent = localize('sessions.list.noResults', 'No matching sessions');
			} else if (this.model.state === 'loading') {
				this.emptyDomNode.textContent = localize('chat.sessions.loading', 'Loading sessions…');
			} else {
				this.emptyDomNode.textContent = this.model.error ?? localize('chat.sessions.empty', 'Start a chat to begin.');
			}
			return true;
		}) ?? false;
	}

	private showContextMenu(item: IAgentSessionListItem, anchor: ContextMenuAnchor, onHide: () => void): void {
		if (this.menuItemId !== undefined) this.contextMenus.hideContextMenu();
		this.menuItemId = item.id;
		const actions = item.getActions();
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
