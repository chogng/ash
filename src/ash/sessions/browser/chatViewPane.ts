import { DisposableStore } from '../../base/common/lifecycle.js';
import { ISessionGroupsService } from '../services/sessions/browser/sessionGroupsService.js';
import type { SessionsViewSelection } from '../services/sessions/browser/sessionsService.js';
import { IAuxiliaryWindowService } from '../../workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { SessionAuxiliaryWindow } from './parts/sessionView.js';
import { Button } from '../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../platform/theme/browser/defaultStyles.js';
import { isRecord } from '../../base/common/types.js';
import { isUntitledSession } from '../services/sessions/browser/sessionsService.js';
import { ChatEditorInput } from '../../workbench/contrib/chat/browser/widgetHosts/editor/chatEditorInput.js';
import './media/chatViewPane.css';
import { setDisposableOwner, toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import { IMenuService } from '../../platform/actions/common/actions.js';
import { IAccessibleViewService } from '../../platform/accessibility/browser/accessibleView.js';
import { IContextMenuService, IContextViewService } from '../../platform/contextview/browser/contextView.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import { ViewPane, type IViewPaneOptions, type PartTitleProjection } from '../../workbench/browser/parts/views/viewPane.js';
import { IWorkbenchLayoutService } from '../../workbench/services/layout/browser/layoutService.js';
import { IChatService } from '../../workbench/services/chat/common/chatService.js';
import type { IActiveSessionThread, IChat, ISession, IUntitledChatSession, ThreadId } from '../services/sessions/common/session.js';
import { ISessionsManagementService } from '../services/sessions/common/sessionsManagement.js';
import { ChatWidget, resolveMarkdownWorkspaceResource } from '../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { ChatViewTitleControl } from '../../workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewTitleControl.js';
import { addDisposableListener, h, isHTMLElement } from '../../base/browser/dom.js';
import { type ChatContextAttachment, type ChatImageCapture, type IChatContextTarget } from '../../workbench/services/chat/common/chatContextService.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { IEditorService } from '../../workbench/services/editor/common/editorService.js';
import { IFileService } from '../../platform/files/common/files.js';
import { URI } from '../../base/common/uri.js';
import { type IContextKey } from '../../platform/contextkey/common/contextkey.js';
import { ContextKeyService, IContextKeyService } from '../../platform/contextkey/browser/contextKeyService.js';
import { SHOW_CHAT_HISTORY_COMMAND_ID, AGENT_SESSIONS_PRESENTATION_SETTING, AgentSessionsPresentation, AgentSessionsPresentationContext, AgentSessionsSidebarVisibleContext } from '../../workbench/contrib/chat/common/chat.js';
import { ConfigurationTarget, IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { ChatConfiguration } from '../../workbench/contrib/chat/common/constants.js';
import { AgentSessionsControl } from '../../workbench/contrib/chat/browser/agentSessions/agentSessionsControl.js';
import { AgentSessionsViewerOrientation } from '../../workbench/contrib/chat/browser/agentSessions/agentSessions.js';
import { ChatContextKeys } from '../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { registerAgentSessionsAccessibility } from '../../workbench/contrib/chat/browser/agentSessions/agentSessionsAccessibility.js';
import { createAgentSessionsModel, createSessionItemActions } from './agentSessionsModel.js';
import { ILifecycleService } from '../../workbench/services/lifecycle/common/lifecycle.js';
import { readNewChatDraftState, writeNewChatDraftState } from '../contrib/chat/common/newChatDraftState.js';
import { localize } from '../../nls.js';
import { ChatWidgetModel } from './chatWidgetModel.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import type { IOpenAgentsWindowOptions } from '../../platform/native/common/nativeHost.js';
import { IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import type { TabListOptions } from '../../base/browser/ui/tablist/tabList.js';
import { onUnexpectedError } from '../../base/common/errors.js';
import { observeElementSize } from '../../base/browser/observer.js';
import { Orientation, Sash, SashState } from '../../base/browser/ui/sash/sash.js';
import { clamp } from '../../base/common/numbers.js';

let chatViewInstanceId = 0;
let chatPaneInstanceId = 0;
// The Part owns the hard minimum; side-by-side layout reserves room for both columns.
const defaultChatWidth = 300;
const defaultSessionsSidebarWidth = 300;
const minimumSessionsSidebarWidth = 200;
const sideBySideSessionsWidth = defaultChatWidth + defaultSessionsSidebarWidth;
const sessionsSidebarSnapThreshold = minimumSessionsSidebarWidth / 2;

interface ChatPaneEntry {
	readonly id: string;
	readonly label: string;
	readonly pane: ChatWidget<ChatWidgetModel>;
}

/**
 * Retains opened conversations behind a shared tab row or list switcher.
 *
 * Each opened untitled or durable Session owns one retained ChatWidget. Thread
 * selection remains internal to durable panes, while untitled sessions
 * materialize when sent or organized through their item actions.
 */
export class ChatViewPane extends ViewPane implements IChatContextTarget {
	private readonly chatService: IChatService;
	private readonly sessionService: ISessionsManagementService;
	private readonly contextMenuService: IContextMenuService;
	private readonly commandService: ICommandService;
	private readonly titleControl: ChatViewTitleControl;
	private readonly paneHost: HTMLDivElement;
	private readonly body: HTMLDivElement;
	private readonly sessionsSidebar: HTMLElement;
	private readonly sessionsControl: AgentSessionsControl;
	private readonly sessionsSash: Sash;
	private sessionsSidebarWidth = defaultSessionsSidebarWidth;
	private changingSessionsOrientation = false;
	private readonly sessionsSidebarVisible: IContextKey<boolean>;
	private readonly sessionsViewerOrientationContext: IContextKey<number | undefined>;
	private readonly lastDimensionsPerOrientation = new Map<AgentSessionsViewerOrientation, { height: number; width: number; }>();
	private readonly sessionsPresentationContext: IContextKey<AgentSessionsPresentation>;
	private sessionsPresentation = AgentSessionsPresentation.Tabs;
	private sessionsSideBySide = false;
	private sessionsSidebarManualVisibility: boolean | undefined;
	private chatBodyWidth = 0;
	private openedPaneIds: string[] = [];
	private readonly restoredThreadIds = new Map<string, ThreadId>();
	private draggedPaneId: string | undefined;
	private readonly closingPanes = new Set<string>();
	private readonly tabsOptions: TabListOptions<string>;
	private readonly empty: HTMLDivElement;
	private readonly panes = new Map<string, ChatWidget<ChatWidgetModel>>();
	private activePane: ChatWidget<ChatWidgetModel> | undefined;
	private initialUntitledSessionId: string | undefined;
	private viewDisposed = false;
	private restoringViewState = true;
	private failedSelectionRevision: number | undefined;
	private editorMount: IDisposable | undefined;
	private editorMountParent: HTMLElement | undefined;
	private editorVisible = true;
	private readonly inEditor: IContextKey<boolean>;
	private focusReturn: (() => void) | undefined;
	private readonly popouts = new Map<ChatWidget<ChatWidgetModel>, { shell: SessionAuxiliaryWindow; resources: DisposableStore; placeholder: HTMLElement; }>();
	private readonly openingPopouts = new Map<ChatWidget<ChatWidgetModel>, Promise<void>>();

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@IChatService chatService: IChatService,
		@ISessionsManagementService sessionService: ISessionsManagementService,
		@IMenuService menuService: IMenuService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ICommandService commandService: ICommandService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IFileService private readonly fileService: IFileService,
		@IAccessibleViewService private readonly accessibleViewService: IAccessibleViewService,
		@INotificationService private readonly notifications: INotificationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IStorageService private readonly storage: IStorageService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@ISessionGroupsService groups: ISessionGroupsService,
		@IAuxiliaryWindowService private readonly auxiliaryWindows: IAuxiliaryWindowService,
		@IContextKeyService contextKeyService?: IContextKeyService,
		@IOpenerService private readonly openerService?: IOpenerService,
		@IEditorService private readonly editorService?: IEditorService,
	) {
		super(container, options);
		this.chatService = chatService;
		this.sessionService = sessionService;
		this.contextMenuService = contextMenuService;
		this.commandService = commandService;
		this.tabsOptions = {
			ariaLabel: localize('chat.sessions.tabs', 'Opened sessions'),
			onActivate: id => this.activatePane(id),
			onClose: id => { void this.closePane(id).catch(onUnexpectedError); },
			draggable: true,
			dragAndDrop: {
				canDrop: () => this.draggedPaneId !== undefined,
				onDragStart: (id, event) => {
					this.draggedPaneId = id;
					event.dataTransfer?.setData('text/plain', id);
				},
				onDrop: (target, position) => {
					const source = this.draggedPaneId;
					if (!source || source === target) return;
					const ids = this.openedPaneIds.filter(id => id !== source);
					const index = target ? ids.indexOf(target) : ids.length;
					if (index < 0) return;
					ids.splice(index + (target && position === 'after' ? 1 : 0), 0, source);
					this.openedPaneIds = ids;
					this.syncSessions();
					this.saveViewState();
				},
				onDragEnd: () => { this.draggedPaneId = undefined; },
			},
		};
		this.element.classList.add('ash-chat-view-pane');
		this.headerElement.hidden = true;
		this.contentElement.classList.add('ash-chat-view');
		const viewId = `ash-chat-view-${++chatViewInstanceId}`;
		this.titleControl = this._register(this.instantiationService.createInstance(ChatViewTitleControl,
			this.element,
			viewId,
			(anchor: HTMLElement) => this.commandService.executeCommand(SHOW_CHAT_HISTORY_COMMAND_ID, anchor),
		));
		this.paneHost = h(container.ownerDocument, 'div');
		this.paneHost.className = 'ash-chat-pane-host';
		this.empty = h(container.ownerDocument, 'div');
		this.empty.className = 'ash-chat-empty ash-chat-view-empty';
		this.empty.textContent = 'Start a new chat to begin.';
		this.body = h(container.ownerDocument, 'div');
		this.body.className = 'ash-chat-body';
		const sidebarContextKeys = contextKeyService ?? this._register(new ContextKeyService());
		this.inEditor = sidebarContextKeys.createKey('chatInEditor', false);
		this._register(toDisposable(() => this.inEditor.reset()));
		this.sessionsSidebarVisible = AgentSessionsSidebarVisibleContext.bindTo(sidebarContextKeys);
		this.sessionsViewerOrientationContext = ChatContextKeys.agentSessionsViewerOrientation.bindTo(sidebarContextKeys);
		this._register(toDisposable(() => this.sessionsViewerOrientationContext.reset()));
		this.sessionsPresentationContext = AgentSessionsPresentationContext.bindTo(sidebarContextKeys);
		this._register(toDisposable(() => this.sessionsSidebarVisible.reset()));
		this._register(toDisposable(() => this.sessionsPresentationContext.reset()));
		this.sessionsSidebar = h(container.ownerDocument, 'aside');
		this.sessionsSidebar.className = 'ash-chat-sessions-sidebar';
		this.sessionsSidebar.id = `${viewId}-sessions`;
		this.sessionsSidebar.setAttribute('aria-label', localize('chat.sessions.sidebar', 'Agent sessions'));
		const sessionsHeader = h(container.ownerDocument, 'header');
		const sessionsTitle = h(container.ownerDocument, 'h2');
		sessionsTitle.textContent = localize('chat.sessions.title', 'Sessions');
		const newSessionButton = h(container.ownerDocument, 'button');
		newSessionButton.type = 'button';
		newSessionButton.className = 'ash-chat-sessions-new';
		newSessionButton.textContent = localize('chat.sessions.new', 'New Session');
		sessionsHeader.append(sessionsTitle, newSessionButton);
		this.sessionsSidebar.append(sessionsHeader);
		this.body.append(this.sessionsSidebar, this.paneHost);
		this._register(toDisposable(() => this.sessionsSidebar.remove()));
		this._register(registerAgentSessionsAccessibility(this.sessionsSidebar, sidebarContextKeys));
		const createNewSession = () => {
			this.sessionService.createUntitledSession();
			this.hideSessionsAfterSelection();
			this.activePane?.focus();
		};
		this._register(addDisposableListener(newSessionButton, 'click', createNewSession));
		this.sessionsControl = this._register(this.instantiationService.createInstance(AgentSessionsControl, this.sessionsSidebar, createAgentSessionsModel(sessionService, storage, groups,
			selection => createSessionItemActions(selection, commandService, storage, notifications, () => this.openInNewWindow(selection)), preserveFocus => {
				const focusChat = !this.sessionsSideBySide || !preserveFocus;
				this.hideSessionsAfterSelection();
				if (focusChat) this.focus();
			})));
		this._register(observeElementSize(this.sessionsControl.domNode, size => this.sessionsControl.layout(size.height, size.width)));
		this.sessionsControl.setVisible(false);
		this._register(this.sessionsControl.onDidRequestNewSession(createNewSession));
		this._register(this.onDidChangeBodyVisibility(() => this.updateSessionsControlVisibility()));
		this.sessionsSidebar.hidden = true;
		this.sessionsSash = this._register(new Sash(this.body, {
			getVerticalSashLeft: () => this.chatBodyWidth - this.effectiveSessionsSidebarWidth,
			getVerticalSashTop: () => 0,
			getVerticalSashHeight: () => this.body.clientHeight,
		}, { orientation: Orientation.VERTICAL }));
		this.sessionsSash.element.hidden = true;
		this.sessionsSash.state = SashState.Disabled;
		this.sessionsSash.element.setAttribute('aria-label', localize('chat.sessions.resize', 'Resize sessions sidebar'));
		this.sessionsSash.element.setAttribute('aria-controls', this.sessionsSidebar.id);
		let resizeStartWidth = defaultSessionsSidebarWidth;
		this._register(this.sessionsSash.onDidStart(() => { resizeStartWidth = this.effectiveSessionsSidebarWidth; }));
		this._register(this.sessionsSash.onDidChange(event => {
			if (this.changingSessionsOrientation || !this.sessionsSideBySide) return;
			const width = resizeStartWidth - (event.currentX - event.startX);
			if (event.input === 'pointer' && width < sessionsSidebarSnapThreshold) {
				this.changingSessionsOrientation = true;
				void this.configuration.updateValue(ChatConfiguration.ChatViewSessionsOrientation, 'stacked', ConfigurationTarget.USER_LOCAL)
					.catch(error => this.notifications.error(localize('chat.sessions.orientation.saveFailed', 'Could not save the session list layout: {0}', String(error))))
					.finally(() => { this.changingSessionsOrientation = false; });
				return;
			}
			this.sessionsSidebarWidth = clamp(width, minimumSessionsSidebarWidth, this.chatBodyWidth - defaultChatWidth);
			this.layoutSessionsSash();
		}));
		this._register(this.sessionsSash.onDidEnd(() => this.saveViewState()));
		this._register(this.sessionsSash.onDidReset(() => {
			this.sessionsSidebarWidth = defaultSessionsSidebarWidth;
			this.layoutSessionsSash();
			this.saveViewState();
		}));
		this.contentElement.append(this.body);
		// The same retained body can also be lent to an editor host with independent geometry.
		this._register(observeElementSize(this.body, size => this.updateSessionsSidebarLayout(size.width)));
		this._register(addDisposableListener(this.body, 'keydown', event => {
			if (event.key !== 'Escape' || !this.sessionsSidebarVisible.get()) return;
			event.preventDefault();
			this.sessionsSidebarManualVisibility = false;
			this.setSessionsSidebarVisible(false);
		}));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ChatConfiguration.ChatViewSessionsOrientation) && this.sessionsSidebarManualVisibility === false) {
				this.sessionsSidebarManualVisibility = undefined;
			}
			if (event.affectsConfiguration(AGENT_SESSIONS_PRESENTATION_SETTING) || event.affectsConfiguration(ChatConfiguration.ChatViewSessionsOrientation)) this.updateSessionsLayout();
		}));
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
			for (const popup of this.popouts.values()) popup.resources.dispose();
			this.popouts.clear();
			this.editorMount?.dispose();
			for (const pane of this.panes.values()) pane.dispose();
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
	}

	private restoreViewState(raw: string | undefined): { readonly sessionId: string; readonly threadId: string; } | undefined {
		if (!raw) return undefined;
		const restoreSelection = !this.sessionService.active && !this.sessionService.activeUntitledSession;
		try {
			const value: unknown = JSON.parse(raw);
			if (isRecord(value) && value.version === 2 && typeof value.sessionsSidebarWidth === 'number'
				&& Number.isFinite(value.sessionsSidebarWidth) && value.sessionsSidebarWidth >= minimumSessionsSidebarWidth) {
				this.sessionsSidebarWidth = value.sessionsSidebarWidth;
			}
			if (!restoreSelection) return undefined;
			if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || !Array.isArray(value.drafts) || !value.drafts.every(isUntitledSession)
				|| new Set(value.drafts.map(draft => draft.untitledSessionId)).size !== value.drafts.length) {
				throw new TypeError(localize('chat.selection.invalid', 'Invalid stored Chat selection.'));
			}
			const active = value.active;
			if (active !== undefined && (!isRecord(active) || (active.kind === 'untitled'
				? typeof active.id !== 'string' || !value.drafts.some(draft => draft.untitledSessionId === active.id)
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
			for (const draft of value.drafts) this.sessionService.restoreUntitledSession(draft);
			if (isRecord(value.active) && value.active.kind === 'untitled') this.sessionService.selectUntitledSession(value.active.id as string);
			if (isRecord(value.active) && value.active.kind === 'session') return { sessionId: value.active.sessionId as string, threadId: value.active.threadId as string };
		} catch (error) {
			if (!restoreSelection) return undefined;
			this.failedSelectionRevision = this.sessionService.navigationRevision;
			this.notifications.error(localize('chat.selection.restoreFailed', 'Could not restore the Chat selection: {0}', String(error)));
		}
		return undefined;
	}

	private saveViewState(): void {
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

	async moveToEditor(): Promise<void> {
		const revision = this.sessionService.navigationRevision;
		const pane = this.activePane;
		await pane?.captureDraft();
		if (this.viewDisposed || pane !== this.activePane || revision !== this.sessionService.navigationRevision) return;
		await this.editorService!.openEditor(new ChatEditorInput(), { pinned: true });
	}

	/** Lends the original conversation tree, including its live composer, to one editor host. */
	attachEditor(parent: HTMLElement): IDisposable {
		this.editorMount?.dispose();
		const focused = this.element.ownerDocument.activeElement;
		const title = this.titleControl.partTitleProjection;
		const header = h(parent.ownerDocument, 'div', { className: 'ash-chat-editor-title' });
		header.append(title.content!, title.actions!);
		parent.append(header, this.body);
		this.inEditor.set(true);
		const lease = toDisposable(() => {
			if (this.editorMount !== lease) return;
			this.editorMount = undefined;
			this.editorMountParent = undefined;
			this.activePane?.setVisible(true);
			this.contentElement.append(this.body);
			this.element.append(title.content!, title.actions!);
			header.remove();
			this.inEditor.set(false);
			this.updateSessionsControlVisibility();
			this.updateTitleArea();
			if (!this.viewDisposed && !this.lifecycleService.willShutdown) this.layoutService.showPart('auxiliarybar');
		});
		this.editorMount = lease;
		this.editorMountParent = parent;
		this.updateSessionsControlVisibility();
		this.layoutService.hidePart('auxiliarybar');
		if (isHTMLElement(focused) && parent.contains(focused)) focused.focus({ preventScroll: true });
		return lease;
	}

	setEditorVisible(parent: HTMLElement, visible: boolean): void {
		if (this.editorMountParent !== parent) return;
		this.editorVisible = visible;
		this.updateSessionsControlVisibility();
		this.activePane?.setVisible(visible || this.popouts.has(this.activePane));
	}

	override focus(): void {
		if (this.activePane) this.popouts.get(this.activePane)?.shell.window.window.focus();
		this.activePane?.focus();
	}


	protected override layoutBody(height: number, width: number): void {
		if (!this.editorMount) {
			this.updateSessionsSidebarLayout(width);
			if (width > 0) {
				this.lastDimensionsPerOrientation.set(this.getSessionsViewerOrientation(), { height, width });
			}
		}
	}

	override getOptimalWidth(): number {
		return this.sessionsSidebarVisible.get() && this.configuration.getValue<string>(ChatConfiguration.ChatViewSessionsOrientation) !== 'stacked'
			? sideBySideSessionsWidth : defaultChatWidth;
	}

	toggleSessionsSidebar(options?: { readonly visible: boolean; }): boolean {
		const visible = options?.visible ?? this.getSessionsViewerOrientation() !== AgentSessionsViewerOrientation.SideBySide;
		this.sessionsSidebarManualVisibility = visible;
		this.setSessionsSidebarVisible(visible);
		this.updateSessionsSidebarLayout(this.chatBodyWidth || this.body.getBoundingClientRect().width);
		return visible;
	}

	public getSessionsViewerOrientation(): AgentSessionsViewerOrientation {
		return this.sessionsSideBySide && this.sessionsSidebarVisible.get()
			? AgentSessionsViewerOrientation.SideBySide : AgentSessionsViewerOrientation.Stacked;
	}

	public getLastDimensions(orientation: AgentSessionsViewerOrientation): { height: number; width: number; } | undefined {
		return this.lastDimensionsPerOrientation.get(orientation);
	}

	addContext(attachment: ChatContextAttachment): void {
		this.ensureConversationForVisibleChat();
		this.activePane?.addContext(attachment);
	}

	captureScreenshot(capture?: ChatImageCapture): Promise<void> {
		this.ensureConversationForVisibleChat();
		return this.activePane?.captureScreenshot(capture) ?? Promise.resolve();
	}

	captureActiveDraft(): Promise<{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void; } | undefined> {
		return this.activePane?.captureDraft() ?? Promise.resolve(undefined);
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
			const shell = resources.add(this.instantiationService.createInstance(SessionAuxiliaryWindow, window, title));
			const placeholder = h(this.paneHost.ownerDocument, 'div', { className: 'ash-sessions-detached-chat' });
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
			window.container.append(pane.element);
			pane.setVisible(true);
			window.layout();
			window.window.focus();
			pane.focus();
		} catch (error) { resources.dispose(); window.dispose(); throw error; }
	}

	startVoiceConversation(): Promise<void> {
		if (!this.activePane) return Promise.reject(new Error(localize('agentsVoice.noChat', 'Open a Chat before starting voice.')));
		return this.activePane.startVoiceConversation();
	}

	appendToDraft(text: string): void {
		this.ensureConversationForVisibleChat();
		if (!this.activePane) throw new Error('Chat has no active composer');
		this.activePane.appendToDraft(text);
	}

	acceptInput(value?: string): Promise<void> {
		this.ensureConversationForVisibleChat();
		return this.activePane?.acceptInput(value) ?? Promise.resolve();
	}

	override get partTitleProjection(): PartTitleProjection {
		return this.editorMount ? {} : { ...this.titleControl.partTitleProjection, hideContainerSelector: true };
	}

	private syncSessions(openPaneId?: string): void {
		const focusedElement = this.element.ownerDocument.activeElement;
		const restoreFocus = isHTMLElement(focusedElement) && this.paneHost.contains(focusedElement);
		this.rekeyMaterializedPanes();
		const activePaneId = this.activePaneId();
		for (const id of [activePaneId, openPaneId]) {
			if (id && !this.openedPaneIds.includes(id)) this.openedPaneIds.push(id);
		}
		const entries: ChatPaneEntry[] = [];
		const retainedPaneIds = new Set<string>();
		for (const untitledSession of this.sessionService.untitledSessions) {
			const paneId = untitledSessionPaneId(untitledSession);
			if (!this.openedPaneIds.includes(paneId)) continue;
			retainedPaneIds.add(paneId);
			let pane = this.panes.get(paneId);
			if (!pane) {
				pane = this.instantiationService.createInstance<ChatWidget<ChatWidgetModel>>(ChatWidget,
					this.paneHost,
					`ash-chat-pane-${++chatPaneInstanceId}`,
					this.instantiationService.createInstance(ChatWidgetModel, this.chatService, { kind: 'untitled', session: untitledSession }, this.sessionService),
					() => { this.sessionService.createUntitledSession(); },
					this.contextMenuService,
					this.contextViewService,
					this.commandService,
					this.accessibleViewService,
					this.notifications,
					this.openerService,
					this.editorService,
					(resource: URI) => readMarkdownImageResource(this.fileService, resource),
					undefined,
				);
				pane.bindDraftStorage({
					read: identity => readNewChatDraftState(this.storage, identity),
					write: (identity, draft) => writeNewChatDraftState(this.storage, draft, identity),
					flush: () => this.storage.flush(),
				}, this.lifecycleService.onWillShutdown);
				setDisposableOwner(pane, this);
				this.panes.set(paneId, pane);
			} else {
				pane.model.selectUntitledSession(untitledSession);
			}
			entries.push({ id: paneId, label: untitledSession.title.trim() || localize('chat.title.new', 'New Chat'), pane });
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
				pane = this.instantiationService.createInstance<ChatWidget<ChatWidgetModel>>(ChatWidget,
					this.paneHost,
					`ash-chat-pane-${++chatPaneInstanceId}`,
					this.instantiationService.createInstance(ChatWidgetModel, this.chatService, { kind: 'session', active: selection }, this.sessionService),
					() => { this.sessionService.createUntitledSession(); },
					this.contextMenuService,
					this.contextViewService,
					this.commandService,
					this.accessibleViewService,
					this.notifications,
					this.openerService,
					this.editorService,
					(resource: URI) => readMarkdownImageResource(this.fileService, resource),
					undefined,
				);
				pane.bindDraftStorage({
					read: identity => readNewChatDraftState(this.storage, identity),
					write: (identity, draft) => writeNewChatDraftState(this.storage, draft, identity),
					flush: () => this.storage.flush(),
				}, this.lifecycleService.onWillShutdown);
				setDisposableOwner(pane, this);
				this.panes.set(paneId, pane);
			} else {
				void pane.model.selectThread(selection);
			}
			const selectedThread = session.chats.find(chat => chat.threadId === selection.threadId);
			const threadTitle = selectedThread?.origin.type !== 'root' ? selectedThread?.title : undefined;
			entries.push({ id: paneId, label: threadTitle?.trim() || session.title.trim() || localize('chat.title.default', 'Chat'), pane });
		}
		for (const [paneId, pane] of this.panes) {
			if (retainedPaneIds.has(paneId)) continue;
			this.panes.delete(paneId);
			this.popouts.get(pane)?.resources.dispose();
			pane.dispose();
		}
		if (!this.restoringViewState) this.openedPaneIds = this.openedPaneIds.filter(id => retainedPaneIds.has(id));
		entries.sort((a, b) => this.openedPaneIds.indexOf(a.id) - this.openedPaneIds.indexOf(b.id));
		const activePane = activePaneId ? this.panes.get(activePaneId) : undefined;
		const orderedNodes = [...entries.map(entry => this.popouts.get(entry.pane)?.placeholder ?? entry.pane.element), this.empty];
		for (let index = 0; index < orderedNodes.length; index += 1) {
			const node = orderedNodes[index]!;
			// Keep retained Chat editors attached while Session details refresh.
			if (this.paneHost.children[index] !== node) this.paneHost.insertBefore(node, this.paneHost.children[index] ?? null);
		}
		this.activePane = activePane;
		for (const entry of entries) {
			const popup = this.popouts.get(entry.pane);
			entry.pane.setVisible(!!popup || entry.pane === this.activePane && (!this.editorMount || this.editorVisible));
			if (popup) { popup.placeholder.hidden = entry.pane !== activePane; popup.shell.setTitle(entry.label); }
		}
		this.empty.hidden = entries.length > 0;
		this.titleControl.update(entries.find(entry => entry.pane === activePane)?.label, activePane ? this.popouts.get(activePane)?.placeholder.id ?? activePane.element.id : undefined);
		this.updateSessionTabs(entries);
		if (restoreFocus && activePane?.element.contains(focusedElement)) focusedElement.focus();
	}

	private selectionForSession(session: ISession): IActiveSessionThread | undefined {
		const active = this.sessionService.activeUntitledSession ? undefined : this.sessionService.active;
		if (
			active?.session.sessionId === session.sessionId &&
			isActiveThread(session, active.threadId)
		) {
			return { session, threadId: active.threadId };
		}
		const retainedThreadId = this.panes.get(sessionPaneId(session))?.threadId ?? this.restoredThreadIds.get(sessionPaneId(session));
		if (retainedThreadId && isActiveThread(session, retainedThreadId)) {
			return { session, threadId: retainedThreadId };
		}
		const thread = rootThread(session) ?? session.chats.find((candidate) => candidate.status === 'active');
		return thread ? { session, threadId: thread.threadId } : undefined;
	}

	private ensureConversationForVisibleChat(): void {
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
					this.popouts.get(pane)?.resources.dispose();
					pane.dispose();
					continue;
				}
			}
			this.panes.delete(paneId);
			this.panes.set(materializedPaneId, pane);
		}
	}

	private setSessionsSidebarVisible(visible: boolean, focus = true): void {
		if (visible && focus) {
			const active = this.body.ownerDocument.activeElement;
			this.focusReturn = this.titleControl.captureFocus() ?? (isHTMLElement(active) ? () => active.focus() : undefined);
		}
		if (visible === this.sessionsSidebarVisible.get()) {
			if (visible && focus) {
				this.sessionsControl.focus();
			}
			return;
		}
		this.sessionsSidebarVisible.set(visible);
		this.body.classList.toggle('sessions-sidebar-visible', visible);
		this.sessionsSidebar.hidden = !visible;
		this.updateSessionsControlVisibility();
		if (!visible) {
			if (this.sessionsSidebar.contains(this.body.ownerDocument.activeElement) || this.sessionsSash.element === this.body.ownerDocument.activeElement) {
				if (this.focusReturn) this.focusReturn();
				else this.focus();
			}
			this.focusReturn = undefined;
		} else if (focus) {
			this.sessionsControl.focus();
		}
		this.layoutSessionsSash();
	}

	private hideSessionsAfterSelection(): void {
		if (this.sessionsSideBySide) return;
		this.sessionsSidebarManualVisibility = undefined;
		this.setSessionsSidebarVisible(false);
	}

	private updateSessionsControlVisibility(): void {
		this.sessionsControl.setVisible(this.sessionsSidebarVisible.get() === true && (this.editorMount ? this.editorVisible : this.isBodyVisible()));
	}

	private updateSessionsSidebarLayout(width: number): void {
		if (width <= 0) return;
		this.chatBodyWidth = width;
		// An explicit open also docks the all-sessions list beside a tabbed conversation.
		this.sessionsSideBySide = (this.sessionsPresentation === AgentSessionsPresentation.List || this.sessionsSidebarManualVisibility === true)
			&& this.configuration.getValue<string>(ChatConfiguration.ChatViewSessionsOrientation) !== 'stacked'
			&& width >= sideBySideSessionsWidth;
		this.body.classList.toggle('sessions-side-by-side', this.sessionsSideBySide);
		// Geometry changes never steal focus or overwrite an explicit open/close choice.
		const visible = this.sessionsSidebarManualVisibility ?? (this.sessionsSideBySide || this.sessionsSidebarVisible.get() === true);
		this.setSessionsSidebarVisible(visible, false);
		this.layoutSessionsSash();
	}

	private get effectiveSessionsSidebarWidth(): number {
		return clamp(this.sessionsSidebarWidth, minimumSessionsSidebarWidth, Math.max(minimumSessionsSidebarWidth, this.chatBodyWidth - defaultChatWidth));
	}

	private layoutSessionsSash(): void {
		const visible = this.sessionsSideBySide && this.sessionsSidebarVisible.get() === true;
		this.sessionsViewerOrientationContext.set(this.getSessionsViewerOrientation());
		const sash = this.sessionsSash;
		if (!visible && sash.element === this.body.ownerDocument.activeElement) this.focus();
		sash.element.hidden = !visible;
		if (!visible) {
			this.sessionsSidebar.style.removeProperty('flex-basis');
			sash.state = SashState.Disabled;
			return;
		}
		// Keep the preferred width when the host temporarily constrains the two columns.
		const width = this.effectiveSessionsSidebarWidth;
		this.sessionsSidebar.style.flexBasis = `${width}px`;
		const chatWidth = this.chatBodyWidth - width;
		sash.state = chatWidth <= defaultChatWidth ? SashState.AtMinimum : width <= minimumSessionsSidebarWidth ? SashState.AtMaximum : SashState.Enabled;
		sash.element.setAttribute('aria-valuemin', String(minimumSessionsSidebarWidth));
		sash.element.setAttribute('aria-valuemax', String(this.chatBodyWidth - defaultChatWidth));
		sash.element.setAttribute('aria-valuenow', String(width));
		sash.layout();
	}

	private updateSessionTabs(entries: readonly ChatPaneEntry[]): void {
		const tabs = this.sessionsPresentation === AgentSessionsPresentation.Tabs;
		this.titleControl.setTabs(entries.map(entry => ({
			id: entry.pane.element.id,
			value: entry.id,
			label: entry.label,
			tabId: `${entry.pane.element.id}-tab`,
			panelId: this.popouts.get(entry.pane)?.placeholder.id ?? entry.pane.element.id,
			closeActionTooltip: localize('chat.sessions.closeTab', 'Close session tab'),
		})), this.activePane?.element.id, tabs ? this.tabsOptions : undefined);
		for (const entry of entries) {
			entry.pane.element.setAttribute('role', tabs ? 'tabpanel' : 'region');
			entry.pane.setTabId(this.popouts.get(entry.pane)?.shell.title.id
				?? (tabs ? `${entry.pane.element.id}-tab` : entry.pane === this.activePane ? this.titleControl.titleId : undefined));
		}
	}

	private updateSessionsLayout(): void {
		const presentation = this.configuration.getValue<AgentSessionsPresentation>(AGENT_SESSIONS_PRESENTATION_SETTING);
		const changed = presentation !== this.sessionsPresentation;
		this.sessionsPresentation = presentation;
		this.sessionsPresentationContext.set(presentation);
		if (changed) {
			this.sessionsSidebarManualVisibility = undefined;
			this.setSessionsSidebarVisible(false);
			this.syncSessions();
		}
		this.updateSessionsSidebarLayout(this.chatBodyWidth || this.body.getBoundingClientRect().width);
	}

	private activatePane(id: string): void {
		const pane = this.panes.get(id);
		if (!pane) return;
		if (pane.model.untitledSessionId) this.sessionService.selectUntitledSession(pane.model.untitledSessionId);
		else if (pane.sessionId && pane.threadId) this.sessionService.selectThread(pane.sessionId, pane.threadId);
	}

	private async closePane(id: string): Promise<void> {
		const pane = this.panes.get(id);
		if (!pane || this.closingPanes.has(id)) return;
		this.closingPanes.add(id);
		try {
			await pane.captureDraft();
			if (this.viewDisposed || this.panes.get(id) !== pane) return;
			const index = this.openedPaneIds.indexOf(id);
			this.openedPaneIds = this.openedPaneIds.filter(candidate => candidate !== id);
			if (this.activePane === pane) {
				const next = this.openedPaneIds[Math.min(index, this.openedPaneIds.length - 1)];
				if (next) this.activatePane(next);
				else this.sessionService.createUntitledSession();
			}
			this.syncSessions();
			this.saveViewState();
		} finally {
			this.closingPanes.delete(id);
		}
	}

}

function isActiveThread(session: ISession, threadId: ThreadId): boolean {
	return session.chats.some((thread) => thread.threadId === threadId && thread.status === 'active');
}

function rootThread(session: ISession): IChat | undefined {
	return session.chats.find((thread) => thread.status === 'active' && thread.origin.type === 'root');
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
