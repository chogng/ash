import { addDisposableListener, getActiveElement, getWindow, h, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { observeResize } from '../../../../../base/browser/observer.js';
import { disposableWindowTimeout } from '../../../../../base/browser/scheduler.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { ActionBar } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { LabelActionViewItem } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getRegisteredIcon } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { ProgressBar } from '../../../../../base/browser/ui/progressbar/progressbar.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import type { Icon } from '../../../../../base/common/icon.js';
import { Disposable, DisposableMap, MutableDisposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun, type IObservable } from '../../../../../base/common/observable.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IMenuService } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import type { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { defaultButtonStyles, defaultProgressBarStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { PaneComposite, type PaneCompositeOptions } from '../../../../../workbench/browser/panecomposite.js';
import type { ISessionStatusIcon } from '../../../../browser/sessionStatusIcon.js';
import { SessionLeadingIcon } from '../../../../browser/ui/sessionLeadingIcon.js';
import { SessionListRowRenderer, SessionListSection, SessionsListTree } from './sessionsList.js';
import '../../../../../base/browser/ui/button/button.css';
import '../media/chatNavigationView.css';

export interface ChatNavigationEntry {
	readonly source: string;
	readonly id: string;
	readonly title: string;
	readonly selected: boolean;
	readonly status?: ISessionStatusIcon;
	readonly disabled?: boolean;
	readonly actionsDisabled?: boolean;
	readonly pinned?: boolean;
	readonly defaultIcon: Icon;
	readonly iconId?: string;
	readonly setIcon?: (icon: Icon | undefined) => void;
	readonly open: (signal: AbortSignal) => Promise<void>;
	readonly setPinned?: (pinned: boolean) => void | Promise<void>;
	readonly getActions: (signal: AbortSignal, restoreFocus: () => void) => readonly IAction[] | Promise<readonly IAction[]>;
}

export interface ChatNavigationSnapshot {
	readonly groups: readonly { readonly key: string; readonly title: string; readonly rows: readonly ChatNavigationEntry[]; }[];
	readonly loading?: boolean;
}

/** A disposable sidebar projects provider-owned history and delegates operations back to its source. */
export interface ChatNavigationSource {
	readonly snapshot: IObservable<ChatNavigationSnapshot>;
	attach?(window: Window & typeof globalThis, isVisible: () => boolean): IDisposable;
	loadMore?(retry: boolean): void;
}

export class ChatNavigationViewPaneContainer extends PaneComposite {
	private readonly sections = this._register(new DisposableMap<string, SessionListSection>());
	private readonly rows = this._register(new DisposableMap<string, ChatNavigationRow>());
	private readonly opening = this._register(new MutableDisposable());
	private scheduleLoad: () => void = () => { };

	constructor(adapters: readonly SyncDescriptor<ChatNavigationSource>[], parent: HTMLElement, options: PaneCompositeOptions,
		@IConfigurationService configuration: IConfigurationService,
		@IStorageService storage: IStorageService,
		@IThemeService theme: IThemeService,
		@IMenuService menus: IMenuService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@INotificationService notifications: INotificationService,
	) {
		super(parent, {
			...options, paneLayout: 'content', stateScope: StorageScope.PROFILE, mergeViewWithContainerWhenSingleView: false,
		}, storage, theme, menus, configuration, instantiationService, contextKeys);
		const sources = adapters.map(adapter => instantiationService.createInstance(adapter));
		const root = this.element;
		const document = root.ownerDocument;
		root.classList.add('ash-chatgpt-navigation');
		this.scopedContextKeyService.createKey('chatGPTFocused', true);
		this._register(addDisposableListener(root, 'focusin', event => {
			if (!root.contains(event.relatedTarget as Node) && configuration.getValue<boolean>(AccessibilityVerbositySettingId.ChatGPT)) {
				status(localize('sessions.chatgpt.navigationHint', 'Press Alt+F1 for ChatGPT accessibility help.'));
			}
		}));
		const scrollable = this.scrollable!;
		scrollable.element.classList.add('ash-chatgpt-navigation-scrollable');
		const list = h(document, 'div', { className: 'ash-chatgpt-navigation-list' });
		scrollable.contentElement.append(list);
		const conversationsLabel = localize('sessions.chatgpt.conversations', 'Conversations');
		const tree = this._register(new SessionsListTree(list, conversationsLabel, configuration));
		const focusConversation = (key: string, preventScroll = false): void => {
			if (!root.isConnected || root.closest('[hidden]')) return;
			const row = this.rows.get(key)?.element;
			if (row) {
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
			if (!active || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { return; }
			const header = active.classList.contains('ash-sessions-list-section-toggle');
			const selector = header ? '.ash-sessions-list-section-toggle' : '.ash-chatgpt-conversation';
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
		this._register(tree.onDidChangeCollapseState(({ element, collapsed }) => {
			const key = element.dataset.section;
			if (key === undefined) return;
			if (collapsed) {
				for (const row of this.sections.get(key)?.children ?? []) {
					this.rows.get(row.dataset.item!)?.closeTransientUI();
				}
			}
			storage.store(collapseKey(key), collapsed, StorageScope.PROFILE, StorageTarget.MACHINE);
			scrollable.layout();
			scheduleLoad();
		}));
		const openConversation = (entry: ChatNavigationEntry): void => {
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
		const render = (snapshots: readonly ChatNavigationSnapshot[]): void => {
			const focused = getActiveElement(document) as HTMLElement | null;
			const hadFocus = root.contains(focused);
			const focusedId = focused?.closest<HTMLElement>('[data-item]')?.dataset.item;
			const focusedGroup = focused?.classList.contains('ash-sessions-list-section-toggle')
				? focused.closest<HTMLElement>('[data-group]')?.dataset.group : undefined;
			const top = scrollable.state.top;
			const groups = new Map<string, { title: string; rows: ChatNavigationEntry[]; }>();
			for (const snapshot of snapshots) {
				for (const group of snapshot.groups) {
					const merged = groups.get(group.key);
					if (merged) merged.rows.push(...group.rows);
					else groups.set(group.key, { title: group.title, rows: [...group.rows] });
				}
			}
			const usedRows = new Set<string>();
			const children = [];
			for (const [key, group] of groups) {
				if (!group.rows.length) continue;
				let section = this.sections.get(key);
				if (!section) {
					section = this.sections.set(key, new SessionListSection(document, key, false,
						collapsed => tree.setSectionCollapsed(key, collapsed)));
					section.domNode.classList.add('ash-chatgpt-navigation-group');
					section.domNode.dataset.group = key;
				}
				const rows = group.rows.map(entry => {
					const rowKey = `${entry.source}:${entry.id}`;
					usedRows.add(rowKey);
					let row = this.rows.get(rowKey);
					if (!row) {
						row = this.rows.set(rowKey, instantiationService.createInstance(ChatNavigationRow, document, entry,
							openConversation, () => focusConversation(rowKey), beforeOpenMenu));
					}
					row.update(entry, key);
					return row.element;
				});
				section.update(group.title, rows);
				children.push({
					element: section.domNode,
					children: rows.map(element => ({ element })),
					collapsible: true,
					collapsed: storage.getBoolean(collapseKey(key), StorageScope.PROFILE, false),
				});
			}
			for (const [key, row] of this.rows) {
				if (usedRows.has(key)) continue;
				if (menuRow === row) menuRow = undefined;
				this.rows.deleteAndDispose(key);
			}
			for (const [key] of this.sections) {
				if (!groups.get(key)?.rows.length) this.sections.deleteAndDispose(key);
			}
			tree.setChildren(children);
			for (const [key] of this.sections) {
				tree.setSectionCollapsed(key, storage.getBoolean(collapseKey(key), StorageScope.PROFILE, false));
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
			if (focusedId && hadFocus && !root.contains(getActiveElement(document))) { focusConversation(focusedId, true); }
			if (focusedGroup && !root.contains(getActiveElement(document))) {
				this.sections.get(focusedGroup)?.button.focus({ preventScroll: true });
			}
			scrollable.scrollTo(0, top);
			scheduleLoad();
		};
		const snapshots = () => sources.map(source => source.snapshot.get());
		this._register(autorun(reader => render(sources.map(source => source.snapshot.read(reader)))));
		this._register(storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key.endsWith('.collapsed')
				&& event.key.startsWith(`workbench.viewContainer.${this.id}.${this.id}.`)) {
				render(snapshots());
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


class ChatNavigationRow extends Disposable {
	readonly element: HTMLElement;
	private readonly button: HTMLButtonElement;
	private readonly label: HTMLElement;
	private readonly leadingIcon: SessionLeadingIcon;
	private readonly bar: ActionBar;
	private readonly more: IAction;
	private readonly menuRequest = this._register(new MutableDisposable());
	private menuVisible = false;
	private entry: ChatNavigationEntry;

	constructor(document: Document, entry: ChatNavigationEntry, open: (entry: ChatNavigationEntry) => void, private readonly focus: () => void,
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
		this.element.classList.add('ash-chatgpt-navigation-row');
		this.element.dataset.item = `${entry.source}:${entry.id}`;
		this.element.dataset.conversation = entry.id;
		this.element.dataset.source = entry.source;
		this.button = row.button;
		this.button.classList.add('ash-chatgpt-conversation');
		this.button.dataset.conversation = entry.id;
		this.label = h(document, 'span', { className: 'ash-sessions-list-label' });
		this.button.append(this.label);
		this._register(addDisposableListener(this.button, 'click', () => open(this.entry)));
		this.more = this.action('more', localize('sessions.chatgpt.more', 'More actions'), Lxicon.ellipsis,
			() => this.showMore(this.moreButton.matches(':focus-visible')));
		this.bar = this._register(new ActionBar(this.element, {
			actionViewItemOptions: { buttonStyles: defaultButtonStyles },
			ariaLabel: localize('sessions.chatgpt.conversationActions', 'Actions for {0}', entry.title),
			actionViewItemProvider: action => new LabelActionViewItem(action, { label: '', ariaLabel: action.label }),
		}));
		this.bar.domNode.classList.add('ash-sessions-list-actions', 'ash-chatgpt-conversation-actions');
		const updateActions = () => {
			const current = this.entry;
			const label = current.pinned ? localize('sessions.chatgpt.unpin', 'Unpin chat') : localize('sessions.chatgpt.pin', 'Pin chat');
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

	update(entry: ChatNavigationEntry, group: string): void {
		const previous = this.entry;
		this.entry = entry;
		this.element.dataset.parentSection = group;
		if (this.label.textContent !== entry.title) {
			this.button.title = this.label.textContent = entry.title;
			this.leadingIcon.setTitle(entry.title);
			this.bar.setAriaLabel(localize('sessions.chatgpt.conversationActions', 'Actions for {0}', entry.title));
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
		return { id: `sessions.${this.entry.source}.${id}`, label, tooltip: label, enabled: true, icon, run };
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
