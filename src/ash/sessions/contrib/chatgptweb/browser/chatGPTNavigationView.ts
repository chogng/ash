import { defaultButtonStyles, defaultProgressBarStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { addDisposableListener, getActiveElement, getWindow, h, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { disposableWindowInterval, disposableWindowTimeout } from '../../../../base/browser/scheduler.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { PaneComposite, type PaneCompositeOptions } from '../../../../workbench/browser/panecomposite.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { LabelActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getRegisteredIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { SubmenuAction, type IAction } from '../../../../base/common/actions.js';
import type { Icon } from '../../../../base/common/icon.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import type { ChatGPTConversation } from './chatGPTClient.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IChatGPTService, chatGPTNavigationContainerId, selectedChatConversationId, type ChatGPTState } from './chatGPTService.js';
import type { ISessionStatusIcon } from '../../../browser/sessionStatusIcon.js';
import { SessionLeadingIcon } from '../../../browser/ui/sessionLeadingIcon.js';
import { SessionListRowRenderer, SessionListSection, SessionsListTree } from '../../sessions/browser/views/sessionsList.js';
import { ProgressBar } from '../../../../base/browser/ui/progressbar/progressbar.js';
import { ASH_CHAT_SELECTED_CONTEXT } from '../../chat/common/constants.js';
import '../../../../base/browser/ui/button/button.css';
import './media/chatGPTNavigationView.css';

const moreActionsSelector = '[data-action-id="sessions.chatgpt.more"] button';

interface ConversationGroup {
	readonly key: string;
	readonly title: string;
	readonly conversations: readonly ChatGPTConversation[];
}

/** Retains ChatGPT's history, scroll, and focus while the workspace is inactive. */
export class ChatGPTNavigationViewPaneContainer extends PaneComposite {
	private readonly sections = this._register(new DisposableMap<string, ChatGPTNavigationGroup>());
	private scheduleLoad: () => void = () => { };

	constructor(parent: HTMLElement, options: PaneCompositeOptions,
		@IChatGPTService chat: IChatGPTService,
		@IEditorService editors: IEditorService,
		@ICommandService commands: ICommandService,
		@IConfigurationService configuration: IConfigurationService,
		@IStorageService storage: IStorageService,
		@IThemeService theme: IThemeService,
		@IMenuService menus: IMenuService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super(parent, { ...options, paneLayout: 'content', stateScope: StorageScope.PROFILE, mergeViewWithContainerWhenSingleView: false }, storage, theme, menus, configuration, instantiationService, contextKeys);
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
		const focusConversation = (id: string, preventScroll = false): void => {
			if (!root.isConnected || root.closest('[hidden]')) return;
			for (const [, group] of this.sections) {
				const row = group.section.children.find(element => element.dataset.conversation === id);
				if (!row) continue;
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
			const state = chat.state.get();
			const viewport = scrollable.state;
			if (!this.isVisible() || !viewport.height || !state.connected || state.busy || state.sending || state.managing || !state.hasMore || (!retry && state.error)) { return; }
			const last = tree.getVisibleElements().at(-1);
			if (last && tree.isCollapsed(SessionsListTree.id(last))) { return; }
			if (viewport.maximumTop - viewport.top <= 96) { void chat.loadMore(); }
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
		const collapseKey = (key: string): string => this.stateKey(`${chatGPTNavigationContainerId}.${key}`, 'collapsed');
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
			if (collapsed) this.sections.get(key)?.closeTransientUI();
			storage.store(collapseKey(key), collapsed, StorageScope.PROFILE, StorageTarget.MACHINE);
			scrollable.layout();
			scheduleLoad();
		}));
		const openConversation = (id: string): void => {
			void commands.executeCommand('sessions.show.chatgpt').then(() => chat.select(id)).then(() => editors.focusActiveEditor());
		};
		const render = (state: ChatGPTState): void => {
			const focused = getActiveElement(document) as HTMLElement | null;
			const hadFocus = root.contains(focused);
			const focusedId = focused?.closest<HTMLElement>('[data-conversation]')?.dataset.conversation;
			const focusedGroup = focused?.classList.contains('ash-sessions-list-section-toggle') ? focused.closest<HTMLElement>('[data-group]')?.dataset.group : undefined;
			const top = scrollable.state.top;
			const groups = this.groups(state);
			const wanted = new Set(groups.map(group => group.key));
			const showSelection = !contextKeys.getValue(ASH_CHAT_SELECTED_CONTEXT);
			for (const [key] of this.sections) {
				if (!wanted.has(key)) { this.sections.deleteAndDispose(key); }
			}
			tree.setChildren(groups.map(group => {
				let view = this.sections.get(group.key);
				if (!view) {
					view = this.sections.set(group.key, instantiationService.createInstance(ChatGPTNavigationGroup, document, group.key,
						(collapsed?: boolean) => tree.setSectionCollapsed(group.key, collapsed), openConversation, focusConversation));
				}
				view.render(group, state, showSelection);
				return {
					element: view.section.domNode,
					children: view.section.children.map(element => ({ element })),
					collapsible: true,
					collapsed: storage.getBoolean(collapseKey(group.key), StorageScope.PROFILE, false),
				};
			}));
			for (const group of groups) {
				tree.setSectionCollapsed(group.key, storage.getBoolean(collapseKey(group.key), StorageScope.PROFILE, false));
			}
			const readingHistory = state.loading?.kind === 'history';
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
				this.sections.get(focusedGroup)?.section.button.focus({ preventScroll: true });
			}
			scrollable.scrollTo(0, top);
			scheduleLoad();
		};
		this._register(autorun(reader => render(chat.state.read(reader))));
		this._register(storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key.endsWith('.collapsed')
				&& event.key.startsWith(`workbench.viewContainer.${this.id}.${chatGPTNavigationContainerId}.`)) {
				render(chat.state.get());
			}
		}));
		const selectionKeys = new Set([ASH_CHAT_SELECTED_CONTEXT]);
		this._register(contextKeys.onDidChangeContext(event => { if (event.affectsSome(selectionKeys)) render(chat.state.get()); }));
		const window = getWindow(root);
		chat.setNetworkAvailable(window.navigator.onLine);
		chat.initialize();
		const refresh = (): void => {
			if (chat.state.get().pendingSync || document.visibilityState === 'visible' && this.isVisible()) { void chat.refresh(); }
		};
		let blurred = false;
		this._register(addDisposableListener(window, 'blur', () => { blurred = true; }));
		this._register(addDisposableListener(window, 'focus', () => {
			if (!blurred) { return; }
			blurred = false;
			refresh();
		}));
		this._register(addDisposableListener(window, 'offline', () => chat.setNetworkAvailable(false)));
		this._register(addDisposableListener(window, 'online', () => { chat.setNetworkAvailable(true); refresh(); }));
		this._register(addDisposableListener(document, 'visibilitychange', refresh));
		this._register(disposableWindowInterval(window, refresh, 60_000));
	}

	private groups(state: ChatGPTState): readonly ConversationGroup[] {
		const buckets = new Map<string, ChatGPTConversation[]>();
		const projects = new Set(state.projects.map(project => project.id));
		for (const conversation of state.conversations) {
			const key = conversation.pinned ? 'pinned' : conversation.projectId && (conversation.projectId.startsWith('g-p-') || projects.has(conversation.projectId))
				? (projects.has(conversation.projectId) ? conversation.projectId : 'other') : 'recent';
			const items = buckets.get(key) ?? []; items.push(conversation); buckets.set(key, items);
		}
		return [
			{ key: 'pinned', title: localize('sessions.chatgpt.pinnedGroup', 'Pinned') },
			...state.projects.map(project => ({ key: project.id, title: project.title })),
			{ key: 'other', title: localize('sessions.chatgpt.otherProjects', 'Other projects') },
			{ key: 'recent', title: localize('sessions.chatgpt.recentGroup', 'Recent') },
		].flatMap(group => { const conversations = buckets.get(group.key); return conversations?.length ? [{ ...group, conversations }] : []; });
	}

	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (!visible) { for (const [, group] of this.sections) group.closeTransientUI(); }
		this.scrollable?.layout(); this.scheduleLoad();
	}

	public override focus(): void { this.element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }
}

