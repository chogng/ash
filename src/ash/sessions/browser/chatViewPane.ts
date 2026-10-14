import "./media/chatViewPane.css";
import { setDisposableOwner, toDisposable } from "../../base/common/lifecycle.js";
import { IMenuService } from "../../platform/actions/common/actions.js";
import { IAccessibleViewService } from '../../platform/accessibility/browser/accessibleView.js';
import { IContextMenuService, IContextViewService } from "../../platform/contextview/browser/contextView.js";
import { ICommandService } from "../../platform/commands/common/commands.js";
import { ViewPane, type IViewPaneOptions, type PartTitleProjection } from "../../workbench/browser/parts/views/viewPane.js";
import { IWorkbenchLayoutService } from "../../workbench/services/layout/browser/layoutService.js";
import { IChatService } from "../../workbench/services/chat/common/chatService.js";
import type { IActiveSessionThread, IChat, ISession, IUntitledChatSession, ThreadId } from "../services/sessions/common/session.js";
import { ISessionsManagementService } from "../services/sessions/common/sessionsManagement.js";
import { ChatWidget, resolveMarkdownWorkspaceResource } from "../../workbench/contrib/chat/browser/widget/chatWidget.js";
import { ChatViewTitleControl } from "../../workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewTitleControl.js";
import { addDisposableListener, h, isHTMLElement } from "../../base/browser/dom.js";
import { type ChatContextAttachment, type IChatContextTarget } from "../../workbench/services/chat/common/chatContextService.js";
import { IOpenerService } from "../../platform/opener/common/opener.js";
import { IEditorService } from "../../workbench/services/editor/common/editorService.js";
import { IFileService } from '../../platform/files/common/files.js';
import { URI } from '../../base/common/uri.js';
import { type IContextKey } from "../../platform/contextkey/common/contextkey.js";
import { ContextKeyService, IContextKeyService } from "../../platform/contextkey/browser/contextKeyService.js";
import { SHOW_CHAT_HISTORY_COMMAND_ID, AGENT_SESSIONS_ORIENTATION_SETTING, AgentSessionsOrientation, AgentSessionsOrientationContext, AgentSessionsSidebarVisibleContext } from '../../workbench/contrib/chat/common/chat.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { AgentSessionsControl } from '../../workbench/contrib/chat/browser/agentSessions/agentSessionsControl.js';
import { registerAgentSessionsAccessibility } from '../../workbench/contrib/chat/browser/agentSessions/agentSessionsAccessibility.js';
import { createAgentSessionsModel } from './agentSessionsModel.js';
import { localize } from '../../nls.js';
import { ChatWidgetModel } from './chatWidgetModel.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import type { IOpenAgentsWindowOptions } from '../../platform/native/common/nativeHost.js';
import { Sash, SashState } from '../../base/browser/ui/sash/sash.js';
import { IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { FileRevisionConflictError, FileSystemProviderErrorCode, toFileSystemProviderErrorCode } from '../../platform/files/common/files.js';
import { IUserDataProfileService } from '../../workbench/services/userDataProfile/common/userDataProfile.js';
import { editJsonObjectProperty, parseJsonDocument } from '../../base/common/json.js';

let chatViewInstanceId = 0;
let chatPaneInstanceId = 0;
const sessionsSidebarWidthKey = 'chat.sessionsSidebarWidth';
const defaultSessionsSidebarWidth = 320;
const minimumSessionsSidebarWidth = 220;
const minimumChatWidth = 300;
const minimumSideBySideWidth = minimumChatWidth + minimumSessionsSidebarWidth;

interface ChatPaneEntry {
	readonly label: string;
	readonly pane: ChatWidget<ChatWidgetModel>;
}

/**
 * Retains conversations behind one title and history switcher.
 *
 * Each untitled or active durable Session owns one retained ChatWidget. Thread
 * selection remains internal to durable panes, while untitled sessions
 * materialize only when their first message is sent.
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
	private sessionsSidebarWidth: number;
	private auxiliaryBarWidthBeforeSessions: number | undefined;
	private readonly sessionsSidebarVisible: IContextKey<boolean>;
	private readonly sessionsOrientation: IContextKey<AgentSessionsOrientation>;
	private sessionsPresentation = AgentSessionsOrientation.SideBySide;
	private readonly empty: HTMLDivElement;
	private readonly panes = new Map<string, ChatWidget<ChatWidgetModel>>();
	private activePane: ChatWidget<ChatWidgetModel> | undefined;
	private initialUntitledSessionId: string | undefined;
	private viewDisposed = false;
	private focusReturn: (() => void) | undefined;

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
		@IUserDataProfileService private readonly userProfile: IUserDataProfileService,
		@IContextKeyService contextKeyService?: IContextKeyService,
		@IOpenerService private readonly openerService?: IOpenerService,
		@IEditorService private readonly editorService?: IEditorService,
	) {
		super(container, options);
		this.chatService = chatService;
		this.sessionService = sessionService;
		this.contextMenuService = contextMenuService;
		this.commandService = commandService;
		this.element.classList.add("ash-chat-view-pane");
		this.headerElement.hidden = true;
		this.contentElement.classList.add("ash-chat-view");
		const viewId = `ash-chat-view-${++chatViewInstanceId}`;
		this.titleControl = this._register(this.instantiationService.createInstance(ChatViewTitleControl,
			this.element,
			viewId,
			() => this.commandService.executeCommand(SHOW_CHAT_HISTORY_COMMAND_ID),
		));
		this.paneHost = h(container.ownerDocument, "div");
		this.paneHost.className = "ash-chat-pane-host";
		this.empty = h(container.ownerDocument, "div");
		this.empty.className = "ash-chat-empty ash-chat-view-empty";
		this.empty.textContent = "Start a new chat to begin.";
		this.body = h(container.ownerDocument, "div");
		this.body.className = "ash-chat-body";
		const sidebarContextKeys = contextKeyService ?? this._register(new ContextKeyService());
		this.sessionsSidebarVisible = AgentSessionsSidebarVisibleContext.bindTo(sidebarContextKeys);
		this.sessionsOrientation = AgentSessionsOrientationContext.bindTo(sidebarContextKeys);
		this._register(toDisposable(() => this.sessionsSidebarVisible.reset()));
		this._register(toDisposable(() => this.sessionsOrientation.reset()));
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
		this._register(addDisposableListener(newSessionButton, 'click', () => {
			this.sessionService.createUntitledSession();
			if (this.sessionsPresentation === 'stacked') this.setSessionsSidebarVisible(false);
			this.activePane?.focus();
		}));
		this.sessionsControl = this._register(new AgentSessionsControl(this.sessionsSidebar, createAgentSessionsModel(sessionService, () => {
			if (this.sessionsPresentation !== 'sideBySide') this.setSessionsSidebarVisible(false);
			this.activePane?.focus();
		})));
		this.sessionsSidebar.hidden = true;
		const storedWidth = storage.getNumber(sessionsSidebarWidthKey, StorageScope.WORKSPACE);
		this.sessionsSidebarWidth = storedWidth !== undefined && storedWidth >= minimumSessionsSidebarWidth ? storedWidth : defaultSessionsSidebarWidth;
		this.sessionsSash = this._register(new Sash(this.body, 'vertical'));
		this.sessionsSash.element.classList.add('ash-chat-sessions-sash');
		this.sessionsSash.element.setAttribute('aria-label', localize('chat.sessions.resize', 'Resize Sessions list'));
		this.sessionsSash.element.setAttribute('aria-controls', this.sessionsSidebar.id);
		let resizeStartWidth: number | undefined;
		this._register(this.sessionsSash.onDidStart(() => {
			resizeStartWidth = this.getSessionsSidebarWidth(this.body.getBoundingClientRect().width);
		}));
		this._register(this.sessionsSash.onDidChange(event => {
			if (resizeStartWidth === undefined || this.sessionsSash.element.hidden) {
				return;
			}
			const width = this.body.getBoundingClientRect().width;
			this.sessionsSidebarWidth = this.getSessionsSidebarWidth(width, resizeStartWidth - event.delta);
			this.layoutSessionsSidebar(width);
		}));
		this._register(this.sessionsSash.onDidEnd(() => {
			if (resizeStartWidth === undefined) {
				return;
			}
			resizeStartWidth = undefined;
			this.storage.store(sessionsSidebarWidthKey, this.sessionsSidebarWidth, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}));
		this._register(this.sessionsSash.onDidReset(() => {
			this.sessionsSidebarWidth = defaultSessionsSidebarWidth;
			this.storage.remove(sessionsSidebarWidthKey, StorageScope.WORKSPACE);
			this.layoutSessionsSidebar(this.body.getBoundingClientRect().width);
		}));
		this.contentElement.append(this.body);
		this._register(addDisposableListener(this.body, 'keydown', event => {
			if (event.key !== 'Escape' || !this.sessionsSidebarVisible.get()) return;
			event.preventDefault();
			this.setSessionsSidebarVisible(false);
		}));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AGENT_SESSIONS_ORIENTATION_SETTING)) this.updateSessionsLayout();
		}));
		const ResizeObserver = container.ownerDocument.defaultView?.ResizeObserver;
		if (ResizeObserver) {
			const observer = new ResizeObserver(() => this.layoutSessionsSidebar(this.body.getBoundingClientRect().width));
			observer.observe(this.body);
			this._register(toDisposable(() => observer.disconnect()));
		}
		this._register(sessionService.onDidChange(() => this.syncSessions()));
		this._register(layoutService.onDidChangePartVisibility((event) => {
			if (event.partId === "auxiliarybar" && event.visible) this.ensureConversationForVisibleChat();
		}));
		this._register(toDisposable(() => {
			this.viewDisposed = true;
			for (const pane of this.panes.values()) pane.dispose();
			this.panes.clear();
		}));
		this.syncSessions();
		this.updateSessionsLayout();
		void this.migrateSessionsOrientation();
		this.ensureConversationForVisibleChat();
		void sessionService.initialize().then(() => {
			if (this.viewDisposed) return;
			this.discardInitialUntitledSessionWhenDurableChatExists();
			this.ensureConversationForVisibleChat();
		});
	}

	override focus(): void {
		this.activePane?.focus();
	}

	override get minimumWidth(): number {
		return this.sessionsSidebarVisible.get() === true && this.sessionsPresentation === AgentSessionsOrientation.SideBySide
			? minimumSideBySideWidth
			: minimumChatWidth;
	}

	toggleSessionsSidebar(): void {
		this.setSessionsSidebarVisible(!this.sessionsSidebarVisible.get());
	}

	addContext(attachment: ChatContextAttachment): void {
		this.ensureConversationForVisibleChat();
		this.activePane?.addContext(attachment);
	}

	captureActiveDraft(): Promise<{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void; } | undefined> {
		return this.activePane?.captureDraft() ?? Promise.resolve(undefined);
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
		return this.titleControl.partTitleProjection;
	}

	private syncSessions(): void {
		const focusedElement = this.element.ownerDocument.activeElement;
		const restoreFocus = isHTMLElement(focusedElement) && this.paneHost.contains(focusedElement);
		this.rekeyMaterializedPanes();
		const entries: ChatPaneEntry[] = [];
		const retainedPaneIds = new Set<string>();
		for (const untitledSession of this.sessionService.untitledSessions) {
			const paneId = untitledSessionPaneId(untitledSession);
			retainedPaneIds.add(paneId);
			let pane = this.panes.get(paneId);
			if (!pane) {
				pane = this.instantiationService.createInstance<ChatWidget<ChatWidgetModel>>(ChatWidget,
					this.paneHost,
					`ash-chat-pane-${++chatPaneInstanceId}`,
					this.instantiationService.createInstance(ChatWidgetModel, this.chatService, { kind: "untitled", session: untitledSession }, this.sessionService),
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
				setDisposableOwner(pane, this);
				this.panes.set(paneId, pane);
			} else {
				pane.model.selectUntitledSession(untitledSession);
			}
			entries.push({ label: untitledSession.title.trim() || localize('chat.title.new', 'New Chat'), pane });
		}
		for (const session of this.sessionService.sessions) {
			if (session.status !== "active") continue;
			const selection = this.selectionForSession(session);
			if (!selection) continue;
			const paneId = sessionPaneId(session);
			retainedPaneIds.add(paneId);
			let pane = this.panes.get(paneId);
			if (!pane) {
				pane = this.instantiationService.createInstance<ChatWidget<ChatWidgetModel>>(ChatWidget,
					this.paneHost,
					`ash-chat-pane-${++chatPaneInstanceId}`,
					this.instantiationService.createInstance(ChatWidgetModel, this.chatService, { kind: "session", active: selection }, this.sessionService),
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
				setDisposableOwner(pane, this);
				this.panes.set(paneId, pane);
			} else {
				void pane.model.selectThread(selection);
			}
			entries.push({ label: session.title.trim() || localize('chat.title.default', 'Chat'), pane });
		}
		for (const [paneId, pane] of this.panes) {
			if (retainedPaneIds.has(paneId)) continue;
			this.panes.delete(paneId);
			pane.dispose();
		}
		const activePaneId = this.activePaneId();
		const activePane = activePaneId ? this.panes.get(activePaneId) : undefined;
		const orderedNodes = [...entries.map((entry) => entry.pane.element), this.empty];
		for (let index = 0; index < orderedNodes.length; index += 1) {
			const node = orderedNodes[index]!;
			// Keep retained Chat editors attached while Session details refresh.
			if (this.paneHost.children[index] !== node) this.paneHost.insertBefore(node, this.paneHost.children[index] ?? null);
		}
		this.activePane = activePane;
		for (const entry of entries) entry.pane.setVisible(entry.pane === this.activePane);
		this.empty.hidden = entries.length > 0;
		this.titleControl.update(entries.find(entry => entry.pane === activePane)?.label, activePane?.element.id);
		for (const entry of entries) {
			entry.pane.element.setAttribute('role', 'region');
			entry.pane.setTabId(entry.pane === activePane ? this.titleControl.titleId : undefined);
		}
		this.updateSessionsLayout();
		if (restoreFocus && activePane?.element.contains(focusedElement)) focusedElement.focus();
	}

	private selectionForSession(session: ISession): IActiveSessionThread | undefined {
		const active = this.sessionService.active;
		if (
			active?.session.sessionId === session.sessionId &&
			isActiveThread(session, active.threadId)
		) {
			return { session, threadId: active.threadId };
		}
		const retainedThreadId = this.panes.get(sessionPaneId(session))?.threadId;
		if (retainedThreadId && isActiveThread(session, retainedThreadId)) {
			return { session, threadId: retainedThreadId };
		}
		const thread = rootThread(session) ?? session.chats.find((candidate) => candidate.status === "active");
		return thread ? { session, threadId: thread.threadId } : undefined;
	}

	private ensureConversationForVisibleChat(): void {
		if (!this.layoutService.isPartVisible("auxiliarybar") || this.panes.size > 0) return;
		const session = this.sessionService.createUntitledSession();
		if (this.sessionService.state === "loading" && this.initialUntitledSessionId === undefined) {
			this.initialUntitledSessionId = session.untitledSessionId;
		}
	}

	private discardInitialUntitledSessionWhenDurableChatExists(): void {
		const untitledSessionId = this.initialUntitledSessionId;
		this.initialUntitledSessionId = undefined;
		if (!untitledSessionId || !this.panes.has(`untitled:${untitledSessionId}`)) return;
		if ([...this.panes.keys()].some((paneId) => paneId.startsWith("session:"))) {
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
			const sessionId = pane.sessionId;
			if (!sessionId) continue;
			const materializedPaneId = sessionPaneIdFromId(sessionId);
			if (paneId === materializedPaneId) continue;
			const existing = this.panes.get(materializedPaneId);
			if (existing && existing !== pane) {
				const origin = pane.model.materializingUntitledSessionId;
				const active = this.sessionService.active;
				// Keep the first submission's editor and lifetime when the catalog arrived
				// before its create response. A deliberately selected durable draft wins.
				if (origin && paneId === `untitled:${origin}` && pane === this.activePane && active?.session.sessionId === sessionId && active.threadId === pane.threadId) {
					existing.dispose();
				} else {
					pane.dispose();
					this.panes.delete(paneId);
					continue;
				}
			}
			this.panes.delete(paneId);
			this.panes.set(materializedPaneId, pane);
		}
	}

	private setSessionsSidebarVisible(visible: boolean): void {
		if (visible === this.sessionsSidebarVisible.get()) return;
		const previousMinimum = this.minimumWidth;
		const width = this.body.getBoundingClientRect().width;
		const size = (visible && width > 0 && this.sessionsPresentation === AgentSessionsOrientation.SideBySide) || (!visible && this.auxiliaryBarWidthBeforeSessions !== undefined)
			? this.layoutService.getPartSize('auxiliarybar')
			: undefined;
		if (visible) {
			const active = this.contentElement.ownerDocument.activeElement;
			const HTMLElement = this.contentElement.ownerDocument.defaultView?.HTMLElement;
			this.focusReturn = this.titleControl.captureFocus() ?? (HTMLElement && active instanceof HTMLElement ? () => active.focus() : undefined);
		}
		this.sessionsSidebarVisible.set(visible);
		this.body.classList.toggle('sessions-sidebar-visible', visible);
		this.sessionsSidebar.hidden = !visible;
		if (visible && size && this.sessionsPresentation === AgentSessionsOrientation.SideBySide) {
			this.auxiliaryBarWidthBeforeSessions = size.width;
		}
		if (this.minimumWidth !== previousMinimum) this.notifyConstraintsChanged();
		if (visible && size && this.sessionsPresentation === AgentSessionsOrientation.SideBySide) {
			// Reserve list space in the owning Grid, including the Part's frame insets.
			// The content minimum propagates to the Part before Grid resizes its node.
			const bodyWidth = Math.max(minimumSideBySideWidth, width + this.sessionsSidebarWidth);
			this.layoutService.resizePart('auxiliarybar', { width: size.width + bodyWidth - width, height: size.height });
		} else if (!visible && size && this.auxiliaryBarWidthBeforeSessions !== undefined) {
			const previousWidth = this.auxiliaryBarWidthBeforeSessions;
			this.auxiliaryBarWidthBeforeSessions = undefined;
			this.layoutService.resizePart('auxiliarybar', { width: previousWidth, height: size.height });
		}
		this.layoutSessionsSidebar(this.body.getBoundingClientRect().width);
		if (visible) this.sessionsControl.focus();
		else {
			this.focusReturn?.();
			this.focusReturn = undefined;
		}
	}

	private updateSessionsLayout(): void {
		const previousMinimum = this.minimumWidth;
		const orientation = this.configuration.getValue<AgentSessionsOrientation>(AGENT_SESSIONS_ORIENTATION_SETTING);
		if (this.sessionsSidebarVisible.get() && orientation === AgentSessionsOrientation.SideBySide && this.sessionsPresentation !== orientation && this.body.getBoundingClientRect().width > 0) {
			this.auxiliaryBarWidthBeforeSessions = this.layoutService.getPartSize('auxiliarybar').width;
		}
		this.sessionsPresentation = orientation;
		this.sessionsOrientation.set(this.sessionsPresentation);
		this.body.classList.toggle('sessions-stacked', this.sessionsPresentation === 'stacked');
		if (this.minimumWidth !== previousMinimum) this.notifyConstraintsChanged();
		if (orientation === AgentSessionsOrientation.Stacked && this.auxiliaryBarWidthBeforeSessions !== undefined) {
			const size = this.layoutService.getPartSize('auxiliarybar');
			const previousWidth = this.auxiliaryBarWidthBeforeSessions;
			this.auxiliaryBarWidthBeforeSessions = undefined;
			this.layoutService.resizePart('auxiliarybar', { width: previousWidth, height: size.height });
		}
		const sashHadFocus = this.sessionsSash.element === this.body.ownerDocument.activeElement;
		this.layoutSessionsSidebar(this.body.getBoundingClientRect().width);
		if (sashHadFocus && this.sessionsSash.element.hidden && this.sessionsSidebarVisible.get()) {
			this.sessionsControl.focus();
		}
	}

	private async migrateSessionsOrientation(): Promise<void> {
		try {
			const resource = this.userProfile.currentProfile.settingsResource;
			const snapshot = await this.fileService.readFile(resource);
			if (this.viewDisposed) return;
			const value = parseJsonDocument(snapshot.content, { allowComments: true, allowTrailingComma: true }).value;
			if (!value || typeof value !== 'object' || !(AGENT_SESSIONS_ORIENTATION_SETTING in value) || value[AGENT_SESSIONS_ORIENTATION_SETTING] !== 'auto') return;
			// The revision check preserves a layout the user chose while the old profile was loading.
			await this.fileService.writeFile({ resource, content: editJsonObjectProperty(snapshot.content, AGENT_SESSIONS_ORIENTATION_SETTING, AgentSessionsOrientation.SideBySide), expectedRevision: snapshot.revision });
		} catch (error) {
			if (this.viewDisposed || error instanceof FileRevisionConflictError || toFileSystemProviderErrorCode(error as Error) === FileSystemProviderErrorCode.FileNotFound) return;
			this.notifications.error(localize('chat.sessions.layout.migrationFailed', 'Could not save the Sessions layout preference: {0}', String(error)));
		}
	}

	private getSessionsSidebarWidth(width: number, requestedWidth = this.sessionsSidebarWidth): number {
		return Math.max(minimumSessionsSidebarWidth, Math.min(requestedWidth, width - minimumChatWidth));
	}

	private layoutSessionsSidebar(width: number): void {
		const visible = this.sessionsSidebarVisible.get() === true && this.sessionsPresentation === 'sideBySide';
		this.sessionsSash.element.hidden = !visible;
		if (!visible) {
			this.sessionsSidebar.style.removeProperty('flex-basis');
			this.sessionsSash.state = SashState.Disabled;
			return;
		}
		// Window constraints change the effective width without overwriting the user's preferred width.
		const sidebarWidth = this.getSessionsSidebarWidth(width);
		const maximumWidth = width - minimumChatWidth;
		this.sessionsSidebar.style.flexBasis = `${sidebarWidth}px`;
		this.sessionsSash.element.style.left = `${width - sidebarWidth}px`;
		if (sidebarWidth >= maximumWidth) {
			this.sessionsSash.state = SashState.AtMinimum;
		} else if (sidebarWidth <= minimumSessionsSidebarWidth) {
			this.sessionsSash.state = SashState.AtMaximum;
		} else {
			this.sessionsSash.state = SashState.Enabled;
		}
		this.sessionsSash.element.setAttribute('aria-valuemin', String(minimumSessionsSidebarWidth));
		this.sessionsSash.element.setAttribute('aria-valuemax', String(maximumWidth));
		this.sessionsSash.element.setAttribute('aria-valuenow', String(sidebarWidth));
		this.sessionsSash.element.setAttribute('aria-valuetext', localize('chat.sessions.resizeWidth', '{0} pixels', Math.round(sidebarWidth)));
	}

}

function isActiveThread(session: ISession, threadId: ThreadId): boolean {
	return session.chats.some((thread) => thread.threadId === threadId && thread.status === "active");
}

function rootThread(session: ISession): IChat | undefined {
	return session.chats.find((thread) => thread.status === "active" && thread.origin.type === "root");
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
