import { ISessionProviderScopeService } from '../agentHost/sessionProviderScopeService.js';
import { ScopedSessionConversationPane } from './scopedSessionConversationPane.js';
import { IStorageService, StorageScope } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import type { ChatContextAttachment } from '../../../workbench/services/chat/common/chatContextService.js';
import "./media/sessionsPart.css";
import { Dimension, h } from "../../../base/browser/dom.js";
import type { ICommandService } from "../../../platform/commands/common/commands.js";
import type { IAccessibleViewService } from '../../../platform/accessibility/browser/accessibleView.js';
import type { IContextMenuService } from "../../../platform/contextview/browser/contextView.js";
import type { IContextViewService } from "../../../platform/contextview/browser/contextView.js";
import type { IChatService } from "../../../workbench/services/chat/common/chatService.js";
import type { ISessionsManagementService } from "../../services/sessions/common/sessionsManagement.js";
import { Part } from "../../../workbench/browser/part.js";
import type { SessionsViewSelection } from "../../services/sessions/browser/sessionsService.js";
import { SessionView, type ISessionsConversationPane } from './sessionView.js';
import { SessionGridLayout } from './sessionGridLayout.js';
import type { IView } from '../../../base/browser/ui/grid/grid.js';
import type { IPositionedRectangle } from '../../../base/browser/geometry.js';
import { setDisposableOwner, toDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { WELCOME_COMPLETE_KEY } from '../../common/welcome.js';
import type { SessionId } from '../../services/sessions/common/session.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import type { IChatInputPart } from '../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import type { ChatInputDelegate } from '../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { ChatWidgetModel } from '../chatWidgetModel.js';
import { ChatWidget } from '../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import type { INotificationService } from '../../../platform/notification/common/notification.js';
import type { IOpenAgentsWindowOptions } from '../../../platform/native/common/nativeHost.js';
import type { ISessionsConversationService, SessionsConversationKind } from '../../services/sessions/common/sessionsConversation.js';

export interface SessionsPartOptions {
	readonly sessionService: ISessionsManagementService;
	readonly chatService: IChatService;
	readonly contextMenuService: IContextMenuService;
	readonly contextViewService: IContextViewService;
	readonly accessibleViewService: IAccessibleViewService;
	readonly notifications: INotificationService;
	readonly commandService: ICommandService;
	readonly createInputPart: (container: HTMLElement, delegate: ChatInputDelegate, model: ChatWidgetModel, scope: IInstantiationService) => IChatInputPart;
	readonly createCoworkPane: (container: HTMLElement, panelId: string, selection: SessionsViewSelection) => ISessionsConversationPane;
	readonly activateSelection: (selection: SessionsViewSelection) => void;
	readonly createNewSession: () => void;
}

/** Owns one conversation grid and one retained view per visible Session. */
export class SessionsPart extends Part implements ISessionsConversationService {
	private readonly content: HTMLElement;
	private readonly grid: SessionGridLayout;
	private readonly empty: SessionsChatEmptyView;
	private readonly entries = new Map<string, SessionView>();
	private activeView: SessionView | undefined;
	private kind: SessionsConversationKind = 'code';
	private visible = true;
	private switching = Promise.resolve();

	override get minimumWidth(): number { return 420; }

	constructor(
		container: HTMLElement,
		private readonly options: SessionsPartOptions,
		@IInstantiationService private readonly services: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ISessionProviderScopeService private readonly providerScopes: ISessionProviderScopeService,
	) {
		super(container, 'sessions', themeService, storageService);
		this.content = h(container.ownerDocument, 'section');
		this.content.className = 'ash-sessions-chat-view';
		this.contentDomNode.append(this.content);
		this.empty = new SessionsChatEmptyView(this.content, () => storageService.getBoolean(WELCOME_COMPLETE_KEY, StorageScope.PROFILE, false));
		this.grid = this._register(services.createInstance(SessionGridLayout, this.content, this.empty));
		this._register(storageService.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key === WELCOME_COMPLETE_KEY) this.empty.update(options.sessionService.state, options.sessionService.error);
		}));
		this._register(toDisposable(() => {
			for (const view of this.entries.values()) view.dispose();
			this.entries.clear();
		}));
		this.updateVisibleSelections([], undefined);
	}

	setConversationKind(kind: SessionsConversationKind): Promise<void> {
		const switchKind = async () => {
			if (this.isDisposed) return;
			this.kind = kind;
			await Promise.all([...this.entries.values()].map(view => view.setConversationKind(kind)));
		};
		// Entry commands may overlap while a composer flushes its pending edits.
		this.switching = this.switching.then(switchKind, switchKind);
		return this.switching;
	}

	focus(): void { this.activeView?.focus(); }

	addContext(attachment: ChatContextAttachment): void {
		if (!this.activeView) throw new Error(localize('sessions.handoff.noActiveChat', 'Agents Window has no active chat for the draft.'));
		this.activeView.activeChat.addContext(attachment);
	}

	appendToDraft(text: string): void {
		if (!this.activeView) throw new Error(localize('sessions.handoff.noActiveChat', 'Agents Window has no active chat for the draft.'));
		this.activeView.activeChat.appendToDraft(text);
	}

	startVoiceConversation(): Promise<void> {
		if (!this.activeView) return Promise.reject(new Error(localize('agentsVoice.noChat', 'Open a Chat before starting voice.')));
		return this.activeView.activeChat.startVoiceConversation();
	}

	async captureActiveDraft(): Promise<{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void; } | undefined> {
		await this.switching;
		return this.activeView?.activeChat.captureDraft();
	}

	restoreDraft(draft: NonNullable<IOpenAgentsWindowOptions['draft']>): void {
		if (!this.activeView) throw new Error(localize('sessions.handoff.noActiveChat', 'Agents Window has no active chat for the draft.'));
		this.activeView.activeChat.restoreDraft(draft);
		if (this.visible) this.activeView.focus();
	}

	updateVisibleSelections(selections: readonly SessionsViewSelection[], active: SessionsViewSelection | undefined): void {
		// Materializing a draft changes its identity, not its view or live input.
		for (const [key, view] of [...this.entries]) {
			const id = view.activeChat.sessionId;
			if (!id || key === sessionKey(id) || this.entries.has(sessionKey(id))) continue;
			this.entries.delete(key);
			this.entries.set(sessionKey(id), view);
		}
		this.content.classList.toggle('single-chat', selections.length === 1);
		this.empty.update(this.options.sessionService.state, this.options.sessionService.error);
		const desired = new Set(selections.map(selectionKey));
		const removed: SessionView[] = [];
		for (const [key, view] of this.entries) {
			if (desired.has(key)) continue;
			this.entries.delete(key);
			removed.push(view);
		}
		const entries = selections.map(selection => {
			const id = selectionKey(selection);
			let view = this.entries.get(id);
			if (!view) {
				view = new SessionView(this.content, {
					selection, kind: this.kind,
					createPane: (kind, container, panelId, selected) => this.createPane(kind, container, panelId, selected),
					activateSelection: this.options.activateSelection,
				});
				setDisposableOwner(view, this);
				this.entries.set(id, view);
			}
			view.openSession(selection);
			view.setVisible(this.visible);
			view.element.classList.toggle('last-slot', selection === selections.at(-1));
			return { id, view };
		});
		this.activeView = active ? this.entries.get(selectionKey(active)) : undefined;
		this.grid.reconcile(entries.length ? entries : [{ id: 'empty', view: this.empty }], active ? selectionKey(active) : 'empty');
		for (const view of removed) view.dispose();
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.visible = visible;
		this.grid.setVisible(visible);
		for (const view of this.entries.values()) view.setVisible(visible);
	}

	override layout(dimension: Dimension): void {
		const bounds = this.content.getBoundingClientRect();
		this.grid.layout(bounds.width || dimension.width, bounds.height || dimension.height);
	}

	private createPane(kind: SessionsConversationKind, container: HTMLElement, panelId: string, selection: SessionsViewSelection): ISessionsConversationPane {
		const options = this.options;
		if (kind === 'cowork') return options.createCoworkPane(container, panelId, selection);
		const scope = this.providerScopes.createScope(selection.kind === 'session' ? selection.active.session.sessionId : undefined, selection.kind === 'untitled' ? selection.session.providerId : undefined);
		try {
			const model = scope.createInstance(ChatWidgetModel, options.chatService, selection.kind === 'session' ? { kind: 'session', active: selection.active } : { kind: 'untitled', session: selection.session }, options.sessionService);
			const pane = scope.createInstance<ChatWidget<ChatWidgetModel>>(ChatWidget, container, panelId, model, options.createNewSession, options.contextMenuService, options.contextViewService, options.commandService, options.accessibleViewService, options.notifications, undefined, undefined, undefined,
				(inputContainer: HTMLElement, delegate: ChatInputDelegate) => options.createInputPart(inputContainer, delegate, model, scope));
			return new ScopedSessionConversationPane(pane, scope);
		} catch (error) { scope.dispose(); throw error; }
	}
}

