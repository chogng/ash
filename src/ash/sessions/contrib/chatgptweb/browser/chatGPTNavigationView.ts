import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { addDisposableListener, getActiveElement, getWindow, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { DisposableStore, toDisposable, MutableDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr, type IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ViewPane, type IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import { PaneComposite, type PaneCompositeOptions } from '../../../../workbench/browser/panecomposite.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { LabelActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { SubmenuAction, type IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import type { ChatGPTConversation } from './chatGPTClient.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IChatGPTService, chatGPTNavigationContainerId, type ChatGPTState } from './chatGPTService.js';
import { SessionsViewRegistry } from '../../../common/views.js';
import '../../../../base/browser/ui/button/button.css';
import './media/chatGPTNavigationView.css';

interface ConversationGroup {
	readonly key: string;
	readonly title: string;
	readonly order: number;
	readonly conversations: readonly ChatGPTConversation[];
}

function focusConversation(root: HTMLElement, id: string, preventScroll = false): void {
	if (!root.isConnected || root.closest('[hidden]')) { return; }
	const item = [...root.querySelectorAll<HTMLButtonElement>('.ash-chatgpt-conversation')].find(item => item.dataset.conversation === id);
	const pane = item?.closest('.ash-view-pane.collapsed');
	const target = pane?.querySelector<HTMLButtonElement>('.ash-pane-view-header-button') ?? item;
	(target ?? root.querySelector<HTMLButtonElement>('.ash-pane-view-header-button'))?.focus({ preventScroll });
}

/** The sidebar's retained composite; registered ViewPanes own all group chrome and expansion. */
export class ChatGPTNavigationViewPaneContainer extends PaneComposite {
	private readonly registrations = new Map<string, { readonly title: string; readonly order: number; readonly visible: IContextKey<boolean>; readonly registration: IDisposable; }>();
	private scheduleLoad: () => void = () => { };

	constructor(parent: HTMLElement, options: PaneCompositeOptions,
		@IChatGPTService chat: IChatGPTService,
		@IEditorService editors: IEditorService,
		@IConfigurationService configuration: IConfigurationService,
		@IStorageService storage: IStorageService,
		@IThemeService theme: IThemeService,
		@IMenuService menus: IMenuService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super(parent, { ...options, paneHeaders: 'visible', paneLayout: 'content', stateScope: StorageScope.PROFILE, mergeViewWithContainerWhenSingleView: false }, storage, theme, menus, configuration, instantiationService, contextKeys);
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
		const list = scrollable.contentElement;
		list.classList.add('ash-chatgpt-navigation-list');
		list.setAttribute('role', 'navigation');
		list.setAttribute('aria-label', localize('sessions.chatgpt.conversations', 'Conversations'));
		this._register(addDisposableListener(list, 'click', event => {
			const item = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.ash-chatgpt-conversation') : null;
			if (item?.dataset.conversation) { void chat.select(item.dataset.conversation).then(() => editors.focusActiveEditor()); }
		}));
		this._register(addDisposableListener(list, 'keydown', event => {
			const active = getActiveElement(document) as HTMLButtonElement | null;
			if (!active?.classList.contains('ash-chatgpt-conversation') || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { return; }
			const items = [...list.querySelectorAll<HTMLButtonElement>('.ash-chatgpt-conversation')].filter(item => !item.closest('[hidden], .ash-view-pane.collapsed') && !item.disabled);
			const index = items.indexOf(active);
			if (index < 0) { return; }
			event.preventDefault();
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
			items[next]?.focus();
		}));
		const loadMoreIfNeeded = (retry: boolean): void => {
			const state = chat.state.get();
			const viewport = scrollable.state;
			if (!this.isVisible() || !viewport.height || !state.connected || state.busy || state.sending || state.managing || !state.hasMore || (!retry && state.error)) { return; }
			if (this.panes.at(-1)?.isExpanded() === false) { return; }
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
		this._register(this.onDidChangeViewVisibility(() => scheduleLoad()));
		this._register(toDisposable(() => {
			for (const entry of this.registrations.values()) { entry.registration.dispose(); entry.visible.reset(); }
			this.registrations.clear();
		}));
		// One-way migration only; ViewPaneContainer owns every subsequent collapse read and write.
		const previousPrefix = 'sessions.chatgpt.navigation.collapsed.';
		for (const previousKey of storage.keys(StorageScope.PROFILE, StorageTarget.MACHINE)) {
			if (!previousKey.startsWith(previousPrefix)) { continue; }
			const key = previousKey.slice(previousPrefix.length);
			if (key && key !== 'projects') {
				const nextKey = this.stateKey(`${chatGPTNavigationContainerId}.${key}`, 'collapsed');
				const previous = storage.getBoolean(previousKey, StorageScope.PROFILE);
				if (previous !== undefined && storage.getBoolean(nextKey, StorageScope.PROFILE) === undefined) {
					storage.store(nextKey, previous, StorageScope.PROFILE, StorageTarget.MACHINE);
				}
			}
			storage.remove(previousKey, StorageScope.PROFILE);
		}
		const render = (state: ChatGPTState): void => {
			const focused = getActiveElement(document) as HTMLElement | null;
			const hadFocus = root.contains(focused);
			const focusedId = focused?.closest<HTMLElement>('[data-conversation]')?.dataset.conversation;
			const focusedGroup = focused?.classList.contains('ash-pane-view-header-button') ? focused.closest<HTMLElement>('[data-group]')?.dataset.group : undefined;
			const top = scrollable.state.top;
			const groups = this.groups(state);
			const wanted = new Set(groups.map(group => group.key));
			for (const [key, entry] of this.registrations) {
				if (wanted.has(key)) { continue; }
				entry.registration.dispose(); entry.visible.reset(); this.registrations.delete(key);
			}
			for (const group of groups) {
				let entry = this.registrations.get(group.key);
				if (entry && (entry.title !== group.title || entry.order !== group.order)) {
					entry.registration.dispose(); entry.visible.reset(); this.registrations.delete(group.key); entry = undefined;
				}
				if (!entry) {
					const id = `${chatGPTNavigationContainerId}.${group.key}`;
					const context = `sessions.chatgpt.groupVisible.${group.key}`;
					const visible = contextKeys.createKey<boolean>(context, false);
					visible.set(true);
					const registration = SessionsViewRegistry.registerViews(this.id, [{
						id, title: group.title, order: group.order, when: ContextKeyExpr.has(context), canToggleVisibility: false,
						ctorDescriptor: new SyncDescriptor(ChatGPTNavigationView, [group.key]),
					}]);
					entry = { title: group.title, order: group.order, visible, registration };
					this.registrations.set(group.key, entry);
				}
				const pane = this.getView(`${chatGPTNavigationContainerId}.${group.key}`);
				if (pane instanceof ChatGPTNavigationView) { pane.render(group.conversations, state); }
			}
			list.setAttribute('aria-busy', String(state.busy));
			scrollable.layout();
			if (focusedId && hadFocus) { focusConversation(root, focusedId, true); }
			if (focusedGroup) { this.getView(`${chatGPTNavigationContainerId}.${focusedGroup}`)?.element.querySelector<HTMLButtonElement>('.ash-pane-view-header-button')?.focus({ preventScroll: true }); }
			scrollable.scrollTo(0, top);
			scheduleLoad();
		};
		this._register(autorun(reader => render(chat.state.read(reader))));
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
			{ key: 'pinned', title: localize('sessions.chatgpt.pinnedGroup', 'Pinned'), order: 0 },
			...state.projects.map((project, index) => ({ key: project.id, title: project.title, order: index + 1 })),
			{ key: 'other', title: localize('sessions.chatgpt.otherProjects', 'Other projects'), order: state.projects.length + 1 },
			{ key: 'recent', title: localize('sessions.chatgpt.recentGroup', 'Recent'), order: Number.MAX_SAFE_INTEGER },
		].flatMap(group => { const conversations = buckets.get(group.key); return conversations?.length ? [{ ...group, conversations }] : []; });
	}

	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.scrollable?.layout(); this.scheduleLoad();
	}

	public override focus(): void { this.element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }
}

/** One ordinary ViewPane per group, with content-sized rows and no custom header implementation. */
export class ChatGPTNavigationView extends ViewPane {
	private readonly loadingProgress = this._register(new MutableDisposable());
	private readonly rows = this._register(new DisposableStore());
	private conversations: readonly ChatGPTConversation[] = [];
	private menuGeneration = 0;
	private menuRow: HTMLElement | undefined;
	private readonly menuLoad = this._register(new MutableDisposable());
	constructor(key: string, private readonly navigation: HTMLElement, options: IViewPaneOptions,
		@IChatGPTService private readonly chat: IChatGPTService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IDialogService private readonly dialogs: IDialogService,
		@IClipboardService private readonly clipboard: IClipboardService,
	) {
		super(navigation, { ...options, minimumBodySize: 0 });
		this.element.classList.add('ash-chatgpt-navigation-group');
		this.element.dataset.group = key;
		this.element.setAttribute('role', 'group');
		this.element.setAttribute('aria-label', options.title);
		this.contentElement.classList.add('ash-chatgpt-navigation-rows');
		this._register(toDisposable(() => { if (this.menuRow) { this.contextMenus.hideContextMenu(); } }));
		this._register(this.onDidChangeBodyVisibility(() => {
			if (!this.isBodyVisible()) {
				this.menuGeneration++; this.menuLoad.clear();
				if (this.menuRow) { this.contextMenus.hideContextMenu(); }
			}
		}));
	}

	public override get maximumSize(): number { return this.minimumSize; }

	public render(conversations: readonly ChatGPTConversation[], state: ChatGPTState): void {
		if (state.busy && !this.loadingProgress.value) {
			const progress = this.getProgressIndicator().show(true, 150);
			this.loadingProgress.value = toDisposable(() => progress.done());
		} else if (!state.busy) this.loadingProgress.clear();
		if (conversations.length !== this.conversations.length || conversations.some((conversation, index) => conversation !== this.conversations[index])) {
			this.rows.clear();
			this.conversations = conversations;
			this.contentElement.replaceChildren(...conversations.map(conversation => this.createRow(conversation)));
		}
		for (const [index, row] of [...this.contentElement.querySelectorAll<HTMLElement>('.ash-chatgpt-navigation-row')].entries()) {
			const conversation = conversations[index]!;
			for (const button of row.querySelectorAll('button')) {
				button.disabled = state.sending || state.managing || (state.busy && !button.classList.contains('ash-chatgpt-conversation'));
				if (button.classList.contains('ash-chatgpt-conversation') && conversation.id === state.conversationId) { button.setAttribute('aria-current', 'page'); }
				else { button.removeAttribute('aria-current'); }
			}
		}
		// Pane sizing follows the host's row metric, including its text and action targets.
		const styles = getWindow(this.contentElement).getComputedStyle(this.contentElement);
		const gap = parseFloat(styles.rowGap) || 0;
		const rowHeight = parseFloat(styles.getPropertyValue('--ash-list-rowHeight'));
		const count = conversations.length;
		this.minimumBodySize = count * rowHeight + Math.max(0, count - 1) * gap;
	}

	private createRow(conversation: ChatGPTConversation): HTMLElement {
		const document = this.contentElement.ownerDocument;
		const row = document.createElement('div');
		row.className = 'ash-chatgpt-navigation-row';
		row.dataset.conversation = conversation.id;
		const item = document.createElement('button');
		item.className = 'ash-button ash-button-standard ash-button-quiet ash-chatgpt-conversation';
		item.type = 'button';
		item.textContent = conversation.title;
		item.title = conversation.title;
		item.dataset.conversation = conversation.id;
		row.append(item);
		const more = this.action('more', localize('sessions.chatgpt.more', 'More actions'), () => this.showMore(row, conversation), Lxicon.ellipsis);
		// The glyph shows the current pin state; the label describes the action.
		const pin = this.action('pin', conversation.pinned ? localize('sessions.chatgpt.unpin', 'Unpin chat') : localize('sessions.chatgpt.pin', 'Pin chat'),
			async () => {
				await this.chat.setPinned(conversation.id, !conversation.pinned);
				this.focusConversation(conversation.id);
			}, conversation.pinned ? Lxicon.pinned : Lxicon.unpin);
		const bar = this.rows.add(new ActionBar(row, {
			actionViewItemOptions: { buttonStyles: defaultButtonStyles },
			actions: [more, { ...pin, checked: conversation.pinned === true }],
			ariaLabel: localize('sessions.chatgpt.conversationActions', 'Actions for {0}', conversation.title),
			actionViewItemProvider: action => new LabelActionViewItem(action, { label: '', ariaLabel: action.label }),
		}));
		bar.element.classList.add('ash-chatgpt-conversation-actions');
		const trigger = bar.element.querySelector('button')!;
		trigger.setAttribute('aria-haspopup', 'menu');
		trigger.setAttribute('aria-expanded', 'false');
		return row;
	}

	private action(id: string, label: string, run: () => unknown, icon?: IAction['icon']): IAction {
		return { id: `sessions.chatgpt.${id}`, label, tooltip: label, enabled: true, icon, run };
	}

	private async showMore(row: HTMLElement, conversation: ChatGPTConversation): Promise<void> {
		const generation = ++this.menuGeneration;
		const controller = new AbortController();
		this.menuLoad.value = toDisposable(() => controller.abort());
		row.classList.add('menu-open');
		let trigger = row.querySelector<HTMLButtonElement>('.ash-chatgpt-conversation-actions button')!;
		trigger.setAttribute('aria-expanded', 'true');
		let projects: readonly IAction[];
		try {
			projects = (await this.chat.listProjects(controller.signal)).map(project => ({
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
			row.classList.remove('menu-open'); trigger.setAttribute('aria-expanded', 'false'); return;
		}
		// Refreshing project names can regroup the rows while the menu is loading.
		if (!row.isConnected) {
			const replacement = [...this.contentElement.querySelectorAll<HTMLElement>('.ash-chatgpt-navigation-row')].find(item => item.dataset.conversation === conversation.id);
			if (!replacement) { return; }
			row = replacement;
			trigger = row.querySelector<HTMLButtonElement>('.ash-chatgpt-conversation-actions button')!;
			row.classList.add('menu-open'); trigger.setAttribute('aria-expanded', 'true');
		}
		this.menuRow = row;
		this.contextMenus.showContextMenu({
			getAnchor: () => trigger,
			getActions: () => [
				this.action('rename', localize('sessions.chatgpt.rename', 'Rename'), () => this.rename(conversation)),
				this.action('share', localize('sessions.chatgpt.share', 'Share'), () => this.share(conversation)),
				this.action('archive', localize('sessions.chatgpt.archive', 'Archive'), () => this.chat.archive(conversation.id)),
				this.action('delete', localize('sessions.chatgpt.delete', 'Delete'), () => this.deleteConversation(conversation)),
				new SubmenuAction('sessions.chatgpt.moveToProject', localize('sessions.chatgpt.moveToProject', 'Move to project'), projects),
			],
			onHide: cancelled => {
				if (this.menuRow === row) { this.menuRow = undefined; }
				row.classList.remove('menu-open'); trigger.setAttribute('aria-expanded', 'false');
				if (cancelled && trigger.isConnected && this.isBodyVisible() && !this.isDisposed) { trigger.focus(); }
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

	private focusConversation(id: string): void {
		focusConversation(this.navigation, id);
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

	public override focus(): void {
		this.contentElement.querySelector<HTMLButtonElement>('.ash-chatgpt-conversation:not(:disabled):not([hidden])')?.focus();
	}
}