interface ConversationRowTemplate {
	readonly element: HTMLElement;
	readonly titleButton: HTMLButtonElement;
	readonly leadingIcon: SessionLeadingIcon;
}

/** One ordinary ViewPane per group, with content-sized rows and no custom header implementation. */
class ChatGPTNavigationGroup extends Disposable {
	readonly section: SessionListSection;
	private readonly rows = this._register(new DisposableStore());
	private conversations: readonly ChatGPTConversation[] = [];
	private sessionRows: readonly ConversationRowTemplate[] = [];
	private readonly loadingStatus: ISessionStatusIcon = {
		label: localize('sessions.loadingConversation', 'Loading conversation…'),
		kind: 'inProgress',
		icon: Lxicon.sync,
	};
	private readonly replyingStatus: ISessionStatusIcon = {
		label: localize('sessions.chatgpt.replying', 'ChatGPT is replying…'),
		kind: 'inProgress',
		icon: Lxicon.sync,
	};
	private readonly workingStatus: ISessionStatusIcon = {
		label: localize('sessions.chat.coworkRunning', 'Cowork is working…'),
		kind: 'inProgress',
		icon: Lxicon.sync,
	};
	private menuGeneration = 0;
	private menuRow: HTMLElement | undefined;
	private readonly menuLoad = this._register(new MutableDisposable());
	constructor(private readonly document: Document, key: string, toggle: (collapsed?: boolean) => void,
		private readonly openConversation: (id: string) => void,
		private readonly focusConversation: (id: string) => void,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IChatGPTService private readonly chat: IChatGPTService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IDialogService private readonly dialogs: IDialogService,
		@IClipboardService private readonly clipboard: IClipboardService,
	) {
		super();
		this.section = this._register(new SessionListSection(document, key, false, toggle));
		this.section.domNode.classList.add('ash-chatgpt-navigation-group');
		this.section.domNode.dataset.group = key;
		this._register(toDisposable(() => { if (this.menuRow) { this.contextMenus.hideContextMenu(); } }));
	}

