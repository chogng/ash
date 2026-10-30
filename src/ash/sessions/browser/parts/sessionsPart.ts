import type { ICodeCardLayout } from '../codeCardLayout.js';
import { SessionInfoRail } from './sessionInfoRail.js';
import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { MenusRegistry, MenuId } from '../../../platform/actions/common/actions.js';
import { ContextKeyExpr, RawContextKey, type IContextKey } from '../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { Menus } from '../menus.js';
import { localize2 } from '../../../nls.js';
import { ISessionProviderScopeService } from '../agentHost/sessionProviderScopeService.js';
import { ScopedSessionConversationPane } from './scopedSessionConversationPane.js';
import { LoadingSkeleton } from '../ui/loadingSkeleton.js';
import { IStorageService, StorageScope } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import type { ChatContextAttachment } from '../../../workbench/services/chat/common/chatContextService.js';
import './media/sessionsPart.css';
import { Dimension, h } from '../../../base/browser/dom.js';
import type { ICommandService } from '../../../platform/commands/common/commands.js';
import { type IAccessibleViewService } from '../../../platform/accessibility/browser/accessibleView.js';
import type { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import type { IContextViewService } from '../../../platform/contextview/browser/contextView.js';
import type { IChatService } from '../../../workbench/services/chat/common/chatService.js';
import type { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import { Part } from '../../../workbench/browser/part.js';
import type { SessionsViewSelection } from '../../services/sessions/browser/sessionsService.js';
import { SessionView, SessionAuxiliaryWindow, type ISessionsConversationPane } from './sessionView.js';
import { SessionGridLayout } from './sessionGridLayout.js';
import type { IView } from '../../../base/browser/ui/grid/grid.js';
import type { IPositionedRectangle } from '../../../base/browser/geometry.js';
import { Disposable, DisposableStore, setDisposableOwner, toDisposable } from '../../../base/common/lifecycle.js';
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
import {
	IAuxiliaryWindowService,
	type IAuxiliaryWindow,
} from '../../../workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { Button } from '../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../platform/theme/browser/defaultStyles.js';
import type {
	ISessionsConversationService,
	SessionsConversationKind,
} from '../../services/sessions/common/sessionsConversation.js';

export interface SessionsPartOptions {
	readonly codeCards?: ICodeCardLayout;
	readonly sessionService: ISessionsManagementService;
	readonly chatService: IChatService;
	readonly contextMenuService: IContextMenuService;
	readonly contextViewService: IContextViewService;
	readonly accessibleViewService: IAccessibleViewService;
	readonly notifications: INotificationService;
	readonly commandService: ICommandService;
	readonly createInputPart: (
		container: HTMLElement,
		delegate: ChatInputDelegate,
		model: ChatWidgetModel,
		scope: IInstantiationService,
	) => IChatInputPart;
	readonly createCoworkPane: (
		container: HTMLElement,
		panelId: string,
		selection: SessionsViewSelection,
	) => ISessionsConversationPane;
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
	private readonly infoVisible: IContextKey<boolean>;
	private mainKeys: readonly string[] = [];
	private kind: SessionsConversationKind = 'code';
	private visible = true;
	private switching = Promise.resolve();
	private readonly popouts = new Map<
		SessionView,
		{ window: IAuxiliaryWindow; resources: DisposableStore; placeholder: IView; shell: SessionAuxiliaryWindow; }
	>();
	private readonly openingPopouts = new Map<SessionView, Promise<void>>();

	override get minimumWidth(): number {
		return 420;
	}

	constructor(
		container: HTMLElement,
		private readonly options: SessionsPartOptions,
		@IInstantiationService private readonly services: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ISessionProviderScopeService private readonly providerScopes: ISessionProviderScopeService,
		@IAuxiliaryWindowService private readonly auxiliaryWindows: IAuxiliaryWindowService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super(container, 'sessions', themeService, storageService);
		this.infoVisible = new RawContextKey('sessions.infoVisible', false).bindTo(contextKeys);
		this._register(toDisposable(() => this.infoVisible.reset()));
		if (options.codeCards) this._register(options.codeCards.onDidChangeCards(() => this.updateInfoContext()));
		this._register(
			CommandsRegistry.register('ash.sessions.toggleInfo', () => {
				const pane = this.activeView?.activeChat;
				if (pane instanceof CodeSessionConversationPane) pane.info.toggle();
			}),
		);
		const infoCommand = {
			id: 'ash.sessions.toggleInfo',
			title: localize2({ bundle: 'ash', key: 'sessions.info.toggle' }, 'Toggle session information'),
			icon: Lxicon.info,
			toggled: ContextKeyExpr.equals('sessions.infoVisible', true),
		};
		this._register(
			MenusRegistry.appendMenuItems(
				[Menus.TitleBarRightLayout, MenuId.CommandPalette].map(id => ({
					id,
					item: {
						command: infoCommand,
						when: ContextKeyExpr.equals('sessions.toolsAvailable', true),
						group: 'navigation',
						order: 2,
					},
				})),
			),
		);
		this.content = h(container.ownerDocument, 'section');
		this.content.className = 'ash-sessions-chat-view';
		this.contentDomNode.append(this.content);
		this.empty = this._register(
			new SessionsChatEmptyView(this.content, () =>
				storageService.getBoolean(WELCOME_COMPLETE_KEY, StorageScope.PROFILE, false),
			),
		);
		this.grid = this._register(services.createInstance(SessionGridLayout, this.content, this.empty));
		this._register(
			storageService.onDidChangeValue(event => {
				if (event.scope === StorageScope.PROFILE && event.key === WELCOME_COMPLETE_KEY)
					this.empty.update(options.sessionService.state, options.sessionService.error);
			}),
		);
		this._register(
			toDisposable(() => {
				for (const popup of this.popouts.values()) popup.resources.dispose();
				this.popouts.clear();
				for (const view of this.entries.values()) view.dispose();
				this.entries.clear();
			}),
		);
		this.updateVisibleSelections([], undefined);
	}

	setConversationKind(kind: SessionsConversationKind): Promise<void> {
		const switchKind = async () => {
			if (this.isDisposed) return;
			this.kind = kind;
			await Promise.all(
				[...this.entries.values()]
					.filter(view => !this.popouts.has(view))
					.map(view => view.setConversationKind(kind)),
			);
		};
		// Entry commands may overlap while a composer flushes its pending edits.
		this.switching = this.switching.then(switchKind, switchKind);
		return this.switching;
	}

	focus(): void {
		if (this.activeView) this.popouts.get(this.activeView)?.window.window.focus();
		this.activeView?.focus();
	}

	async openInNewWindow(selection: SessionsViewSelection): Promise<void> {
		await this.switching;
		const view = this.entries.get(selectionKey(selection));
		if (!view) throw new Error(localize('chatSession.target.invalid', 'Choose a valid session.'));
		const existing = this.popouts.get(view);
		if (existing) {
			existing.window.window.focus();
			view.focus();
			return;
		}
		let pending = this.openingPopouts.get(view);
		if (!pending) {
			pending = this.detachView(view, selection);
			this.openingPopouts.set(view, pending);
		}
		try {
			await pending;
		} finally {
			if (this.openingPopouts.get(view) === pending) this.openingPopouts.delete(view);
		}
	}

	private async detachView(view: SessionView, selection: SessionsViewSelection): Promise<void> {
		const title = selection.kind === 'session' ? selection.active.session.title : selection.session.title;
		const window = await this.auxiliaryWindows.open({ title, width: 900, height: 760 });
		if (this.isDisposed || ![...this.entries.values()].includes(view)) {
			window.dispose();
			return;
		}
		const resources = new DisposableStore();
		try {
			const shell = resources.add(this.services.createInstance(SessionAuxiliaryWindow, window, title));
			const { header } = shell;
			const placeholder = h(this.content.ownerDocument, 'div', { className: 'ash-sessions-detached-chat' });
			resources.add(
				new Button(placeholder, {
					...defaultButtonStyles,
					presentation: 'quiet',
					label: localize('sessions.window.focus', 'Chat is open in another window'),
					onClick: () => {
						window.window.focus();
						view.focus();
					},
				}),
			);
			const placeholderView: IView = {
				element: placeholder,
				minimumWidth: 300,
				maximumWidth: Infinity,
				minimumHeight: 240,
				maximumHeight: Infinity,
				layout() { },
			};
			this.popouts.set(view, { window, resources, placeholder: placeholderView, shell });
			resources.add(
				toDisposable(() => {
					this.popouts.delete(view);
					// Reattach before the popup document is destroyed. The existing pane is
					// the only owner of its input, transcript and provider subscriptions.
					if (!this.isDisposed && [...this.entries.values()].includes(view)) {
						this.options.activateSelection(view.currentSelection);
						this.reconcileGrid();
						view.setVisible(this.visible);
						void view
							.setConversationKind(this.kind)
							.catch(error => this.options.notifications.error(String(error)));
						if (this.visible && this.activeView === view) view.focus();
					}
					window.dispose();
				}),
			);
			resources.add(window.onDidClose(() => resources.dispose()));
			resources.add(
				window.onWillLayout(dimension =>
					view.layout({
						top: 0,
						left: 0,
						width: dimension.width,
						height: Math.max(0, dimension.height - header.offsetHeight),
					}),
				),
			);
			this.reconcileGrid();
			window.container.append(view.element);
			view.setVisible(true);
			window.window.document.title = title;
			window.layout();
			window.window.focus();
			view.focus();
		} catch (error) {
			resources.dispose();
			window.dispose();
			throw error;
		}
	}

	private reconcileGrid(): void {
		const entries = this.mainKeys.flatMap(id => {
			const view = this.entries.get(id);
			return view ? [{ id, view: this.popouts.get(view)?.placeholder ?? view }] : [];
		});
		const active = [...this.entries].find(([, view]) => view === this.activeView)?.[0] ?? 'empty';
		this.grid.reconcile(entries.length ? entries : [{ id: 'empty', view: this.empty }], active);
	}

	addContext(attachment: ChatContextAttachment): void {
		if (!this.activeView)
			throw new Error(
				localize('sessions.handoff.noActiveChat', 'Agents Window has no active chat for the draft.'),
			);
		this.activeView.activeChat.addContext(attachment);
	}

	appendToDraft(text: string): void {
		if (!this.activeView)
			throw new Error(
				localize('sessions.handoff.noActiveChat', 'Agents Window has no active chat for the draft.'),
			);
		this.activeView.activeChat.appendToDraft(text);
	}

	startVoiceConversation(): Promise<void> {
		if (!this.activeView)
			return Promise.reject(new Error(localize('agentsVoice.noChat', 'Open a Chat before starting voice.')));
		return this.activeView.activeChat.startVoiceConversation();
	}

	async captureActiveDraft(): Promise<
		{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void; } | undefined
	> {
		await this.switching;
		return this.activeView?.activeChat.captureDraft();
	}

	restoreDraft(draft: NonNullable<IOpenAgentsWindowOptions['draft']>): void {
		if (!this.activeView)
			throw new Error(
				localize('sessions.handoff.noActiveChat', 'Agents Window has no active chat for the draft.'),
			);
		this.activeView.activeChat.restoreDraft(draft);
		if (this.visible) this.activeView.focus();
	}

	updateVisibleSelections(
		selections: readonly SessionsViewSelection[],
		active: SessionsViewSelection | undefined,
	): void {
		// Materializing a draft changes its identity, not its view or live input.
		for (const [key, view] of [...this.entries]) {
			const selection = view.currentSelection;
			const id =
				view.activeChat.sessionId ??
				(selection.kind === 'untitled'
					? this.options.sessionService.materializedSessions.get().get(selection.session.untitledSessionId)
						?.sessionId
					: undefined);
			if (!id || key === sessionKey(id) || this.entries.has(sessionKey(id))) continue;
			this.entries.delete(key);
			this.entries.set(sessionKey(id), view);
		}
		this.content.classList.toggle('single-chat', selections.length === 1);
		this.empty.update(this.options.sessionService.state, this.options.sessionService.error);
		this.mainKeys = selections.map(selectionKey);
		const desired = new Set(this.mainKeys);
		const removed: SessionView[] = [];
		for (const [key, view] of this.entries) {
			if (desired.has(key)) continue;
			if (this.popouts.has(view)) {
				const current = view.currentSelection;
				const id =
					view.activeChat.sessionId ??
					(current.kind === 'untitled'
						? this.options.sessionService.materializedSessions.get().get(current.session.untitledSessionId)
							?.sessionId
						: undefined);
				const session = id
					? this.options.sessionService.sessions.find(
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
						const popup = this.popouts.get(view)!;
						popup.shell.setTitle(session.title);
						popup.window.container.setAttribute('aria-label', session.title);
						continue;
					}
				}
				const selection = view.currentSelection;
				if (
					!id &&
					selection.kind === 'untitled' &&
					this.options.sessionService.untitledSessions.some(
						session => session.untitledSessionId === selection.session.untitledSessionId,
					)
				)
					continue;
			}
			this.entries.delete(key);
			removed.push(view);
		}
		for (const selection of selections) {
			const id = selectionKey(selection);
			let view = this.entries.get(id);
			if (!view) {
				view = new SessionView(this.content, {
					selection,
					kind: this.kind,
					createPane: (kind, container, panelId, selected) =>
						this.createPane(kind, container, panelId, selected),
					activateSelection: this.options.activateSelection,
				});
				setDisposableOwner(view, this);
				this.entries.set(id, view);
			}
			view.openSession(selection);
			const popup = this.popouts.get(view);
			view.setVisible(this.visible || popup !== undefined);
			if (popup) {
				const title = selection.kind === 'session' ? selection.active.session.title : selection.session.title;
				popup.shell.setTitle(title);
				popup.window.container.setAttribute('aria-label', title);
			}
			view.element.classList.toggle('last-slot', selection === selections.at(-1));
		}
		this.activeView = active ? this.entries.get(selectionKey(active)) : undefined;
		this.updateInfoContext();
		this.reconcileGrid();
		for (const view of removed) {
			this.popouts.get(view)?.resources.dispose();
			view.dispose();
		}
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.visible = visible;
		this.grid.setVisible(visible);
		for (const view of this.entries.values()) view.setVisible(visible || this.popouts.has(view));
	}

	override layout(dimension: Dimension): void {
		const bounds = this.content.getBoundingClientRect();
		this.grid.layout(bounds.width || dimension.width, bounds.height || dimension.height);
	}

	private updateInfoContext(): void {
		const pane = this.activeView?.activeChat;
		this.options.codeCards?.setInformation(
			pane instanceof CodeSessionConversationPane ? pane.info.element : undefined,
		);
		this.infoVisible.set(pane instanceof CodeSessionConversationPane && pane.info.visible);
	}

	private createPane(
		kind: SessionsConversationKind,
		container: HTMLElement,
		panelId: string,
		selection: SessionsViewSelection,
	): ISessionsConversationPane {
		const options = this.options;
		if (kind === 'cowork') return options.createCoworkPane(container, panelId, selection);
		const scope = this.providerScopes.createScope(
			selection.kind === 'session' ? selection.active.session.sessionId : undefined,
			selection.kind === 'untitled' ? selection.session.providerId : undefined,
		);
		try {
			const model = scope.createInstance(
				ChatWidgetModel,
				options.chatService,
				selection.kind === 'session'
					? { kind: 'session', active: selection.active }
					: { kind: 'untitled', session: selection.session },
				options.sessionService,
			);
			const host = h(container.ownerDocument, 'div');
			host.className = 'ash-code-conversation';
			container.append(host);
			const pane = scope.createInstance<ChatWidget<ChatWidgetModel>>(
				ChatWidget,
				host,
				panelId,
				model,
				options.createNewSession,
				options.contextMenuService,
				options.contextViewService,
				options.commandService,
				options.accessibleViewService,
				options.notifications,
				undefined,
				undefined,
				undefined,
				(inputContainer: HTMLElement, delegate: ChatInputDelegate) =>
					options.createInputPart(inputContainer, delegate, model, scope),
			);
			return new CodeSessionConversationPane(pane, scope, model, host, options.codeCards, () =>
				this.updateInfoContext(),
			);
		} catch (error) {
			scope.dispose();
			throw error;
		}
	}
}

class SessionsChatEmptyView extends Disposable implements IView {
	readonly element: HTMLDivElement;
	readonly minimumWidth = 0;
	readonly maximumWidth = Number.POSITIVE_INFINITY;
	readonly minimumHeight = 0;
	readonly maximumHeight = Number.POSITIVE_INFINITY;
	private readonly heading: HTMLHeadingElement;
	private readonly description: HTMLParagraphElement;
	private readonly loading: LoadingSkeleton;

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
		this.loading = this._register(
			new LoadingSkeleton(
				this.element,
				localize('sessions.empty.restoring', 'Restoring your agent workspace…'),
				'transcript',
				3,
			),
		);
		container.append(this.element);
		this.update('ready', undefined);
	}

	layout(_bounds: IPositionedRectangle): void { }

	update(state: ISessionsManagementService['state'], error: string | undefined): void {
		this.loading.setVisible(state === 'loading' && !error);
		this.element.classList.toggle('loading', !this.loading.element.hidden);
		this.element.setAttribute('aria-busy', String(state === 'loading'));
		this.heading.hidden = this.description.hidden = !this.loading.element.hidden;
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

function selectionKey(selection: SessionsViewSelection): string {
	return selection.kind === 'session'
		? sessionKey(selection.active.session.sessionId)
		: `untitled:${selection.session.untitledSessionId}`;
}

function sessionKey(sessionId: SessionId): string {
	return `session:${sessionId}`;
}

class CodeSessionConversationPane extends ScopedSessionConversationPane {
	readonly info: SessionInfoRail;
	constructor(
		pane: ISessionsConversationPane,
		scope: IInstantiationService,
		model: ChatWidgetModel,
		private readonly host: HTMLElement,
		cards: ICodeCardLayout | undefined,
		changed: () => void,
	) {
		super(pane, scope, model);
		this.info = this._register(scope.createInstance(SessionInfoRail, host, model, () => pane.focus(), cards));
		this._register(this.info.onDidChange(changed));
		this._register(toDisposable(() => host.remove()));
	}
	override get element(): HTMLElement {
		return this.host;
	}
	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.info.setVisible(visible);
	}
}
