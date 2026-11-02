import './media/chatViewPane.css';
import { addDisposableListener, h, isHTMLElement } from '../../../../../../base/browser/dom.js';
import { observeElementSize } from '../../../../../../base/browser/observer.js';
import { Orientation, Sash, SashState } from '../../../../../../base/browser/ui/sash/sash.js';
import { toDisposable, type IDisposable } from '../../../../../../base/common/lifecycle.js';
import { clamp } from '../../../../../../base/common/numbers.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import type { IContextKey } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { ViewPane, type IViewPaneOptions, type PartTitleProjection } from '../../../../../browser/parts/views/viewPane.js';
import { IWorkbenchLayoutService } from '../../../../../services/layout/browser/layoutService.js';
import { ILifecycleService } from '../../../../../services/lifecycle/common/lifecycle.js';
import type { IChatViewPane, IQuickChatSession, IChatWidgetViewOptions } from '../../chat.js';
import type { ChatWidget, IChatWidgetModel } from '../../widget/chatWidget.js';
import { AgentSessionsControl, type IAgentSessionsControlOptions } from '../../agentSessions/agentSessionsControl.js';
import { AgentSessionsViewerOrientation } from '../../agentSessions/agentSessions.js';
import {
	SHOW_CHAT_HISTORY_COMMAND_ID,
	AGENT_SESSIONS_PRESENTATION_SETTING,
	AgentSessionsPresentation,
	AgentSessionsPresentationContext,
	AgentSessionsSidebarVisibleContext,
	OPEN_CHAT_SETTINGS_COMMAND_ID,
} from '../../../common/chat.js';
import { ChatConfiguration } from '../../../common/constants.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import type { ChatContextAttachment, ChatImageCapture, IChatContextTarget } from '../../../../../services/chat/common/chatContextService.js';
import type { IOpenAgentsWindowOptions } from '../../../../../../platform/native/common/nativeHost.js';
import type { TabListOptions } from '../../../../../../base/browser/ui/tablist/tabList.js';
import { onUnexpectedError } from '../../../../../../base/common/errors.js';
import { Separator, type IAction } from '../../../../../../base/common/actions.js';
import { ChatEditorInput } from '../editor/chatEditorInput.js';
import { ChatViewTitleControl } from './chatViewTitleControl.js';
import { LocalSelectionTransfer } from '../../../../../../platform/dnd/browser/dnd.js';
import { DraggedEditorIdentifier } from '../../../../../browser/parts/editor/editorTabDragAndDrop.js';
import { IEditorGroupsService } from '../../../../../services/editor/common/editorGroupsService.js';
import type { URI } from '../../../../../../base/common/uri.js';

let chatViewInstanceId = 0;
// The Part owns the hard minimum; side-by-side layout reserves room for both columns.
const defaultChatWidth = 300;
const defaultSessionsSidebarWidth = 300;
const sideBySideSessionsWidth = defaultChatWidth + defaultSessionsSidebarWidth;

/** One retained conversation projected into the host; its model belongs to the product adapter. */
export interface IChatViewPaneEntry<TModel extends IChatWidgetModel> {
	readonly id: string;
	readonly label: string;
	readonly pane: ChatWidget<TModel>;
	/** Captures product actions for this conversation when its tab menu opens. */
	readonly getActions?: () => readonly IAction[];
	/** Borrowed mount and accessible title of a product-owned auxiliary window. */
	readonly detached?: { readonly placeholder: HTMLElement; readonly titleId: string; readonly visible?: boolean; };
}

/**
 * Owns the Workbench Chat frame, session-list layout and editor mount.
 * Product adapters retain conversation selection, models and draft persistence.
 */
