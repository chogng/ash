import { ILogService } from '../../platform/log/common/log.js';
import { logSessionHistoryBinding } from '../services/sessions/browser/sessionOpenTelemetryService.js';
import { ISessionsListModelService } from '../services/sessions/browser/sessionsListModelService.js';
import { ISessionProviderScopeService } from './agentHost/sessionProviderScopeService.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../common/agentHostSessionsProvider.js';
import * as chatInputStatePersistence from '../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import type { ChatChangesStatistics } from '../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { ChatViewPane, type IChatViewPaneEntry } from '../../workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewPane.js';
import { DisposableMap, DisposableStore } from '../../base/common/lifecycle.js';
import { Emitter } from '../../base/common/event.js';
import { constObservable } from '../../base/common/observable.js';
import type { IQuickChatSession, IChatWidgetViewOptions } from '../../workbench/contrib/chat/browser/chat.js';
import type { SessionsViewSelection } from '../services/sessions/browser/sessionsService.js';
import { IAuxiliaryWindowService } from '../../workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { ChatAuxiliaryWindow } from '../../workbench/contrib/chat/browser/widgetHosts/chatAuxiliaryWindow.js';
import { Button } from '../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../platform/theme/browser/defaultStyles.js';
import { isRecord } from '../../base/common/types.js';
import { readUntitledSession } from '../services/sessions/browser/sessionGridState.js';
import { setDisposableOwner, toDisposable } from '../../base/common/lifecycle.js';
import { IMenuService } from '../../platform/actions/common/actions.js';
import { IAccessibleViewService } from '../../platform/accessibility/browser/accessibleView.js';
import { IContextMenuService, IContextViewService } from '../../platform/contextview/browser/contextView.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import type { IViewPaneOptions } from '../../workbench/browser/parts/views/viewPane.js';
import { IWorkbenchLayoutService } from '../../workbench/services/layout/browser/layoutService.js';
import { IChatService } from '../../workbench/services/chat/common/chatService.js';
import { canOpenThreadInCode, type IActiveSessionThread, type IChat, type ISession, type IUntitledChatSession, type ThreadId } from '../services/sessions/common/session.js';
import { ISessionsManagementService } from '../services/sessions/common/sessionsManagement.js';
import { ChatWidget, resolveMarkdownWorkspaceResource } from '../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { h } from '../../base/browser/dom.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { IEditorService } from '../../workbench/services/editor/common/editorService.js';
import { IFileService } from '../../platform/files/common/files.js';
import { URI } from '../../base/common/uri.js';
import { IContextKeyService } from '../../platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { createSessionItemActions, createSessionWorkspaceActions } from './agentSessionsModel.js';
import { ILifecycleService } from '../../workbench/services/lifecycle/common/lifecycle.js';
import { readNewChatDraftState, writeNewChatDraftState } from '../contrib/chat/common/newChatDraftState.js';
import { localize } from '../../nls.js';
import { ChatWidgetModel, type ChatWidgetSelection } from './chatWidgetModel.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import type { IAction } from '../../base/common/actions.js';
import { ForkConversationActionId } from '../../workbench/contrib/chat/browser/actions/chatForkActions.js';
import { IEditorGroupsService } from '../../workbench/services/editor/common/editorGroupsService.js';
import { createTurnMultiDiffEditorInput } from './turnMultiDiffSource.js';
import { CODE_HISTORY_VIRTUALIZE_FROM } from '../contrib/chat/common/constants.js';

let chatPaneInstanceId = 0;
const codeHistoryVirtualizeFrom = constObservable(CODE_HISTORY_VIRTUALIZE_FROM);

/**
 * Retains opened conversations behind a shared tab row or list switcher.
 *
 * Each opened untitled or durable Session owns one retained ChatWidget. Thread
 * selection remains internal to durable panes, while untitled sessions
 * materialize when sent or organized through their item actions.
 */
