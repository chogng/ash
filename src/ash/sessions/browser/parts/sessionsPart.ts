import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { MenusRegistry, MenuId } from '../../../platform/actions/common/actions.js';
import { ContextKeyExpr, RawContextKey, type IContextKey } from '../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { Menus } from '../menus.js';
import { localize2 } from '../../../nls.js';
import { type ChatView, NewChatView } from '../../contrib/chat/browser/chatView.js';
import { IStorageService, StorageScope } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import type { ChatContextAttachment } from '../../../workbench/services/chat/common/chatContextService.js';
import './media/sessionsPart.css';
import { addDisposableListener, Dimension, h } from '../../../base/browser/dom.js';
import { observeResize } from '../../../base/browser/observer.js';
import { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import { Part } from '../../../workbench/browser/part.js';
import type { SessionsViewSelection } from '../../services/sessions/browser/sessionsService.js';
import type { SessionRecencyEntry } from '../../services/sessions/browser/sessionsRecencyHistory.js';
import { sessionViewSelectionKey } from '../../services/sessions/browser/visibleSessions.js';
import { IChatWindowService, type IChatWindowContent, type IChatWindowMount } from '../../../workbench/contrib/chatWindow/browser/chatWindow.js';
import { getSessionChatResource, getSessionChatWindowChoices, readSessionChatResource, SessionsChatWindowProvider } from '../../contrib/chatWindow/browser/sessionsChatWindowProvider.js';
import { SessionView, type ISessionsConversationPane } from './sessionView.js';
import { SessionGridLayout } from './sessionGridLayout.js';
import { Direction, type IView } from '../../../base/browser/ui/grid/grid.js';
import type { IPositionedRectangle } from '../../../base/browser/geometry.js';
import { Disposable, DisposableMap, type IDisposable, setDisposableOwner, toDisposable } from '../../../base/common/lifecycle.js';
import { observableValue, type IObservable } from '../../../base/common/observable.js';
import { localize } from '../../../nls.js';
import { WELCOME_COMPLETE_KEY } from '../../common/welcome.js';
import { IsNewSessionContext } from '../../common/contextkeys.js';
import type { SessionId } from '../../services/sessions/common/session.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IChatViewFactory } from '../../contrib/chat/browser/chatViewFactory.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import type { IOpenAgentsWindowOptions } from '../../../platform/native/common/nativeHost.js';
import { Button } from '../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../platform/theme/browser/defaultStyles.js';
import type {
	ISessionsConversationService,
	SessionsConversationKind,
} from '../../services/sessions/common/sessionsConversation.js';

export interface SessionsPartOptions {
	readonly newDraftVisible: IObservable<boolean>;
	readonly createChatPane: (
		container: HTMLElement,
		panelId: string,
		selection: SessionsViewSelection,
	) => ISessionsConversationPane;
	readonly activateSelection: (selection: SessionsViewSelection) => void;
	readonly markVisibleThreadViewed: (entry: SessionRecencyEntry) => void;
	readonly closeSelection: (selection: SessionsViewSelection) => void;
	readonly createNewSession: () => void;
	readonly createComparisonControls?: (container: HTMLElement) => IDisposable;
	readonly createSessionActivityBar?: (container: HTMLElement, hasDesktopChatSource: IObservable<boolean>) => IDisposable;
}

type AgentSessionView = SessionView<SessionsViewSelection, ISessionsConversationPane>;

/** Hosts the shared session grid and its visible SessionViews. */
export class SessionsPart extends Part implements ISessionsConversationService {
	get newDraftVisible(): IObservable<boolean> { return this.options.newDraftVisible; }
	private readonly content: HTMLElement;
	private readonly chatViews = this._register(new DisposableMap<string, SessionView<string, ChatView>>());
	private readonly chatSource = observableValue<string | undefined>(this, undefined);
	readonly hasDesktopChatSource = this.chatSource.map(id => id !== undefined);
	private get desktopChatView(): SessionView<string, ChatView> | undefined {
		const source = this.chatSource.get();
		return source === undefined ? undefined : this.chatViews.get(source);
	}
	private readonly grid: SessionGridLayout;
	private readonly empty: SessionsChatEmptyView;
	private readonly entries = new Map<string, AgentSessionView>();
	private activeAgentView: AgentSessionView | undefined;
	private readonly splitActive: IContextKey<boolean>;
	private readonly infoVisible: IContextKey<boolean>;
	private mainKeys: readonly string[] = [];
	private kind: SessionsConversationKind = 'code';
	private visible = true;
	private get agentViewsVisible(): boolean { return this.visible && !this.desktopChatView; }
	private switching = Promise.resolve();
	private readonly detachedViews = new WeakMap<AgentSessionView, { readonly placeholder: IView; readonly mount: IChatWindowMount; }>();

	override get minimumWidth(): number {
		return 400;
	}

	constructor(
		container: HTMLElement,
		private readonly options: SessionsPartOptions,
		@IInstantiationService services: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IChatWindowService private readonly chatWindows: IChatWindowService,
		@IContextKeyService contextKeys: IContextKeyService,
		@ISessionsManagementService private readonly sessionService: ISessionsManagementService,
		@INotificationService private readonly notifications: INotificationService,
		@IChatViewFactory private readonly chatViewsFactory: IChatViewFactory,
	) {
		super(container, 'sessions', themeService, storageService);
		this.infoVisible = new RawContextKey('sessions.infoVisible', false).bindTo(contextKeys);
		this._register(toDisposable(() => this.infoVisible.reset()));
		this._register(
			CommandsRegistry.register('ash.sessions.toggleInfo', () => {
				const pane = this.activeAgentView?.activeChat;
				if (pane instanceof NewChatView) pane.toggleInfo();
			}),
		);
		const infoCommand = {
			id: 'ash.sessions.toggleInfo',
			title: localize2({ bundle: 'ash', key: 'sessions.info.toggle' }, 'Toggle session information'),
			icon: Lxicon.railSession,
			toggled: ContextKeyExpr.equals('sessions.infoVisible', true),
		};
		this._register(
			MenusRegistry.appendMenuItems(
				[Menus.TitleBarRightLayout, MenuId.CommandPalette].map(id => ({
					id,
					item: {
						command: infoCommand,
						when: ContextKeyExpr.and(
							ContextKeyExpr.equals('sessions.toolsAvailable', true),
							id === Menus.TitleBarRightLayout ? ContextKeyExpr.not(IsNewSessionContext.key) : undefined,
						),
						group: 'navigation',
						order: -1,
					},
				})),
			),
		);
		this.splitActive = new RawContextKey('sessions.splitActive', false).bindTo(contextKeys);
		this._register(toDisposable(() => this.splitActive.reset()));
		const splitCommands = [
			{ id: 'sessions.focusLeft', title: localize2('sessions.focusLeft', 'Focus Session to the Left'), run: () => this.focusNeighbor(Direction.Left) },
			{ id: 'sessions.focusRight', title: localize2('sessions.focusRight', 'Focus Session to the Right'), run: () => this.focusNeighbor(Direction.Right) },
			{ id: 'sessions.focusAbove', title: localize2('sessions.focusAbove', 'Focus Session Above'), run: () => this.focusNeighbor(Direction.Up) },
			{ id: 'sessions.focusBelow', title: localize2('sessions.focusBelow', 'Focus Session Below'), run: () => this.focusNeighbor(Direction.Down) },
			{
				id: 'sessions.toggleMaximized', title: localize2('sessions.toggleMaximized', 'Toggle Maximized Session'), run: () => {
					const id = this.activeGridId;
					if (id) this.grid.toggleMaximized(id);
				}
			},
		];
		for (const { id, title, run } of splitCommands) {
			this._register(CommandsRegistry.register(id, () => { if (this.splitActive.get()) run(); }));
			this._register(MenusRegistry.appendMenuItem(MenuId.CommandPalette, {
				command: { id, title },
				when: ContextKeyExpr.has('sessions.splitActive'),
			}));
		}
		this.content = h(container.ownerDocument, 'section');
		this.content.className = 'ash-sessions-chat-view';
		this.contentDomNode.append(this.content);
		this.empty = this._register(
			new SessionsChatEmptyView(this.content, () =>
				storageService.getBoolean(WELCOME_COMPLETE_KEY, StorageScope.PROFILE, false),
			),
		);
		this.grid = this._register(services.createInstance(SessionGridLayout, this.content, this.empty));
		this._register(this.chatWindows.registerProvider(new SessionsChatWindowProvider(
			this.entries, view => view.currentSelection, view => this.getChatWindowContent(view),
			async resource => {
				const target = readSessionChatResource(resource);
				if (!target || this.isDisposed) return;
				if ('draftId' in target) {
					const draft = this.sessionService.untitledSessions.find(session => session.untitledSessionId === target.draftId);
					if (draft) this.getOrCreateView({ kind: 'untitled', session: draft });
				} else {
					const session = this.sessionService.sessions.find(session => session.sessionId === target.sessionId && session.status === 'active');
					if (session?.chats.some(chat => chat.threadId === target.threadId && chat.status === 'active')) {
						this.getOrCreateView({ kind: 'session', active: { session, threadId: target.threadId }, sideThread: target.sideThread });
					}
				}
			},
			resource => {
				const source = resource && [...this.entries.values()].find(view => getSessionChatResource(view.currentSelection).toString() === resource.toString());
				const parent = source?.currentSelection;
				const workspace = parent?.kind === 'untitled' ? parent.session.workspace : undefined;
				const draft = this.sessionService.createUntitledSession(undefined, workspace, undefined, false);
				const selection = { kind: 'untitled', session: draft } as const;
				this.getOrCreateView(selection);
				return getSessionChatResource(selection);
			},
			() => getSessionChatWindowChoices(this.sessionService, true),
		)));
		if (options.createComparisonControls) {
			this._register(options.createComparisonControls(this.contentDomNode));
		}
		if (options.createSessionActivityBar) {
			this._register(options.createSessionActivityBar(this.content, this.hasDesktopChatSource));
		}
		if (options.createComparisonControls || options.createSessionActivityBar) {
			this._register(observeResize(this.grid.element, () => {
				const { width, height } = this.grid.element.getBoundingClientRect();
				if (width && height) this.grid.layout(width, height);
			}));
		}
		this._register(
			storageService.onDidChangeValue(event => {
				if (event.scope === StorageScope.PROFILE && event.key === WELCOME_COMPLETE_KEY)
					this.empty.update(sessionService.state, sessionService.error);
			}),
		);
		this._register(
			toDisposable(() => {
				for (const view of this.entries.values()) {
					this.detachedViews.get(view)?.mount.close();
					view.dispose();
				}
				this.entries.clear();
			}),
		);
		this.updateVisibleSessions([], undefined);
	}

	setChatSource(sourceId: string | undefined): void {
		if (sourceId === this.chatSource.get()) return;
		const previous = this.desktopChatView;
		if (sourceId !== undefined && !this.chatViews.has(sourceId)) {
			const view = new SessionView(this.content, {
				selection: sourceId,
				kind: 'chat',
				createPane: (_kind, container, _panelId, source) => this.chatViewsFactory.createChatView(source, container),
			});
			view.element.classList.add('last-slot');
			this.chatViews.set(sourceId, view);
		}
		previous?.setVisible(false);
		this.chatSource.set(sourceId, undefined);
		this.domNode.classList.toggle('desktop-chat-source', sourceId !== undefined);
		this.reconcileGrid();
		this.updateContentVisibility();
		this.updateInfoContext();
	}

	setConversationKind(kind: SessionsConversationKind): Promise<void> {
		const switchKind = async () => {
			if (this.isDisposed) return;
			this.kind = kind;
			for (const view of this.entries.values()) {
				if (!this.detachedViews.has(view)) view.setConversationKind(kind);
			}
		};
		// Entry commands may overlap while a composer flushes its pending edits.
		this.switching = this.switching.then(switchKind, switchKind);
		return this.switching;
	}

	async didActiveCodeHistoryFail(): Promise<boolean> {
		const pane = this.activeAgentView?.activeChat;
		if (!(pane instanceof NewChatView) || !pane.sessionId) return false;
		await pane.model.pendingHistoryBinding;
		return this.activeAgentView?.activeChat === pane && !!pane.model.historyStatus && pane.model.items.length === 0;
	}

	focus(): void {
		const active = this.desktopChatView ?? this.activeAgentView;
		const popup = active === this.activeAgentView && active ? this.detachedViews.get(active)?.mount : undefined;
		if (popup) {
			void popup.focus().catch(error => this.notifications.error(String(error)));
		} else if (active === this.activeAgentView || this.visible) {
			active?.focus();
		}
	}

	async openInNewWindow(selection: SessionsViewSelection): Promise<void> {
		await this.switching;
		if (this.isDisposed) return;
		const view = this.entries.get(sessionViewSelectionKey(selection));
		if (!view) throw new Error(localize('chatSession.target.invalid', 'Choose a valid session.'));
		await this.chatWindows.open(getSessionChatResource(view.currentSelection));
	}

	private getChatWindowContent(view: AgentSessionView): IChatWindowContent {
		const selection = view.currentSelection;
		return {
			element: view.element,
			title: selection.kind === 'session' ? selection.active.session.title : selection.session.title,
			isAvailable: () => !this.isDisposed && !view.isDisposed,
			getResource: () => getSessionChatResource(view.currentSelection),
			didReturn: () => this.options.activateSelection(view.currentSelection),
			setVisible: visible => { if (!view.isDisposed) view.setVisible(visible); },
			layout: ({ width, height }) => view.layout({ top: 0, left: 0, width, height }),
			focus: window => {
				view.focus();
				this.markDetachedViewViewed(view, window.window.document);
			},
			mount: mount => this.mountDetachedView(view, mount),
		};
	}

	private mountDetachedView(
		view: AgentSessionView,
		mount: IChatWindowMount,
	): void {
		const { window, resources } = mount;
		const placeholder = h(this.content.ownerDocument, 'div', { className: 'ash-chat-detached-chat' });
		resources.add(new Button(placeholder, {
			...defaultButtonStyles,
			presentation: 'quiet',
			label: localize('sessions.window.focus', 'Chat is open in another window'),
			onClick: () => {
				void mount.focus().catch(error => this.notifications.error(String(error)));
			},
		}));
		this.detachedViews.set(view, {
			mount,
			placeholder: {
				element: placeholder,
				minimumWidth: view.minimumWidth,
				maximumWidth: view.maximumWidth,
				minimumHeight: view.minimumHeight,
				maximumHeight: view.maximumHeight,
				layout() { },
			},
		});
		resources.add(toDisposable(() => {
			this.detachedViews.delete(view);
			// Return the same pane before the popup document and its listeners go away.
			if (this.isDisposed || view.isDisposed || ![...this.entries.values()].includes(view)) return;
			this.reconcileGrid();
			view.setVisible(this.agentViewsVisible);
			try { view.setConversationKind(this.kind); }
			catch (error) { this.notifications.error(String(error)); }
			if (this.agentViewsVisible && this.activeAgentView === view) view.focus();
		}));
		view.setCloseVisible(false);
		this.reconcileGrid();
		window.container.classList.add('ash-sessions-window');
		const document = window.window.document;
		const markViewed = () => this.markDetachedViewViewed(view, document);
		resources.add(addDisposableListener(window.window, 'focus', markViewed));
		resources.add(addDisposableListener(document, 'visibilitychange', markViewed));
		resources.add(this.sessionService.onDidChange(markViewed));
	}

	private markDetachedViewViewed(view: AgentSessionView, document: Document): void {
		if (!this.detachedViews.has(view) || document.hidden || !document.hasFocus()) return;
		const selection = view.currentSelection;
		if (selection.kind === 'session') {
			const { session, threadId } = selection.active;
			this.options.markVisibleThreadViewed({ sessionId: session.sessionId, threadId });
		}
	}

	private get activeGridId(): string | undefined {
		const active = this.activeAgentView;
		return !this.desktopChatView && active && !this.detachedViews.has(active) ? this.mainKeys.find(id => this.entries.get(id) === active) : undefined;
	}

	private focusNeighbor(direction: Direction): void {
		if (!this.visible) return;
		const id = this.activeGridId;
		const neighbor = id && this.grid.neighbor(id, direction);
		const view = neighbor ? this.entries.get(neighbor) : undefined;
		if (!view || this.detachedViews.has(view)) return;
		this.options.activateSelection(view.currentSelection);
		view.focus();
	}
	private reconcileGrid(): void {
		const desktopChat = this.desktopChatView;
		const source = this.chatSource.get();
		const entries = desktopChat && source !== undefined ? [{ id: source, view: desktopChat }] : this.mainKeys.flatMap(id => {
			const view = this.entries.get(id);
			return view ? [{ id, view: this.detachedViews.get(view)?.placeholder ?? view }] : [];
		});
		const docked = entries.flatMap(({ view }) => view instanceof SessionView ? [view] : []);
		for (const view of docked) view.setCloseVisible(docked.length > 1);
		const active = source ?? [...this.entries].find(([, view]) => view === this.activeAgentView)?.[0] ?? 'empty';
		this.splitActive.set(this.agentViewsVisible && entries.length > 1 && this.activeGridId !== undefined);
		this.content.classList.toggle('single-chat', entries.length === 1);
		this.grid.reconcile(entries.length ? entries : [{ id: 'empty', view: this.empty }], active, desktopChat === undefined);
	}

	focusDraftPicker(picker: 'workspace' | 'environment'): void {
		const view = this.activeAgentView;
		if (!this.agentViewsVisible || !view || this.detachedViews.has(view) || view.currentSelection.kind !== 'untitled') return;
		const pane = view.activeChat;
		if (pane instanceof NewChatView) pane.focusDraftPicker(picker);
	}

	addContext(attachment: ChatContextAttachment): void {
		const view = this.desktopChatView ?? this.activeAgentView;
		if (!view)
			throw new Error(
				localize('sessions.handoff.noActiveChat', 'Agents Window has no active chat for the draft.'),
			);
		view.activeChat.addContext(attachment);
	}

	acquireContext(prepare: (signal: AbortSignal) => Promise<readonly ChatContextAttachment[]>): Promise<readonly ChatContextAttachment[]> {
		const view = this.activeAgentView;
		if (!view || this.detachedViews.has(view)) return Promise.resolve([]);
		return view.activeChat.acquireContext(prepare);
	}

	appendToDraft(text: string): void {
		if (!this.activeAgentView)
			throw new Error(
				localize('sessions.handoff.noActiveChat', 'Agents Window has no active chat for the draft.'),
			);
		this.activeAgentView.activeChat.appendToDraft(text);
	}

	startVoiceConversation(): Promise<void> {
		const view = this.desktopChatView ?? this.activeAgentView;
		if (!view) return Promise.reject(new Error(localize('agentsVoice.noChat', 'Open a Chat before starting voice.')));
		return view.activeChat.startVoiceConversation();
	}

	async captureActiveDraft(): Promise<
		{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void; } | undefined
	> {
		await this.switching;
		return this.activeAgentView?.activeChat.captureDraft();
	}

	restoreDraft(draft: NonNullable<IOpenAgentsWindowOptions['draft']>): void {
		if (!this.activeAgentView)
			throw new Error(
				localize('sessions.handoff.noActiveChat', 'Agents Window has no active chat for the draft.'),
			);
		this.activeAgentView.activeChat.restoreDraft(draft);
		if (this.visible) this.activeAgentView.focus();
	}

	updateVisibleSessions(
		selections: readonly SessionsViewSelection[],
		active: SessionsViewSelection | undefined,
	): void {
		// Materializing a draft changes its identity, not its view or live input.
		for (const [key, view] of [...this.entries]) {
			const selection = view.currentSelection;
			if (selection.kind === 'session') continue;
			const materialized = this.sessionService.materializedSessions.get().get(selection.session.untitledSessionId);
			const id = view.activeChat.sessionId ?? materialized?.sessionId;
			const target = selection.session.forkSource
				? selections.find(candidate => candidate.kind === 'session' && candidate.active.session.sessionId === id && candidate.active.threadId === materialized?.threadId)
				: undefined;
			const destination = target ? sessionViewSelectionKey(target) : !selection.session.forkSource && id ? sessionKey(id) : undefined;
			if (!destination || key === destination || this.entries.has(destination)) continue;
			this.entries.delete(key);
			this.entries.set(destination, view);
		}
		this.empty.update(this.sessionService.state, this.sessionService.error);
		this.mainKeys = selections.map(sessionViewSelectionKey);
		const desired = new Set(this.mainKeys);
		const removed: AgentSessionView[] = [];
		for (const [key, view] of this.entries) {
			if (desired.has(key)) continue;
			const popup = this.detachedViews.get(view)?.mount;
			if (popup) {
				const current = view.currentSelection;
				const id =
					view.activeChat.sessionId ??
					(current.kind === 'untitled'
						? this.sessionService.materializedSessions.get().get(current.session.untitledSessionId)
							?.sessionId
						: undefined);
				const session = id
					? this.sessionService.sessions.find(
						session => session.sessionId === id && session.status === 'active',
					)
					: undefined;
				if (session) {
					const selection = view.currentSelection;
					const thread = session.chats.find(
						chat =>
							chat.status === 'active' &&
							(selection.kind === 'session'
								? chat.threadId === selection.active.threadId
								: chat.origin.type === 'root'),
					);
					if (thread) {
						view.openSession({ kind: 'session', active: { session, threadId: thread.threadId } });
						popup.setTitle(session.title);
						continue;
					}
				}
				const selection = view.currentSelection;
				if (
					!id &&
					selection.kind === 'untitled' &&
					this.sessionService.untitledSessions.some(
						session => session.untitledSessionId === selection.session.untitledSessionId,
					)
				)
					continue;
			}
			this.entries.delete(key);
			removed.push(view);
		}
		for (const selection of selections) {
			const id = sessionViewSelectionKey(selection);
			const view = this.getOrCreateView(selection);
			view.openSession(selection);
			const popup = this.detachedViews.get(view)?.mount;
			if (!popup) view.setVisible(this.agentViewsVisible);
			if (popup) {
				const title = selection.kind === 'session' ? selection.active.session.title : selection.session.title;
				popup.setTitle(title);
			}
			view.element.classList.toggle('last-slot', selection === selections.at(-1));
		}
		this.activeAgentView = active ? this.entries.get(sessionViewSelectionKey(active)) : undefined;
		this.updateInfoContext();
		this.reconcileGrid();
		for (const view of removed) {
			this.detachedViews.get(view)?.mount.close();
			view.dispose();
		}
	}

	private getOrCreateView(selection: SessionsViewSelection): AgentSessionView {
		const id = sessionViewSelectionKey(selection);
		const existing = this.entries.get(id);
		if (existing) return existing;
		const view = new SessionView(this.content, {
			selection,
			kind: this.kind,
			createPane: (kind, container, panelId, selected) => this.createPane(kind, container, panelId, selected),
			bindPane: bindAgentSession,
			shouldRecreatePane: (previous, next) => previous.kind === 'untitled' && next.kind === 'untitled'
				&& previous.session.providerId !== next.session.providerId,
			activateSelection: this.options.activateSelection,
			closeSelection: this.options.closeSelection,
		});
		setDisposableOwner(view, this);
		this.entries.set(id, view);
		return view;
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.visible = visible;
		this.updateContentVisibility();
	}

	private updateContentVisibility(): void {
		this.desktopChatView?.setVisible(this.visible);
		this.grid.setVisible(this.visible);
		this.splitActive.set(this.agentViewsVisible && this.mainKeys.length > 1 && this.activeGridId !== undefined);
		for (const view of this.entries.values()) {
			if (!this.detachedViews.has(view)) view.setVisible(this.agentViewsVisible);
		}
	}

	override layout(dimension: Dimension): void {
		const bounds = this.grid.element.getBoundingClientRect();
		this.grid.layout(bounds.width || dimension.width, bounds.height || dimension.height);
	}

	private updateInfoContext(): void {
		const pane = this.activeAgentView?.activeChat;
		this.infoVisible.set(!this.desktopChatView && pane instanceof NewChatView && pane.infoVisible);
	}

	private createPane(
		kind: SessionsConversationKind,
		container: HTMLElement,
		panelId: string,
		selection: SessionsViewSelection,
	): ISessionsConversationPane {
		const options = this.options;
		if (kind === 'chat') return options.createChatPane(container, panelId, selection);
		return this.chatViewsFactory.createSessionChatView(container, {
			panelId, selection, createNewSession: options.createNewSession, onDidChangeInfo: () => this.updateInfoContext(),
		});
	}
}

function bindAgentSession(pane: ISessionsConversationPane, selection: SessionsViewSelection): void {
	if (selection.kind === 'session') {
		void pane.model.selectThread(selection.active).catch(error => console.error('Failed to select Sessions Chat thread', error));
	} else {
		pane.model.selectUntitledSession(selection.session);
	}
	const session = selection.kind === 'session' ? selection.active.session : selection.session;
	pane.element.setAttribute('aria-label', session.title.trim() || localize('sessions.conversation.editorName', 'Session'));
}

class SessionsChatEmptyView extends Disposable implements IView {
	readonly element: HTMLDivElement;
	readonly minimumWidth = 0;
	readonly maximumWidth = Number.POSITIVE_INFINITY;
	readonly minimumHeight = 0;
	readonly maximumHeight = Number.POSITIVE_INFINITY;
	private readonly heading: HTMLHeadingElement;
	private readonly description: HTMLParagraphElement;

	constructor(
		container: HTMLElement,
		private readonly welcomeComplete: () => boolean,
	) {
		super();
		const ownerDocument = container.ownerDocument;
		this.element = h(ownerDocument, 'div');
		this.element.className = 'ash-sessions-chat-view-empty';
		this.heading = h(ownerDocument, 'h2');
		this.description = h(ownerDocument, 'p');
		this.element.append(this.heading, this.description);
		container.append(this.element);
		this.update('ready', undefined);
	}

	layout(_bounds: IPositionedRectangle): void { }

	update(state: ISessionsManagementService['state'], error: string | undefined): void {
		this.element.setAttribute('aria-busy', String(state === 'loading'));
		if (state === 'loading') {
			this.heading.textContent = localize('sessions.empty.loading', 'Loading sessions');
			this.description.textContent = localize('sessions.empty.restoring', 'Restoring your agent workspace…');
		} else if (error) {
			this.heading.textContent = localize('sessions.empty.unavailable', 'Sessions unavailable');
			this.description.textContent = error;
		} else {
			this.heading.textContent = this.welcomeComplete()
				? localize('sessions.empty.returning', 'Open a session')
				: localize('sessions.empty.welcome', 'Start a code session');
			this.description.textContent = this.welcomeComplete()
				? localize('sessions.empty.select', 'Select a session from the sidebar, or create a new one.')
				: localize(
					'sessions.empty.begin',
					'Create a session to plan, implement, or review work with the coding agent.',
				);
		}
	}
}

function sessionKey(sessionId: SessionId): string {
	return `session:${sessionId}`;
}