export abstract class ChatViewPane<TModel extends IChatWidgetModel = IChatWidgetModel> extends ViewPane implements IChatViewPane, IChatContextTarget {
	protected static readonly SESSIONS_SIDEBAR_MIN_WIDTH = 200;
	protected activePane: ChatWidget<TModel> | undefined;
	private readonly titleControl: ChatViewTitleControl;
	protected readonly paneHost: HTMLDivElement;
	private readonly body: HTMLDivElement;
	private readonly sessionsSidebar: HTMLElement;
	private sessionsControl!: AgentSessionsControl;
	private readonly sessionsSash: Sash;
	protected sessionsSidebarWidth = defaultSessionsSidebarWidth;
	private changingSessionsOrientation = false;
	private readonly sessionsSidebarVisible: IContextKey<boolean>;
	private readonly sessionsViewerOrientationContext: IContextKey<number | undefined>;
	private readonly lastDimensionsPerOrientation = new Map<AgentSessionsViewerOrientation, { height: number; width: number; }>();
	private readonly sessionsPresentationContext: IContextKey<AgentSessionsPresentation>;
	private sessionsPresentation = AgentSessionsPresentation.Tabs;
	protected sessionsSideBySide = false;
	private sessionsSidebarManualVisibility: boolean | undefined;
	private chatBodyWidth = 0;
	protected editorMount: IDisposable | undefined;
	private editorMountParent: HTMLElement | undefined;
	private editorVisible = true;
	private readonly inEditor: IContextKey<boolean>;
	private focusReturn: (() => void) | undefined;