class SessionsChatEmptyView implements IView {
	readonly element: HTMLDivElement;
	readonly minimumWidth = 0;
	readonly maximumWidth = Number.POSITIVE_INFINITY;
	readonly minimumHeight = 0;
	readonly maximumHeight = Number.POSITIVE_INFINITY;
	private readonly heading: HTMLHeadingElement;
	private readonly description: HTMLParagraphElement;

	constructor(container: HTMLElement, private readonly welcomeComplete: () => boolean) {
		const ownerDocument = container.ownerDocument;
		this.element = h(ownerDocument, "div");
		this.element.className = "ash-sessions-chat-view-empty";
		this.heading = h(ownerDocument, "h2");
		this.description = h(ownerDocument, "p");
		this.element.append(this.heading, this.description);
		container.append(this.element);
		this.update("ready", undefined);
	}

	layout(_bounds: IPositionedRectangle): void { }

	update(state: ISessionsManagementService["state"], error: string | undefined): void {
		if (state === "loading") {
			this.heading.textContent = localize('sessions.empty.loading', 'Loading sessions');
			this.description.textContent = localize('sessions.empty.restoring', 'Restoring your agent workspace…');
		} else if (error) {
			this.heading.textContent = localize('sessions.empty.unavailable', 'Sessions unavailable');
			this.description.textContent = error;
		} else {
			this.heading.textContent = this.welcomeComplete() ? localize('sessions.empty.returning', 'Open a session') : localize('sessions.empty.welcome', 'Start a code session');
			this.description.textContent = this.welcomeComplete()
				? localize('sessions.empty.select', 'Select a session from the sidebar, or create a new one.')
				: localize('sessions.empty.begin', 'Create a session to plan, implement, or review work with the coding agent.');
		}
	}
}

function selectionKey(selection: SessionsViewSelection): string {
	return selection.kind === "session" ? sessionKey(selection.active.session.sessionId) : `untitled:${selection.session.untitledSessionId}`;
}

function sessionKey(sessionId: SessionId): string {
	return `session:${sessionId}`;
}