export class SessionChatViewPane extends ChatViewPane<ChatWidgetModel> {
	private readonly chatService: IChatService;
	private readonly sessionService: ISessionsManagementService;
	private readonly contextMenuService: IContextMenuService;
	private readonly restoredThreadIds = new Map<string, ThreadId>();
	private readonly panes = new Map<string, ChatWidget<ChatWidgetModel>>();
	private readonly paneScopes = this._register(new DisposableMap<ChatWidget<ChatWidgetModel>, DisposableStore>());
	private initialUntitledSessionId: string | undefined;
	private viewDisposed = false;
	private restoringViewState = true;
	private failedSelectionRevision: number | undefined;
	private readonly popouts = new Map<ChatWidget<ChatWidgetModel>, { shell: ChatAuxiliaryWindow; resources: DisposableStore; placeholder: HTMLElement; }>();
	private readonly openingPopouts = new Map<ChatWidget<ChatWidgetModel>, Promise<void>>();
	private readonly embeddedChats = new Map<ChatWidget<ChatWidgetModel>, { readonly session: IQuickChatSession; readonly placeholder: HTMLElement; readonly titleId: string; visible: boolean; }>();
	private readonly embeddedOptions = new Map<string, IChatWidgetViewOptions>();
	private readonly sessionsReady: Promise<void>;

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@IChatService chatService: IChatService,
		@ISessionsManagementService sessionService: ISessionsManagementService,
		@IMenuService menuService: IMenuService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ICommandService commandService: ICommandService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IFileService private readonly fileService: IFileService,
		@IAccessibleViewService private readonly accessibleViewService: IAccessibleViewService,
		@INotificationService notifications: INotificationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configuration: IConfigurationService,
		@IStorageService private readonly storage: IStorageService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IAuxiliaryWindowService private readonly auxiliaryWindows: IAuxiliaryWindowService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IEditorGroupsService editorGroups: IEditorGroupsService,
		@IOpenerService private readonly openerService: IOpenerService | undefined,
		@IEditorService editorService: IEditorService | undefined,
		@ISessionProviderScopeService private readonly providerScopes: ISessionProviderScopeService,
		@ISessionsListModelService private readonly listModel: ISessionsListModelService,
	) {
		super(container, options, commandService, layoutService, instantiationService, configuration, notifications, lifecycleService, contextKeyService, editorGroups, editorService);
		this.chatService = chatService;
		this.sessionService = sessionService;
		this.contextMenuService = contextMenuService;
		this.initializeSessionsControl(() => { this.sessionService.createUntitledSession(); }, item => {
			const target = item.target;
			const selection = 'untitledSessionId' in target
				? sessionService.untitledSessions.find(draft => draft.untitledSessionId === target.untitledSessionId)
				: sessionService.sessions.find(session => session.sessionId === target.sessionId);
			if (!selection) return [];
			const captured: SessionsViewSelection = 'untitledSessionId' in selection
				? { kind: 'untitled', session: selection }
				: { kind: 'session', active: { session: selection, threadId: 'threadId' in target ? target.threadId! : selection.chats[0]!.threadId } };
			const workspaceActions = captured.kind === 'session'
				? createSessionWorkspaceActions(captured.active.session.sessionId, captured.active.threadId, sessionService, commandService)
				: [];
			return [...workspaceActions, ...createSessionItemActions(captured, commandService, this.listModel, notifications, {
				projectScope: 'chat', openInNewWindow: () => this.openInNewWindow(captured),
			})];
		}, preserveFocus => {
			const focusChat = !this.sessionsSideBySide || !preserveFocus;
			this.hideSessionsAfterSelection();
			if (focusChat) this.focus();
		});
		const storedSelection = storage.get('chat.viewState', StorageScope.WORKSPACE);
		const restored = this.restoreViewState(storedSelection);
		this._register(sessionService.onDidChange(() => {
			this.syncSessions();
			if (!this.restoringViewState && this.failedSelectionRevision !== sessionService.navigationRevision) this.failedSelectionRevision = undefined;
			this.saveViewState();
		}));
		this._register(storage.onWillSaveState(() => this.saveViewState()));
		this._register(layoutService.onDidChangePartVisibility((event) => {
			if (event.partId === 'auxiliarybar' && event.visible) this.ensureConversationForVisibleChat();
		}));
		this._register(toDisposable(() => {
			this.viewDisposed = true;
			for (const mount of this.embeddedChats.values()) { mount.session.dispose(); }
			for (const popup of this.popouts.values()) popup.resources.dispose();
			this.popouts.clear();
			for (const pane of this.panes.values()) pane.dispose();
			this.paneScopes.clearAndDisposeAll();
			this.panes.clear();
		}));
		this.updateSessionsLayout();
		this.syncSessions();
		this.ensureConversationForVisibleChat();
		let restoringRevision = sessionService.navigationRevision;
		const restoring = sessionService.initialize().then(async () => {
			if (this.viewDisposed) return;
			if (restored && sessionService.navigationRevision === restoringRevision) {
				const opening = sessionService.openThread(restored.sessionId, restored.threadId);
				restoringRevision = sessionService.navigationRevision;
				await opening;
				if (this.viewDisposed) return;
			}
			this.restoringViewState = false;
			if (sessionService.navigationRevision !== restoringRevision) this.failedSelectionRevision = undefined;
			this.discardInitialUntitledSessionWhenDurableChatExists();
			this.ensureConversationForVisibleChat();
			this.saveViewState();
		}).catch(error => {
			if (this.viewDisposed) return;
			this.restoringViewState = false;
			this.failedSelectionRevision = storedSelection && sessionService.navigationRevision === restoringRevision ? restoringRevision : undefined;
			this.saveViewState();
			this.notifications.error(localize('chat.selection.restoreFailed', 'Could not restore the Chat selection: {0}', String(error)));
		});
		void this.getProgressIndicator().showWhile(restoring, 150);
		this.sessionsReady = restoring;
	}

	protected override async restoreEditorPane(id: string, signal: AbortSignal): Promise<void> {
		await this.sessionsReady;
		signal.throwIfAborted();
		this.syncSessions(id);
	}

	private restoreViewState(raw: string | undefined): { readonly sessionId: string; readonly threadId: string; } | undefined {
		if (!raw) return undefined;
		const restoreSelection = !this.sessionService.active && !this.sessionService.activeUntitledSession;
		try {
			const value: unknown = JSON.parse(raw);
			if (isRecord(value) && value.version === 2 && typeof value.sessionsSidebarWidth === 'number'
				&& Number.isFinite(value.sessionsSidebarWidth) && value.sessionsSidebarWidth >= SessionChatViewPane.SESSIONS_SIDEBAR_MIN_WIDTH) {
				this.sessionsSidebarWidth = value.sessionsSidebarWidth;
			}
			if (!restoreSelection) return undefined;
			if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || !Array.isArray(value.drafts)) {
				throw new TypeError(localize('chat.selection.invalid', 'Invalid stored Chat selection.'));
			}
			const drafts = value.drafts.map(value => {
				const draft = readUntitledSession(value);
				if (!draft) throw new TypeError(localize('chat.selection.invalid', 'Invalid stored Chat selection.'));
				return draft;
			});
			if (new Set(drafts.map(draft => draft.untitledSessionId)).size !== drafts.length) {
				throw new TypeError(localize('chat.selection.invalid', 'Invalid stored Chat selection.'));
			}
			const active = value.active;
			if (active !== undefined && (!isRecord(active) || (active.kind === 'untitled'
				? typeof active.id !== 'string' || !drafts.some(draft => draft.untitledSessionId === active.id)
				: active.kind !== 'session' || typeof active.sessionId !== 'string' || !active.sessionId || typeof active.threadId !== 'string' || !active.threadId))) {
				throw new TypeError(localize('chat.selection.invalid', 'Invalid stored Chat selection.'));
			}
			if (value.version === 2) {
				const opened = value.opened;
				if (!Array.isArray(opened) || !opened.every(id => typeof id === 'string' && /^(untitled|session):.+$/u.test(id))
					|| new Set(opened).size !== opened.length
					|| value.threads !== undefined && (!isRecord(value.threads) || !Object.entries(value.threads).every(([id, thread]) =>
						opened.includes(id) && id.startsWith('session:') && typeof thread === 'string' && thread.length > 0))) {
					throw new TypeError(localize('chat.selection.invalid', 'Invalid stored Chat selection.'));
				}
				this.openedPaneIds = [...opened];
				if (isRecord(value.threads)) {
					for (const [id, thread] of Object.entries(value.threads)) this.restoredThreadIds.set(id, thread as ThreadId);
				}
			}
			for (const draft of drafts) this.sessionService.restoreUntitledSession(draft);
			if (isRecord(value.active) && value.active.kind === 'untitled') this.sessionService.selectUntitledSession(value.active.id as string);
			if (isRecord(value.active) && value.active.kind === 'session') return { sessionId: value.active.sessionId as string, threadId: value.active.threadId as string };
		} catch (error) {
			if (!restoreSelection) return undefined;
			this.failedSelectionRevision = this.sessionService.navigationRevision;
			this.notifications.error(localize('chat.selection.restoreFailed', 'Could not restore the Chat selection: {0}', String(error)));
		}
		return undefined;
	}

	protected override saveViewState(): void {
		if (this.restoringViewState || this.failedSelectionRevision !== undefined || this.viewDisposed) return;
		const draft = this.sessionService.activeUntitledSession;
		const selected = this.sessionService.active;
		const active = draft ? { kind: 'untitled', id: draft.untitledSessionId }
			: selected ? { kind: 'session', sessionId: selected.session.sessionId, threadId: selected.threadId } : undefined;
		const threads = Object.fromEntries(this.openedPaneIds.flatMap(id => {
			const threadId = this.panes.get(id)?.threadId ?? this.restoredThreadIds.get(id);
			return threadId ? [[id, threadId]] : [];
		}));
		this.storage.store('chat.viewState', JSON.stringify({ version: 2, drafts: this.sessionService.untitledSessions, opened: this.openedPaneIds, threads, active, sessionsSidebarWidth: this.sessionsSidebarWidth }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	override focus(): void {
		if (this.activePane) this.popouts.get(this.activePane)?.shell.window.window.focus();
		super.focus();
	}

	async openInNewWindow(selection?: SessionsViewSelection): Promise<void> {
		if (!selection) {
			const draft = this.sessionService.activeUntitledSession;
			const active = this.sessionService.active;
			selection = draft ? { kind: 'untitled', session: draft } : active ? { kind: 'session', active } : undefined;
		}
		if (!selection) return;
		if (selection.kind === 'untitled') {
			const materialized = this.sessionService.materializedSessions.get().get(selection.session.untitledSessionId);
			const session = materialized && this.sessionService.sessions.find(session => session.sessionId === materialized.sessionId);
			if (session && materialized) selection = { kind: 'session', active: { session, threadId: materialized.threadId } };
		}
		const paneId = selection.kind === 'untitled' ? untitledSessionPaneId(selection.session) : sessionPaneId(selection.active.session);
		// Open a catalog entry without navigating the IDE's foreground conversation.
		this.syncSessions(paneId);
		const pane = this.panes.get(paneId);
		if (!pane) throw new Error(localize('chatSession.target.invalid', 'Choose a valid session.'));
		const releasingEditor = this.releaseSessionEditor(pane);
		if (releasingEditor && !await releasingEditor || this.viewDisposed || pane.isDisposed) return;
		const existing = this.popouts.get(pane);
		if (existing) { existing.shell.window.window.focus(); pane.focus(); return; }
		let pending = this.openingPopouts.get(pane);
		if (!pending) {
			pending = this.detachPane(pane, selection.kind === 'session' ? selection.active.session.title : selection.session.title);
			this.openingPopouts.set(pane, pending);
		}
		try { await pending; }
		finally { if (this.openingPopouts.get(pane) === pending) this.openingPopouts.delete(pane); }
	}

	private async detachPane(pane: ChatWidget<ChatWidgetModel>, title: string): Promise<void> {
		const window = await this.auxiliaryWindows.open({ title, width: 900, height: 760 });
		if (this.viewDisposed || ![...this.panes.values()].includes(pane)) { window.dispose(); return; }
		const resources = new DisposableStore();
		try {
			const shell = resources.add(this.instantiationService.createInstance(ChatAuxiliaryWindow, window, title, undefined));
			const placeholder = h(this.paneHost.ownerDocument, 'div', { className: 'ash-chat-detached-chat' });
			placeholder.id = `${pane.element.id}-detached`;
			resources.add(new Button(placeholder, {
				...defaultButtonStyles, presentation: 'quiet', label: localize('sessions.window.focus', 'Chat is open in another window'),
				onClick: () => { window.window.focus(); pane.focus(); },
			}));
			this.popouts.set(pane, { shell, resources, placeholder });
			resources.add(toDisposable(() => {
				this.popouts.delete(pane);
				// Reattach the same editor before the popup document is destroyed.
				this.paneHost.append(pane.element);
				placeholder.remove();
				if (!this.viewDisposed && [...this.panes.values()].includes(pane)) {
					if (pane.sessionId && pane.threadId) this.sessionService.selectThread(pane.sessionId, pane.threadId);
					else if (pane.model.untitledSessionId) this.sessionService.selectUntitledSession(pane.model.untitledSessionId);
					this.syncSessions();
					if (!this.editorMount) this.layoutService.showPart('auxiliarybar');
					this.paneHost.ownerDocument.defaultView?.focus();
					pane.focus();
				}
				window.dispose();
			}));
			resources.add(window.onDidClose(() => resources.dispose()));
			this.syncSessions();
			shell.mount(pane.element);
			pane.setVisible(true);
			window.layout();
			window.window.focus();
			pane.focus();
		} catch (error) { resources.dispose(); window.dispose(); throw error; }
	}

	protected override get selectionRevision(): number {
		return this.sessionService.navigationRevision;
	}

	public override createEmbeddedChat(parent: HTMLElement, titleId: string, options: IChatWidgetViewOptions = {}): IQuickChatSession {
		let disposed = false;
		const draft = this.sessionService.createUntitledSession(undefined, undefined, undefined, false);
		this.embeddedOptions.set(draft.untitledSessionId, {
			showWelcome: false,
			get workspacePickerDelegate() { return disposed ? undefined : options.workspacePickerDelegate; },
			submitHandler: (query, mode, contexts, signal) => disposed || !options.submitHandler ? Promise.resolve(false) : options.submitHandler(query, mode, contexts, signal),
		});
		const id = untitledSessionPaneId(draft);
		this.syncSessions(id);
		const pane = this.panes.get(id)!;
		this.embeddedOptions.delete(draft.untitledSessionId);
		const resources = new DisposableStore();
		const retired = resources.add(new Emitter<void>());
		setDisposableOwner(resources, this);
		const placeholder = h(parent.ownerDocument, 'div', { className: 'ash-sessions-detached-chat' });
		placeholder.id = `${pane.element.id}-quick`;
		resources.add(new Button(placeholder, {
			...defaultButtonStyles,
			presentation: 'quiet',
			label: localize('chat.embedded.focus', 'Chat is open in another view'),
			onClick: () => { pane.focusInput(); },
		}));
		const session: IQuickChatSession = {
			[Symbol.dispose]: () => session.dispose(),
			widget: pane,
			onDidDispose: retired.event,
			setVisible: visible => {
				const mount = this.embeddedChats.get(pane);
				if (mount?.session !== session) return;
				mount.visible = visible;
				pane.setVisible(visible);
			},
			reveal: () => {
				if (disposed) return;
				session.dispose();
				if (pane.sessionId && pane.threadId) this.sessionService.selectThread(pane.sessionId, pane.threadId);
				else if (pane.model.untitledSessionId) this.sessionService.selectUntitledSession(pane.model.untitledSessionId);
				this.syncSessions();
			},
			dispose: () => {
				if (disposed) return;
				disposed = true;
				this.embeddedChats.delete(pane);
				pane.input.render(pane.model.inputState);
				this.paneHost.append(pane.element);
				placeholder.remove();
				retired.fire();
				resources.dispose();
				queueMicrotask(() => { if (!this.viewDisposed) this.syncSessions(); });
			},
		};
		this.embeddedChats.set(pane, { session, placeholder, titleId, visible: true });
		this.syncSessions();
		parent.append(pane.element);
		return session;
	}

	private createChatPane(selection: ChatWidgetSelection, options?: IChatWidgetViewOptions): ChatWidget<ChatWidgetModel> {
		const providerId = selection.kind === 'untitled' ? selection.session.providerId : selection.active.session.providerId;
		const resources = new DisposableStore();
		const services = providerId && providerId !== LOCAL_AGENT_HOST_PROVIDER_ID
			? resources.add(this.providerScopes.createScope(undefined, providerId))
			: this.instantiationService;
		let model: ChatWidgetModel | undefined;
		try {
			model = services.createInstance(ChatWidgetModel, this.chatService, selection, this.sessionService);
			const conversation = model;
			const log = services.getOptional(ILogService);
			if (log) resources.add(logSessionHistoryBinding(log, model.onDidFinishHistoryBinding));
			const editor = this.editorService;
			const openTurnChanges: IChatWidgetViewOptions['openTurnChanges'] = editor && (async ({ sessionId, threadId, turnId }, signal) => {
				const input = await createTurnMultiDiffEditorInput(this.chatService, { session: { sessionId }, threadId }, { turnId }, undefined, signal);
				if (!signal.aborted) await editor.openEditor(input, { pinned: true });
			});
			const pane = services.createInstance<ChatWidget<ChatWidgetModel>>(ChatWidget,
				this.paneHost,
				`ash-chat-pane-${++chatPaneInstanceId}`,
				model,
				() => { this.sessionService.createUntitledSession(); },
				this.contextMenuService,
				this.contextViewService,
				this.commandService,
				this.accessibleViewService,
				this.notifications,
				this.openerService,
				this.editorService,
				(resource: URI) => readMarkdownImageResource(this.fileService, resource),
				undefined, {
				...options, virtualizeHistoryFrom: options?.virtualizeHistoryFrom ?? codeHistoryVirtualizeFrom, configureModelInMenu: true, openTurnChanges,
				changes: {
					refreshConversation: () => conversation.refreshChanges(),
					readWorkspace: () => readWorkspaceChanges(this.commandService),
				},
			},
			);
			this.paneScopes.set(pane, resources);
			return pane;
		} catch (error) {
			// Widget construction may fail before it can return an owner for the model.
			try {
				model?.dispose();
			} finally {
				resources.dispose();
			}
			throw error;
		}
	}

	protected override updateSessions(openPaneId?: string): {
		readonly entries: readonly IChatViewPaneEntry<ChatWidgetModel>[];
		readonly activePaneId: string | undefined;
	} {
		this.rekeyMaterializedPanes();
		const activePaneId = this.activePaneId();
		for (const id of [activePaneId, openPaneId]) {
			if (id && !this.openedPaneIds.includes(id)) this.openedPaneIds.push(id);
		}
		const entries: IChatViewPaneEntry<ChatWidgetModel>[] = [];
		const retainedPaneIds = new Set<string>();
		for (const untitledSession of this.sessionService.untitledSessions) {
			const paneId = untitledSessionPaneId(untitledSession);
			if (!this.openedPaneIds.includes(paneId)) continue;
			retainedPaneIds.add(paneId);
			let pane = this.panes.get(paneId);
			if (!pane) {
				pane = this.createChatPane({ kind: 'untitled', session: untitledSession }, this.embeddedOptions.get(untitledSession.untitledSessionId));
				pane.bindDraftStorage({
					read: identity => readNewChatDraftState(this.storage, identity, chatInputStatePersistence),
					write: (identity, draft) => writeNewChatDraftState(this.storage, draft, identity, chatInputStatePersistence),
					flush: () => this.storage.flush(),
				}, this.lifecycleService.onWillShutdown);
				setDisposableOwner(pane, this);
				this.panes.set(paneId, pane);
			} else {
				pane.model.selectUntitledSession(untitledSession);
			}
			entries.push({
				id: paneId, label: untitledSession.title.trim() || localize('chat.title.new', 'New Chat'), pane,
				getActions: () => this.getSessionTabActions({ kind: 'untitled', session: untitledSession }),
			});
		}
		for (const session of this.sessionService.sessions) {
			if (session.status !== 'active') continue;
			const selection = this.selectionForSession(session);
			if (!selection) continue;
			const paneId = sessionPaneId(session);
			if (!this.openedPaneIds.includes(paneId)) continue;
			retainedPaneIds.add(paneId);
			let pane = this.panes.get(paneId);
			// Catalog history is not an opened conversation. Instantiating every
			// entry also restores every subscription and catalog read on reconnect.
			if (!pane) {
				pane = this.createChatPane({ kind: 'session', active: selection });
				pane.bindDraftStorage({
					read: identity => readNewChatDraftState(this.storage, identity, chatInputStatePersistence),
					write: (identity, draft) => writeNewChatDraftState(this.storage, draft, identity, chatInputStatePersistence),
					flush: () => this.storage.flush(),
				}, this.lifecycleService.onWillShutdown);
				setDisposableOwner(pane, this);
				this.panes.set(paneId, pane);
			} else {
				void pane.model.selectThread(selection);
			}
			const selectedThread = session.chats.find(chat => chat.threadId === selection.threadId);
			const threadTitle = selectedThread?.origin.type !== 'root' ? selectedThread?.title : undefined;
			entries.push({
				id: paneId, label: threadTitle?.trim() || session.title.trim() || localize('chat.title.default', 'Chat'), pane,
				getActions: () => this.getSessionTabActions({ kind: 'session', active: selection }),
			});
		}
		for (const [paneId, pane] of this.panes) {
			if (retainedPaneIds.has(paneId)) continue;
			this.panes.delete(paneId);
			this.embeddedChats.get(pane)?.session.dispose();
			this.popouts.get(pane)?.resources.dispose();
			pane.dispose();
			this.paneScopes.deleteAndDispose(pane);
		}
		if (!this.restoringViewState) this.openedPaneIds = this.openedPaneIds.filter(id => retainedPaneIds.has(id));
		return {
			activePaneId,
			entries: entries.map(entry => {
				const embedded = this.embeddedChats.get(entry.pane);
				if (embedded) {
					return { ...entry, detached: { placeholder: embedded.placeholder, titleId: embedded.titleId, visible: embedded.visible } };
				}
				const popup = this.popouts.get(entry.pane);
				if (!popup) {
					return entry;
				}
				popup.shell.setTitle(entry.label);
				return { ...entry, detached: { placeholder: popup.placeholder, titleId: popup.shell.title.id } };
			}),
		};
	}

	private getSessionTabActions(selection: SessionsViewSelection): readonly IAction[] {
		const actions = createSessionItemActions(selection, this.commandService, this.listModel, this.notifications, {
			projectScope: 'chat', openInNewWindow: () => this.openInNewWindow(selection),
		})
			.filter(action => ['agentSession.rename', 'sessions.list.togglePin', 'sessions.openInNewWindow'].includes(action.id));
		const rename = actions.find(action => action.id === 'agentSession.rename')!;
		return [
			rename,
			{
				id: ForkConversationActionId, label: localize('sessions.history.fork', 'Fork'), tooltip: '', enabled: selection.kind === 'session',
				run: () => {
					if (selection.kind !== 'session') return;
					return this.commandService.executeCommand(ForkConversationActionId, {
						sessionId: selection.active.session.sessionId, threadId: selection.active.threadId,
					}).catch(error => this.notifications.error(String(error)));
				},
			},
			...actions.filter(action => action !== rename),
			...(selection.kind === 'session'
				? createSessionWorkspaceActions(selection.active.session.sessionId, selection.active.threadId, this.sessionService, this.commandService)
				: []),
		];
	}

	private selectionForSession(session: ISession): IActiveSessionThread | undefined {
		const active = this.sessionService.activeUntitledSession ? undefined : this.sessionService.active;
		const canOpen = (chat: IChat) => canOpenThreadInCode(session, chat);
		if (
			active?.session.sessionId === session.sessionId &&
			session.chats.some(chat => chat.threadId === active.threadId && canOpen(chat))
		) {
			return { session, threadId: active.threadId };
		}
		const retainedThreadId = this.panes.get(sessionPaneId(session))?.threadId ?? this.restoredThreadIds.get(sessionPaneId(session));
		if (retainedThreadId && session.chats.some(chat => chat.threadId === retainedThreadId && canOpen(chat))) {
			return { session, threadId: retainedThreadId };
		}
		const thread = session.chats.find(chat => chat.origin.type === 'root' && canOpen(chat)) ?? session.chats.find(canOpen);
		return thread ? { session, threadId: thread.threadId } : undefined;
	}

	protected override ensureConversationForVisibleChat(): void {
		if (!this.layoutService.isPartVisible('auxiliarybar') || this.panes.size > 0) return;
		const session = this.sessionService.createUntitledSession();
		if (this.sessionService.state === 'loading' && this.initialUntitledSessionId === undefined) {
			this.initialUntitledSessionId = session.untitledSessionId;
		}
	}

	private discardInitialUntitledSessionWhenDurableChatExists(): void {
		const untitledSessionId = this.initialUntitledSessionId;
		this.initialUntitledSessionId = undefined;
		if (!untitledSessionId || !this.panes.has(`untitled:${untitledSessionId}`)) return;
		if (this.sessionService.sessions.some(session => session.status === 'active' && this.selectionForSession(session))) {
			this.sessionService.discardUntitledSession(untitledSessionId);
		}
	}

	private activePaneId(): string | undefined {
		const untitledSession = this.sessionService.activeUntitledSession;
		if (untitledSession) return untitledSessionPaneId(untitledSession);
		const active = this.sessionService.active;
		return active ? sessionPaneId(active.session) : undefined;
	}

	private rekeyMaterializedPanes(): void {
		for (const [paneId, pane] of [...this.panes]) {
			const draftId = pane.model.untitledSessionId;
			const sessionId = pane.sessionId ?? (draftId ? this.sessionService.materializedSessions.get().get(draftId)?.sessionId : undefined);
			if (!sessionId) continue;
			const materializedPaneId = sessionPaneIdFromId(sessionId);
			if (paneId === materializedPaneId) continue;
			this.openedPaneIds = [...new Set(this.openedPaneIds.map(id => id === paneId ? materializedPaneId : id))];
			const existing = this.panes.get(materializedPaneId);
			if (existing && existing !== pane) {
				const origin = pane.model.materializingUntitledSessionId;
				const active = this.sessionService.active;
				// Keep the first submission's editor and lifetime when the catalog arrived
				// before its create response. A deliberately selected durable draft wins.
				if (origin && paneId === `untitled:${origin}` && pane === this.activePane && active?.session.sessionId === sessionId && active.threadId === pane.threadId) {
					this.panes.delete(materializedPaneId);
					this.popouts.get(existing)?.resources.dispose();
					existing.dispose();
				} else {
					this.panes.delete(paneId);
					this.embeddedChats.get(pane)?.session.dispose();
					this.popouts.get(pane)?.resources.dispose();
					pane.dispose();
					this.paneScopes.deleteAndDispose(pane);
					continue;
				}
			}
			this.panes.delete(paneId);
			this.panes.set(materializedPaneId, pane);
		}
	}

	protected override activatePane(id: string, threadId?: string): void {
		const pane = this.panes.get(id);
		if (!pane) return;
		if (pane.model.untitledSessionId) this.sessionService.selectUntitledSession(pane.model.untitledSessionId);
		else if (pane.sessionId && pane.threadId) {
			const session = threadId && this.sessionService.sessions.find(candidate => candidate.sessionId === pane.sessionId);
			this.sessionService.selectThread(pane.sessionId, session && isActiveThread(session, threadId) ? threadId : pane.threadId);
		}
	}



}

/** Validates the optional Git extension's command result at its process boundary. */
async function readWorkspaceChanges(commands: ICommandService): Promise<ChatChangesStatistics | undefined> {
	let result: unknown;
	try {
		result = await commands.executeCommand('git.getChangesSummary');
	} catch (error) {
		if (error instanceof Error && error.message === 'Unknown command: git.getChangesSummary') return undefined;
		throw error;
	}
	if (!result || typeof result !== 'object') throw new TypeError('Invalid workspace changes summary');
	const value = result as Record<string, unknown>;
	for (const key of ['files', 'additions', 'deletions']) {
		if (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 0) throw new TypeError('Invalid workspace change statistics');
	}
	if (value.partial !== undefined && typeof value.partial !== 'boolean') throw new TypeError('Invalid workspace change coverage');
	return { files: value.files as number, additions: value.additions as number, deletions: value.deletions as number, partial: value.partial === true };
}

function isActiveThread(session: ISession, threadId: ThreadId): boolean {
	return session.chats.some((thread) => thread.threadId === threadId && thread.status === 'active');
}

function untitledSessionPaneId(session: IUntitledChatSession): string {
	return `untitled:${session.untitledSessionId}`;
}

function sessionPaneId(session: ISession): string {
	return sessionPaneIdFromId(session.sessionId);
}

function sessionPaneIdFromId(sessionId: string): string {
	return `session:${sessionId}`;
}

async function readMarkdownImageResource(fileService: IFileService, resource: URI): Promise<Blob> {
	const file = resolveMarkdownWorkspaceResource(resource);
	if (!file) throw new Error('Unsupported Markdown image resource');
	const extension = /\.([A-Za-z]+)$/u.exec(file.path)?.[1]?.toLowerCase();
	let mime: string | undefined;
	switch (extension) {
		case 'png': mime = 'image/png'; break;
		case 'jpg':
		case 'jpeg': mime = 'image/jpeg'; break;
		case 'gif': mime = 'image/gif'; break;
		case 'webp': mime = 'image/webp'; break;
	}
	if (!mime) throw new Error('Unsupported Markdown image type');
	const { bytes } = await fileService.readFileBytes(file);
	return new Blob([new Uint8Array(bytes)], { type: mime });
}