	protected openedPaneIds: string[] = [];
	private readonly tabsOptions: TabListOptions<string>;
	private draggedPaneId: string | undefined;
	private readonly closingPanes = new Set<string>();
	private readonly empty: HTMLDivElement;
	private renderedPanes: readonly IChatViewPaneEntry<TModel>[] = [];
	private sidebarPane: ChatWidget<TModel> | undefined;
	private readonly editorTransfer = LocalSelectionTransfer.getInstance<DraggedEditorIdentifier>();
	private readonly sessionEditors = new Map<ChatWidget<TModel>, { readonly input: ChatEditorInput; visible: boolean; readonly lease: IDisposable; }>();
	private onNewSession!: () => void;

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@ICommandService protected readonly commandService: ICommandService,
		@IWorkbenchLayoutService protected readonly layoutService: IWorkbenchLayoutService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IConfigurationService protected readonly configuration: IConfigurationService,
		@INotificationService protected readonly notifications: INotificationService,
		@ILifecycleService protected readonly lifecycleService: ILifecycleService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IEditorGroupsService private readonly editorGroups: IEditorGroupsService,
		@IEditorService protected readonly editorService?: IEditorService,
	) {
		super(container, options);
		this.tabsOptions = {
			ariaLabel: localize('chat.sessions.tabs', 'Opened sessions'),
			onActivate: id => this.activatePane(id),
			onClose: id => { void this.closePane(id).catch(onUnexpectedError); },
			draggable: true,
			dragAndDrop: {
				canDrop: () => this.sessionsPresentation === AgentSessionsPresentation.Tabs && (this.draggedPaneId !== undefined || this.getDraggedSession() !== undefined),
				onDragStart: (id, event) => {
					if (this.sessionsPresentation !== AgentSessionsPresentation.Tabs) return;
					this.draggedPaneId = id;
					event.dataTransfer?.setData('text/plain', id);
					if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
					const entry = this.renderedPanes.find(entry => entry.id === id);
					if (entry && !entry.detached && !this.editorMount) {
						this.editorTransfer.setData([new DraggedEditorIdentifier(undefined, new ChatEditorInput(id, entry.label))], DraggedEditorIdentifier.prototype);
					}
				},
				onDrop: (target, position) => {
					const dragged = this.getDraggedSession();
					if (dragged && dragged.input instanceof ChatEditorInput) {
						this.editorTransfer.clearData(DraggedEditorIdentifier.prototype);
						void this.moveSessionToSideBar(dragged.input.resource, target, position).catch(onUnexpectedError);
						return;
					}
					const source = this.draggedPaneId;
					if (!source || source === target) {
						return;
					}
					const ids = this.openedPaneIds.filter(id => id !== source);
					const index = target ? ids.indexOf(target) : ids.length;
					if (index < 0) {
						return;
					}
					ids.splice(index + (target && position === 'after' ? 1 : 0), 0, source);
					this.openedPaneIds = ids;
					this.syncSessions();
					this.saveViewState();
				},
				onDragEnd: () => {
					this.draggedPaneId = undefined;
					this.editorTransfer.clearData(DraggedEditorIdentifier.prototype);
				},
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
		this.empty.textContent = localize('chat.view.empty', 'Start a new chat to begin.');
		this.body = h(container.ownerDocument, 'div');
		this.body.className = 'ash-chat-body';
		this.inEditor = contextKeyService.createKey('chatInEditor', false);
		this._register(toDisposable(() => this.inEditor.reset()));
		this.sessionsSidebarVisible = AgentSessionsSidebarVisibleContext.bindTo(contextKeyService);
		this.sessionsViewerOrientationContext = ChatContextKeys.agentSessionsViewerOrientation.bindTo(contextKeyService);
		this._register(toDisposable(() => this.sessionsViewerOrientationContext.reset()));
		this.sessionsPresentationContext = AgentSessionsPresentationContext.bindTo(contextKeyService);
		this._register(toDisposable(() => this.sessionsSidebarVisible.reset()));
		this._register(toDisposable(() => this.sessionsPresentationContext.reset()));
		this.sessionsSidebar = h(container.ownerDocument, 'aside');
		this.sessionsSidebar.className = 'ash-chat-sessions-sidebar';
		this.sessionsSidebar.hidden = true;
		this.sessionsSidebar.id = `${viewId}-sessions`;
		this.sessionsSidebar.setAttribute('aria-label', localize('chat.sessions.sidebar', 'Agent sessions'));
		this.body.append(this.sessionsSidebar, this.paneHost);
		this._register(toDisposable(() => this.sessionsSidebar.remove()));
		this._register(contextKeyService.createScoped(this.sessionsSidebar)).createKey('agentSessionsSidebarFocused', true);
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
			if (this.changingSessionsOrientation || !this.sessionsSideBySide) {
				return;
			}
			const width = resizeStartWidth - (event.currentX - event.startX);
			if (event.input === 'pointer' && width < (ChatViewPane.SESSIONS_SIDEBAR_MIN_WIDTH / 2)) {
				this.changingSessionsOrientation = true;
				void this.configuration.updateValue(ChatConfiguration.ChatViewSessionsOrientation, 'stacked', ConfigurationTarget.USER_LOCAL)
					.catch(error => this.notifications.error(localize('chat.sessions.orientation.saveFailed', 'Could not save the session list layout: {0}', String(error))))
					.finally(() => { this.changingSessionsOrientation = false; });
				return;
			}
			this.sessionsSidebarWidth = clamp(width, ChatViewPane.SESSIONS_SIDEBAR_MIN_WIDTH, this.chatBodyWidth - defaultChatWidth);
			this.layoutSessionsSash();
		}));
		this._register(this.sessionsSash.onDidEnd(() => this.saveViewState()));
		this._register(this.sessionsSash.onDidReset(() => {
			this.sessionsSidebarWidth = defaultSessionsSidebarWidth;
			this.layoutSessionsSash();
			this.saveViewState();
		}));
		this.contentElement.append(this.body);
		this._register(addDisposableListener(this.paneHost, 'focusin', event => {
			const entry = this.renderedPanes.find(entry => entry.pane.element.contains(event.target as Node));
			if (entry && entry.pane !== this.activePane) this.activatePane(entry.id);
		}));
		// The same retained body can also be lent to an editor host with independent geometry.
		this._register(observeElementSize(this.body, size => this.updateSessionsSidebarLayout(size.width)));
		this._register(addDisposableListener(this.body, 'keydown', event => {
			if (event.key !== 'Escape' || !this.sessionsSidebarVisible.get()) {
				return;
			}
			event.preventDefault();
			this.sessionsSidebarManualVisibility = false;
			this.setSessionsSidebarVisible(false);
		}));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ChatConfiguration.ChatViewSessionsOrientation) && this.sessionsSidebarManualVisibility === false) {
				this.sessionsSidebarManualVisibility = undefined;
			}
			if (event.affectsConfiguration(AGENT_SESSIONS_PRESENTATION_SETTING) || event.affectsConfiguration(ChatConfiguration.ChatViewSessionsOrientation)) {
				this.updateSessionsLayout();
			}
		}));
		this._register(toDisposable(() => this.editorMount?.dispose()));
		this._register(toDisposable(() => {
			this.editorTransfer.clearData(DraggedEditorIdentifier.prototype);
			for (const mount of [...this.sessionEditors.values()]) mount.lease.dispose();
		}));
	}

	/** Connects a product-owned catalog after the adapter has initialized its state. */
	protected initializeSessionsControl(onNewSession: () => void, getActions: IAgentSessionsControlOptions['getActions'], onDidOpenSession: (preserveFocus: boolean) => void): void {
		this.onNewSession = onNewSession;
		const createNewSession = () => {
			onNewSession();
			this.hideSessionsAfterSelection();
			this.activePane?.focus();
		};
		this.sessionsControl = this._register(this.instantiationService.createInstance(AgentSessionsControl, this.sessionsSidebar, { getActions }));
		this._register(observeElementSize(this.sessionsControl.element, size => this.sessionsControl.layout(size.height, size.width)));
		this.sessionsControl.setVisible(false);
		this._register(this.sessionsControl.onDidRequestNewSession(createNewSession));
		this._register(this.sessionsControl.onDidOpenSession(event => onDidOpenSession(event.preserveFocus)));
		this._register(this.sessionsControl.onDidRequestToggleLayout(() => {
			const command = this.sessionsSideBySide ? 'agentSessions.hideAgentSessionsSidebar' : 'agentSessions.showAgentSessionsSidebar';
			void this.commandService.executeCommand(command).catch(onUnexpectedError);
		}));
		this._register(this.onDidChangeBodyVisibility(() => this.updateSessionsControlVisibility()));
	}

	public abstract openInNewWindow(): Promise<void>;
	protected abstract saveViewState(): void;
	protected abstract updateSessions(openPaneId?: string): {
		readonly entries: readonly IChatViewPaneEntry<TModel>[];
		readonly activePaneId: string | undefined;
	};
	protected abstract activatePane(id: string): void;
	protected abstract ensureConversationForVisibleChat(): void;
	/** Borrows a distinct retained conversation without navigating the main Chat selection. */
	public abstract createEmbeddedChat(parent: HTMLElement, titleId: string, options?: IChatWidgetViewOptions): IQuickChatSession;
	/** Invalidates pending work even when navigation returns to the same retained composer. */
	protected abstract get selectionRevision(): number;
	/** Restores a requested conversation through the product owner before an editor borrows it. */
	protected abstract restoreEditorPane(id: string): Promise<void>;

	private getDraggedSession(): DraggedEditorIdentifier | undefined {
		const dragged = this.editorTransfer.getData(DraggedEditorIdentifier.prototype)?.[0];
		return dragged?.source && !dragged.wholeGroup && [...this.sessionEditors.values()].some(mount => mount.input === dragged.input) ? dragged : undefined;
	}

	/** Moves one tab without moving the shared Chat frame or changing the conversation lifetime. */
	public async moveSessionToEditor(id: string): Promise<void> {
		const entry = this.renderedPanes.find(entry => entry.id === id);
		if (this.editorMount || !entry || entry.detached) return;
		await this.editorService!.openEditor(new ChatEditorInput(entry.id, entry.label), { pinned: true });
	}

	/** Releases an editor lease, or leaves a side-bar conversation on its synchronous host path. */
	protected releaseSessionEditor(pane: ChatWidget<TModel>): Promise<boolean> | undefined {
		const input = this.sessionEditors.get(pane)?.input;
		if (!input) return undefined;
		return (async () => {
			for (const group of this.editorGroups.groups) {
				if (group.inputs.includes(input) && !await group.closeEditor(input)) return false;
			}
			return !this.sessionEditors.has(pane);
		})();
	}

	/** A close releases the editor's lease; only then can the tab be selected and ordered in the side bar. */
	public async moveSessionToSideBar(resource: URI, target?: string, position: 'before' | 'after' = 'after'): Promise<void> {
		const mounted = [...this.sessionEditors].find(([, mount]) => mount.input.resource.toString() === resource.toString());
		if (!mounted) return;
		const [pane] = mounted;
		if (!await this.releaseSessionEditor(pane) || this.isDisposed) return;
		const entry = this.renderedPanes.find(entry => entry.pane === pane);
		if (!entry) return;
		const ids = this.openedPaneIds.filter(id => id !== entry.id);
		const index = target ? ids.indexOf(target) : ids.length;
		if (index >= 0) {
			ids.splice(index + (target && position === 'after' ? 1 : 0), 0, entry.id);
			this.openedPaneIds = ids;
		}
		this.activatePane(entry.id);
		this.syncSessions();
		this.saveViewState();
		this.layoutService.showPart('auxiliarybar');
		pane.focus();
	}

	/** Borrows the original widget; selection, draft storage and execution remain with the product adapter. */
	public async attachSessionEditor(input: ChatEditorInput, parent: HTMLElement): Promise<IDisposable & { readonly widget: ChatWidget<TModel>; setVisible(visible: boolean): void; }> {
		if (input.paneId === undefined) throw new TypeError('A session editor requires a conversation');
		await this.restoreEditorPane(input.paneId);
		if (this.isDisposed) throw new Error('Chat view is disposed');
		const entry = this.renderedPanes.find(entry => entry.id === input.paneId);
		if (!entry || entry.detached) throw new Error(localize('chatSession.target.invalid', 'Choose a valid session.'));
		const pane = entry.pane;
		const previous = this.sessionEditors.get(pane);
		if (previous && previous.input !== input) throw new Error('Conversation already has an editor host');
		const focused = pane.element.ownerDocument.activeElement;
		const focusListener = addDisposableListener(pane.element, 'focusin', () => {
			const current = this.renderedPanes.find(candidate => candidate.pane === pane);
			if (current && this.activePane !== pane) this.activatePane(current.id);
		});
		const lease = toDisposable(() => {
			focusListener.dispose();
			if (this.sessionEditors.get(pane)?.lease !== lease) return;
			this.sessionEditors.delete(pane);
			if (!pane.isDisposed) this.paneHost.append(pane.element);
			if (!this.isDisposed) this.syncSessions();
		});
		this.sessionEditors.set(pane, { input, visible: true, lease });
		this.draggedPaneId = undefined;
		previous?.lease.dispose();
		parent.append(pane.element);
		this.syncSessions();
		if (isHTMLElement(focused) && pane.element.contains(focused)) focused.focus({ preventScroll: true });
		return {
			[Symbol.dispose]: () => lease.dispose(),
			widget: pane,
			setVisible: visible => {
				const mount = this.sessionEditors.get(pane);
				if (mount?.lease !== lease || pane.isDisposed) return;
				mount.visible = visible;
				pane.setVisible(visible);
			},
			dispose: () => lease.dispose(),
		};
	}

	/** The product callback creates the draft; this host only projects its editor identity. */
	public createNewChatEditorInput(source?: ChatEditorInput): ChatEditorInput {
		// An inactive editor can belong to another host than the foreground Chat.
		if (source?.paneId !== undefined) {
			if (!this.renderedPanes.some(entry => entry.id === source.paneId)) {
				throw new Error(localize('chat.sessions.editorUnavailable', 'This chat is no longer available in the editor.'));
			}
			this.activatePane(source.paneId);
		}
		this.onNewSession();
		this.syncSessions();
		const entry = this.renderedPanes.find(candidate => candidate.pane === this.activePane);
		if (!entry) throw new Error(localize('chat.sessions.newUnavailable', 'A new chat could not be opened.'));
		return new ChatEditorInput(entry.id, entry.label);
	}

	public async moveToEditor(): Promise<void> {
		const revision = this.selectionRevision;
		const pane = this.activePane;
		await pane?.captureDraft();
		if (this.isDisposed || pane !== this.activePane || revision !== this.selectionRevision) {
			return;
		}
		await this.editorService!.openEditor(new ChatEditorInput(), { pinned: true });
	}

	public addContext(attachment: ChatContextAttachment): void {
		this.ensureConversationForVisibleChat();
		this.activePane?.addContext(attachment);
	}

	public captureScreenshot(capture?: ChatImageCapture): Promise<void> {
		this.ensureConversationForVisibleChat();
		return this.activePane?.captureScreenshot(capture) ?? Promise.resolve();
	}

	public captureActiveDraft(): Promise<{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void; } | undefined> {
		return this.activePane?.captureDraft() ?? Promise.resolve(undefined);
	}
	public startVoiceConversation(): Promise<void> {
		if (!this.activePane) {
			return Promise.reject(new Error(localize('agentsVoice.noChat', 'Open a Chat before starting voice.')));
		}
		return this.activePane.startVoiceConversation();
	}

	public appendToDraft(text: string): void {
		this.ensureConversationForVisibleChat();
		if (!this.activePane) {
			throw new Error('Chat has no active composer');
		}
		this.activePane.appendToDraft(text);
	}

	public acceptInput(value?: string): Promise<void> {
		this.ensureConversationForVisibleChat();
		return this.activePane?.acceptInput(value) ?? Promise.resolve();
	}

	/** Lends the original conversation tree, including its live composer, to one editor host. */
	public attachEditor(parent: HTMLElement): IDisposable {
		this.editorMount?.dispose();
		const focused = this.element.ownerDocument.activeElement;
		const title = this.titleControl.partTitleProjection;
		const header = h(parent.ownerDocument, 'div', { className: 'ash-chat-editor-title' });
		header.append(title.content!, title.actions!);
		parent.append(header, this.body);
		this.inEditor.set(true);
		const lease = toDisposable(() => {
			if (this.editorMount !== lease) {
				return;
			}
			this.editorMount = undefined;
			this.editorMountParent = undefined;
			this.activePane?.setVisible(true);
			this.contentElement.append(this.body);
			this.element.append(title.content!, title.actions!);
			header.remove();
			this.inEditor.set(false);
			this.updateSessionsControlVisibility();
			this.updateTitleArea();
			if (!this.isDisposed && !this.lifecycleService.willShutdown) {
				this.layoutService.showPart('auxiliarybar');
			}
		});
		this.editorMount = lease;
		this.editorMountParent = parent;
		this.updateSessionsControlVisibility();
		this.layoutService.hidePart('auxiliarybar');
		if (isHTMLElement(focused) && parent.contains(focused)) {
			focused.focus({ preventScroll: true });
		}
		return lease;
	}

	public setEditorVisible(parent: HTMLElement, visible: boolean): void {
		if (this.editorMountParent !== parent) {
			return;
		}
		this.editorVisible = visible;
		this.updateSessionsControlVisibility();
		this.syncSessions();
	}

	public override focus(): void {
		this.focusInput();
	}

	public focusInput(): void {
		const mount = this.activePane && this.sessionEditors.get(this.activePane);
		if (mount && !mount.visible) {
			void this.editorService!.openEditor(mount.input).catch(onUnexpectedError);
			return;
		}
		this.activePane?.focus();
	}

	public focusSessions(): boolean {
		if (!this.sessionsSidebarVisible.get() || !(this.editorMount ? this.editorVisible : this.isBodyVisible())) {
			return false;
		}
		this.sessionsControl.focus();
		return true;
	}

	protected override layoutBody(height: number, width: number): void {
		if (!this.editorMount) {
			this.updateSessionsSidebarLayout(width);
			if (width > 0) {
				this.lastDimensionsPerOrientation.set(this.getSessionsViewerOrientation(), { height, width });
			}
		}
	}

	public override getOptimalWidth(): number {
		return this.sessionsSidebarVisible.get() && this.configuration.getValue<string>(ChatConfiguration.ChatViewSessionsOrientation) !== 'stacked'
			? sideBySideSessionsWidth : defaultChatWidth;
	}

	public toggleSessionsSidebar(options?: { readonly visible: boolean; }): boolean {
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

	public override get partTitleProjection(): PartTitleProjection {
		return this.editorMount ? {} : { ...this.titleControl.partTitleProjection, hideContainerSelector: true };
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
				if (this.focusReturn) {
					this.focusReturn();
				}
				else {
					this.focus();
				}
			}
			this.focusReturn = undefined;
		} else if (focus) {
			this.sessionsControl.focus();
		}
		this.layoutSessionsSash();
	}

	protected hideSessionsAfterSelection(): void {
		if (this.sessionsSideBySide) {
			return;
		}
		this.sessionsSidebarManualVisibility = undefined;
		this.setSessionsSidebarVisible(false);
	}

	private updateSessionsControlVisibility(): void {
		this.sessionsControl.setVisible(this.sessionsSidebarVisible.get() === true && (this.editorMount ? this.editorVisible : this.isBodyVisible()));
	}

	private updateSessionsSidebarLayout(width: number): void {
		if (width <= 0) {
			return;
		}
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
		return clamp(this.sessionsSidebarWidth, ChatViewPane.SESSIONS_SIDEBAR_MIN_WIDTH, Math.max(ChatViewPane.SESSIONS_SIDEBAR_MIN_WIDTH, this.chatBodyWidth - defaultChatWidth));
	}

	private layoutSessionsSash(): void {
		const visible = this.sessionsSideBySide && this.sessionsSidebarVisible.get() === true;
		this.sessionsViewerOrientationContext.set(this.getSessionsViewerOrientation());
		const sash = this.sessionsSash;
		if (!visible && sash.element === this.body.ownerDocument.activeElement) {
			this.focus();
		}
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
		sash.state = chatWidth <= defaultChatWidth ? SashState.AtMinimum : width <= ChatViewPane.SESSIONS_SIDEBAR_MIN_WIDTH ? SashState.AtMaximum : SashState.Enabled;
		sash.element.setAttribute('aria-valuemin', String(ChatViewPane.SESSIONS_SIDEBAR_MIN_WIDTH));
		sash.element.setAttribute('aria-valuemax', String(this.chatBodyWidth - defaultChatWidth));
		sash.element.setAttribute('aria-valuenow', String(width));
		sash.layout();
	}

	protected updateSessionsLayout(): void {
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

	/** Refreshes product models before projecting their retained widgets into the shared frame. */
	protected syncSessions(openPaneId?: string): void {
		const focusedElement = this.element.ownerDocument.activeElement;
		const restoreFocus = isHTMLElement(focusedElement) && this.paneHost.contains(focusedElement);
		const projection = this.updateSessions(openPaneId);
		const entries = [...projection.entries].sort((a, b) => this.openedPaneIds.indexOf(a.id) - this.openedPaneIds.indexOf(b.id));
		this.renderedPanes = entries;
		const sidebarEntries = entries.filter(entry => !this.sessionEditors.has(entry.pane));
		const selectedEntry = entries.find(entry => entry.id === projection.activePaneId);
		const activeEntry = selectedEntry && (sidebarEntries.find(entry => entry === selectedEntry)
			?? sidebarEntries.find(entry => entry.pane === this.sidebarPane) ?? sidebarEntries[0]);
		const activePane = activeEntry?.pane;
		this.sidebarPane = activePane;
		const orderedNodes = [...sidebarEntries.map(entry => entry.detached?.placeholder ?? entry.pane.element), this.empty];
		for (let index = 0; index < orderedNodes.length; index += 1) {
			const node = orderedNodes[index]!;
			// Retained editors stay attached while the product's session metadata refreshes.
			if (this.paneHost.children[index] !== node) {
				this.paneHost.insertBefore(node, this.paneHost.children[index] ?? null);
			}
		}
		this.activePane = selectedEntry?.pane;
		for (const entry of entries) {
			const mount = this.sessionEditors.get(entry.pane);
			if (mount) mount.input.updateSession(entry.id, entry.label);
			entry.pane.setVisible(mount ? mount.visible : entry.detached ? entry.detached.visible !== false : entry.pane === activePane && (!this.editorMount || this.editorVisible));
			if (entry.detached) {
				entry.detached.placeholder.hidden = entry.pane !== activePane;
			}
		}
		for (const [pane, mount] of this.sessionEditors) {
			if (entries.some(entry => entry.pane === pane)) continue;
			for (const group of this.editorGroups.groups) {
				if (group.inputs.includes(mount.input)) void group.closeEditor(mount.input, { skipConfirmation: true }).catch(onUnexpectedError);
			}
		}
		this.empty.hidden = sidebarEntries.length > 0;
		this.titleControl.update(activeEntry?.label, activeEntry ? activeEntry.detached?.placeholder.id ?? activeEntry.pane.element.id : undefined);
		this.updateSessionTabs(sidebarEntries);
		if (restoreFocus && activePane?.element.contains(focusedElement)) {
			focusedElement.focus();
		}
	}

	private updateSessionTabs(entries: readonly IChatViewPaneEntry<TModel>[]): void {
		const tabs = this.sessionsPresentation === AgentSessionsPresentation.Tabs;
		this.body.classList.toggle('has-session-tabs', tabs);
		this.titleControl.setTabs(entries.map(entry => ({
			id: entry.pane.element.id,
			value: entry.id,
			label: entry.label,
			icon: Lxicon.commentDiscussion,
			tabId: `${entry.pane.element.id}-tab`,
			panelId: entry.detached?.placeholder.id ?? entry.pane.element.id,
			closeActionTooltip: localize('chat.sessions.closeTab', 'Close session tab'),
		})), this.sidebarPane?.element.id, tabs ? this.tabsOptions : undefined, id => this.getTabActions(id));
		for (const entry of entries) {
			entry.pane.element.setAttribute('role', tabs ? 'tabpanel' : 'region');
			entry.pane.setTabId(entry.detached?.titleId
				?? (tabs ? `${entry.pane.element.id}-tab` : entry.pane === this.activePane ? this.titleControl.titleId : undefined));
		}
	}

	private getTabActions(id: string): readonly IAction[] {
		const entry = this.renderedPanes.find(entry => entry.id === id);
		if (!entry) return [];
		const ids = this.renderedPanes.filter(entry => !this.sessionEditors.has(entry.pane)).map(entry => entry.id);
		const others = ids.filter(candidate => candidate !== id);
		const right = ids.slice(ids.indexOf(id) + 1);
		const close = async (targets: readonly string[]): Promise<void> => {
			for (const target of targets) await this.closePane(target);
		};
		return Separator.join([...(entry.getActions?.() ?? [])], [
			{
				id: 'chat.moveSessionToEditor', label: localize({ bundle: 'ash.sessions', key: 'command.MoveChatToEditorAction' }, 'Move Chat to Editor Area'),
				tooltip: '', enabled: !entry.detached && !this.editorMount,
				run: () => this.moveSessionToEditor(id),
			},
		], [
			{
				id: 'chat.closeTab', label: localize({ bundle: 'ash', key: 'workbench.closeEditor' }, 'Close'),
				tooltip: '', enabled: true, run: () => close([id]),
			},
			{
				id: 'chat.closeOtherTabs', label: localize({ bundle: 'ash', key: 'workbench.closeOtherEditors' }, 'Close Others'),
				tooltip: '', enabled: others.length > 0, run: () => close(others),
			},
			{
				id: 'chat.closeTabsToRight', label: localize({ bundle: 'ash', key: 'workbench.closeEditorsToTheRight' }, 'Close to the Right'),
				tooltip: '', enabled: right.length > 0, run: () => close(right),
			},
			{
				id: 'chat.closeAllTabs', label: localize({ bundle: 'ash', key: 'workbench.closeAllEditors' }, 'Close All'),
				tooltip: '', enabled: true, run: () => close(ids),
			},
		], [
			{
				id: OPEN_CHAT_SETTINGS_COMMAND_ID,
				label: localize({ bundle: 'ash.sessions', key: 'command.OpenChatSettingsAction' }, 'Chat Settings'),
				tooltip: '', enabled: true,
				run: () => this.commandService.executeCommand(OPEN_CHAT_SETTINGS_COMMAND_ID),
			},
		]);
	}

	private async closePane(id: string): Promise<void> {
		const pane = this.renderedPanes.find(entry => entry.id === id)?.pane;
		if (!pane || this.closingPanes.has(id)) {
			return;
		}
		this.closingPanes.add(id);
		try {
			await pane.captureDraft();
			if (this.isDisposed || this.renderedPanes.find(entry => entry.id === id)?.pane !== pane) {
				return;
			}
			if (!this.editorMount && this.openedPaneIds.length === 1) {
				// Keep the last conversation available when the retained side bar is reopened.
				await this.commandService.executeCommand('workbench.action.closeAuxiliaryBar');
				return;
			}
			const index = this.openedPaneIds.indexOf(id);
			this.openedPaneIds = this.openedPaneIds.filter(candidate => candidate !== id);
			if (this.activePane === pane) {
				const next = this.openedPaneIds[Math.min(index, this.openedPaneIds.length - 1)];
				if (next) {
					this.activatePane(next);
				}
				else {
					this.onNewSession();
				}
			}
			this.syncSessions();
			this.saveViewState();
		} finally {
			this.closingPanes.delete(id);
		}
	}

}