	closeTransientUI(): void {
		this.menuGeneration++;
		this.menuLoad.clear();
		for (const row of this.sessionRows) { row.leadingIcon.closePicker(); }
		if (this.menuRow) { this.contextMenus.hideContextMenu(); }
	}

	public render(group: ConversationGroup, state: ChatGPTState, showSelection: boolean): void {
		const conversations = group.conversations;
		if (conversations.length !== this.conversations.length || conversations.some((conversation, index) => conversation !== this.conversations[index])) {
			this.rows.clear();
			this.conversations = conversations;
			this.sessionRows = conversations.map(conversation => this.createRow(conversation));
		}
		const current = selectedChatConversationId(state);
		const coworkRunning = state.coworkStarting || state.coworkTasks.some(task => {
			const status = task.thread?.turns.at(-1)?.status;
			return status === 'created' || status === 'running' || status === 'cancelling';
		});
		for (const [index, row] of this.sessionRows.entries()) {
			const id = conversations[index]!.id;
			const selected = id === current;
			const iconStatus = state.loading?.kind === 'conversation' && state.loading.id === id ? this.loadingStatus
				: selected && state.sending ? this.replyingStatus
					: selected && coworkRunning ? this.workingStatus : undefined;
			row.leadingIcon.setStatus(iconStatus);
			const label = iconStatus ? localize('sessionRow.titleWithStatus', '{0}, {1}', conversations[index]!.title, iconStatus.label) : null;
			if (row.titleButton.getAttribute('aria-label') !== label) {
				if (label === null) { row.titleButton.removeAttribute('aria-label'); }
				else { row.titleButton.setAttribute('aria-label', label); }
			}
			for (const button of row.element.querySelectorAll('button')) {
				button.disabled = state.sending || state.managing || (state.busy && button !== row.titleButton);
			}
			row.element.classList.toggle('selected', selected && showSelection);
			if (selected && showSelection) { row.titleButton.setAttribute('aria-current', 'page'); }
			else { row.titleButton.removeAttribute('aria-current'); }
		}
		this.section.update(group.title, this.sessionRows.map(row => row.element));
	}

	private createRow(conversation: ChatGPTConversation): ConversationRowTemplate {
		const document = this.document;
		const leadingIcon = this.renderRowIcon(document, conversation);
		const { element: row, button: item } = this.rows.add(new SessionListRowRenderer(document, leadingIcon.element));
		row.classList.add('ash-chatgpt-navigation-row');
		row.dataset.conversation = conversation.id;
		row.dataset.item = `conversation:${conversation.id}`;
		row.dataset.parentSection = this.section.domNode.dataset.section;
		item.classList.add('ash-chatgpt-conversation');
		item.title = conversation.title;
		item.dataset.conversation = conversation.id;
		item.append(h(document, 'span', { className: 'ash-sessions-list-label' }, conversation.title));
		this.rows.add(addDisposableListener(item, 'click', () => this.openConversation(conversation.id)));
		const more = this.action('more', localize('sessions.chatgpt.more', 'More actions'), () => this.showMore(row, conversation), Lxicon.ellipsis);
		// The glyph shows the current pin state; the label describes the action.
		const pin = this.action('pin', conversation.pinned ? localize('sessions.chatgpt.unpin', 'Unpin chat') : localize('sessions.chatgpt.pin', 'Pin chat'),
			async () => {
				await this.chat.setPinned(conversation.id, !conversation.pinned);
				this.focusConversation(conversation.id);
			}, conversation.pinned ? Lxicon.pinned : Lxicon.unpin);
		const bar = this.rows.add(new ActionBar(row, {
			actionViewItemOptions: { buttonStyles: defaultButtonStyles },
			actions: conversation.id.startsWith('pending:') ? [more] : [{ ...pin, checked: conversation.pinned === true }, more],
			ariaLabel: localize('sessions.chatgpt.conversationActions', 'Actions for {0}', conversation.title),
			actionViewItemProvider: action => new LabelActionViewItem(action, { label: '', ariaLabel: action.label }),
		}));
		bar.domNode.classList.add('ash-sessions-list-actions', 'ash-chatgpt-conversation-actions');
		const trigger = bar.domNode.querySelector<HTMLButtonElement>(moreActionsSelector)!;
		trigger.setAttribute('aria-haspopup', 'menu');
		trigger.setAttribute('aria-expanded', 'false');
		const openMenu = (event: Event): void => {
			if (trigger.disabled) { return; }
			event.preventDefault();
			void this.showMore(row, conversation);
		};
		this.rows.add(addDisposableListener(item, 'contextmenu', openMenu));
		this.rows.add(addDisposableListener(item, 'keydown', event => {
			if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
				openMenu(event);
			}
		}));
		return { element: row, titleButton: item, leadingIcon };
	}

	private renderRowIcon(document: Document, conversation: ChatGPTConversation): SessionLeadingIcon {
		const iconId = this.chat.observeConversationIcon(conversation.id);
		const leading = this.rows.add(this.instantiation.createInstance(SessionLeadingIcon, document, conversation.title,
			iconId ? (icon: Icon | undefined) => this.chat.setConversationIcon(conversation.id, icon?.id) : undefined));
		const defaultIcon = conversation.id.startsWith('local:') ? Lxicon.cowork : Lxicon.chat;
		if (iconId) {
			this.rows.add(autorun(reader => {
				const id = iconId.read(reader);
				leading.setRestingIcon((id ? getRegisteredIcon(id, document) : undefined) ?? defaultIcon);
			}));
		} else {
			leading.setRestingIcon(defaultIcon);
		}
		return leading;
	}

	private action(id: string, label: string, run: () => unknown, icon?: IAction['icon']): IAction {
		return { id: `sessions.chatgpt.${id}`, label, tooltip: label, enabled: true, icon, run };
	}

	private async showMore(row: HTMLElement, conversation: ChatGPTConversation): Promise<void> {
		const generation = ++this.menuGeneration;
		const controller = new AbortController();
		this.menuLoad.value = toDisposable(() => controller.abort());
		row.classList.add('menu-visible');
		let trigger = row.querySelector<HTMLButtonElement>(moreActionsSelector)!;
		trigger.setAttribute('aria-expanded', 'true');
		const state = this.chat.state.get();
		const deleteOnly = conversation.id.startsWith('pending:') || !conversation.local && (!state.connected || !state.networkAvailable);
		let projects: readonly IAction[];
		try {
			projects = (conversation.local || deleteOnly ? [] : await this.chat.listProjects(controller.signal)).map(project => ({
				...this.action(`move.${project.id}`, project.title, () => this.chat.moveToProject(conversation.id, project.id)),
				checked: project.id === conversation.projectId,
			}));
			if (!projects.length) {
				projects = [{ ...this.action('noProjects', localize('sessions.chatgpt.noProjects', 'No projects'), () => { }), enabled: false }];
			}
		} catch {
			projects = [{ ...this.action('projectsUnavailable', localize('sessions.chatgpt.projectsUnavailable', 'Could not load projects. Reopen the menu to retry.'), () => { }), enabled: false }];
		}
		if (controller.signal.aborted || this.isDisposed || generation !== this.menuGeneration) {
			row.classList.remove('menu-visible'); trigger.setAttribute('aria-expanded', 'false'); return;
		}
		// Refreshing project names can regroup the rows while the menu is loading.
		if (!row.isConnected) {
			const replacement = this.section.children.find(item => item.dataset.conversation === conversation.id);
			if (!replacement) { return; }
			row = replacement;
			trigger = row.querySelector<HTMLButtonElement>(moreActionsSelector)!;
			row.classList.add('menu-visible'); trigger.setAttribute('aria-expanded', 'true');
		}
		this.menuRow = row;
		this.contextMenus.showContextMenu({
			getAnchor: () => trigger,
			getActions: () => deleteOnly ? [
				this.action('delete', localize('sessions.chatgpt.delete', 'Delete'), () => this.deleteConversation(conversation)),
			] : [
				this.action('rename', localize('sessions.chatgpt.rename', 'Rename'), () => this.rename(conversation)),
				...(conversation.local ? [] : [this.action('share', localize('sessions.chatgpt.share', 'Share'), () => this.share(conversation))]),
				this.action('archive', localize('sessions.chatgpt.archive', 'Archive'), () => this.chat.archive(conversation.id)),
				this.action('delete', localize('sessions.chatgpt.delete', 'Delete'), () => this.deleteConversation(conversation)),
				...(conversation.local ? [] : [new SubmenuAction('sessions.chatgpt.moveToProject', localize('sessions.chatgpt.moveToProject', 'Move to project'), projects)]),
			],
			onHide: cancelled => {
				if (this.menuRow === row) { this.menuRow = undefined; }
				row.classList.remove('menu-visible'); trigger.setAttribute('aria-expanded', 'false');
				if (cancelled && trigger.isConnected && !trigger.closest('[hidden]') && !this.isDisposed) { trigger.focus(); }
			},
		});
	}

	private async rename(conversation: ChatGPTConversation): Promise<void> {
		const title = await this.quickInput.input({
			title: localize('sessions.chatgpt.rename', 'Rename'), value: conversation.title,
			validateInput: async value => value.trim() && value.trim().length <= 256 ? undefined : localize('sessions.chatgpt.invalidTitle', 'Enter a name between 1 and 256 characters.'),
		});
		if (title !== undefined) { await this.chat.rename(conversation.id, title); }
		this.focusConversation(conversation.id);
	}

	private async deleteConversation(conversation: ChatGPTConversation): Promise<void> {
		const result = await this.dialogs.confirm({
			message: localize('sessions.chatgpt.deleteConfirm', 'Delete “{0}”?', conversation.title),
			detail: localize('sessions.chatgpt.deleteDetail', 'This chat will be permanently deleted.'),
			primaryButton: localize('sessions.chatgpt.delete', 'Delete'),
		});
		if (result.confirmed) { await this.chat.deleteConversation(conversation.id); }
	}

	private async share(conversation: ChatGPTConversation): Promise<void> {
		const result = await this.dialogs.confirm({
			message: localize('sessions.chatgpt.shareConfirm', 'Share “{0}”?', conversation.title),
			detail: localize('sessions.chatgpt.shareDetail', 'Anyone with the link may be able to read this chat. A share link will be created and copied.'),
			primaryButton: localize('sessions.chatgpt.share', 'Share'),
		});
		if (!result.confirmed) { return; }
		const url = await this.chat.share(conversation.id);
		if (url) {
			try { await this.clipboard.writeText(url); status(localize('sessions.chatgpt.shareCopied', 'Share link copied.')); }
			catch { await this.dialogs.info(localize('sessions.chatgpt.shareLink', 'Share link'), url); }
		}
	}
}
