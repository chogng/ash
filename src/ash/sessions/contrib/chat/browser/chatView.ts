import { ILogService } from '../../../../platform/log/common/log.js';
import { logSessionHistoryBinding } from '../../../services/sessions/browser/sessionOpenTelemetryService.js';
import './media/chatView.css';
import { h } from '../../../../base/browser/dom.js';
import type { URI } from '../../../../base/common/uri.js';
import { LocalChatSessionUri } from '../../../../workbench/contrib/chat/common/model/chatUri.js';
import { ISessionsChatViewStateService } from './chatViewStateService.js';
import { Disposable, toDisposable, type DisposableStore } from '../../../../base/common/lifecycle.js';
import { IChatService } from '../../../../workbench/services/chat/common/chatService.js';
import { ISessionProviderScopeService } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { ChatWidgetModel, type ChatWidgetSelection } from '../../../browser/chatWidgetModel.js';
import { SessionInfoRail } from '../../../browser/parts/sessionInfoRail.js';
import type { ISessionChatView, ISessionsConversationPane } from '../../../browser/parts/sessionView.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionContext } from '../../../services/sessions/browser/sessionContext.js';
import { NewChatInSessionWidget } from './newChatInSessionWidget.js';
import { NewChatWidget } from './newChatWidget.js';
import type { ChatMessagePresentation } from '../../../../workbench/contrib/chat/browser/chat.js';
import { SessionEnvironmentActions } from './sessionEnvironmentActions.js';
import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import type { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import type { ChatWidget } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';

interface IChatViewOptions {
	readonly className?: string;
	readonly label?: string;
}

/** Hosts the shared transcript and composer for a SessionView. */
export class ChatView<TWidget extends ChatWidget = ChatWidget> extends Disposable implements ISessionChatView {
	readonly element: HTMLElement;
	protected readonly widget: TWidget;
	private readonly shown = observableValue(this, false);
	protected get visible(): boolean { return this.shown.get(); }

	constructor(
		container: HTMLElement,
		createWidget: (element: HTMLElement, owner: DisposableStore, visible: IObservable<boolean>) => TWidget,
		options?: IChatViewOptions,
	) {
		super();
		this.element = h(container.ownerDocument, 'section', {
			className: options?.className ? `ash-sessions-chat-content ${options.className}` : 'ash-sessions-chat-content',
			attributes: options?.label ? { 'aria-label': options.label } : {},
		});
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
		try {
			this.widget = this._register(createWidget(this.element, this._store, this.shown));
			this.widget.setVisible(false);
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	get model(): TWidget['model'] { return this.widget.model; }
	get input(): ISessionChatView['input'] { return this.widget.input; }
	get sessionId(): ISessionChatView['sessionId'] { return this.widget.sessionId; }
	focus(): void { this.widget.focus(); }
	startVoiceConversation(): Promise<void> { return this.widget.startVoiceConversation(); }
	addContext(...args: Parameters<ISessionChatView['addContext']>): void { this.widget.addContext(...args); }
	acquireContext(...args: Parameters<ISessionChatView['acquireContext']>): ReturnType<ISessionChatView['acquireContext']> { return this.widget.acquireContext(...args); }
	appendToDraft(...args: Parameters<ISessionChatView['appendToDraft']>): void { this.widget.appendToDraft(...args); }
	captureDraft(): ReturnType<ISessionChatView['captureDraft']> { return this.widget.captureDraft(); }
	restoreDraft(...args: Parameters<ISessionChatView['restoreDraft']>): void { this.widget.restoreDraft(...args); }
	setVisible(visible: boolean): void {
		this.widget.setVisible(visible);
		this.shown.set(visible, undefined);
	}
}

interface INewChatViewOptions {
	readonly panelId: string;
	readonly selection: ChatWidgetSelection;
	readonly createNewSession: () => void;
	readonly onDidChangeInfo: () => void;
	readonly messagePresentation?: ChatMessagePresentation;
}

/** Retains one Code surface and its provider scope when a draft acquires a durable Session identity. */
export class NewChatView extends ChatView<NewChatWidget> implements ISessionsConversationPane {
	private readonly info: SessionInfoRail;
	private viewStateResource: URI | undefined;

	constructor(
		container: HTMLElement,
		options: INewChatViewOptions,
		@ISessionProviderScopeService providerScopes: ISessionProviderScopeService,
		@IChatService chatService: IChatService,
		@ISessionsManagementService sessions: ISessionsManagementService,
		@ISessionsChatViewStateService private readonly viewStateService: ISessionsChatViewStateService,
	) {
		const { selection, panelId, createNewSession, onDidChangeInfo } = options;
		let scope!: InstantiationService;
		super(container, (element, owner) => {
			scope = owner.add(providerScopes.createScope(
				selection.kind === 'session' ? selection.active.session.sessionId : undefined,
				selection.kind === 'untitled' ? selection.session.providerId : undefined,
			));
			const model = scope.createInstance(ChatWidgetModel, chatService, selection, sessions);
			try {
				scope.registerInstance(ISessionContext, model);
				const log = scope.getOptional(ILogService);
				if (log) owner.add(logSessionHistoryBinding(log, model.onDidFinishHistoryBinding));
				return scope.createInstance(model.isNestedDraft ? NewChatInSessionWidget : NewChatWidget,
					element, { panelId, model, createNewSession, messagePresentation: options.messagePresentation });
			} catch (error) {
				model.dispose();
				throw error;
			}
		});
		const model = this.model;
		try {
			this.info = this._register(scope.createInstance(SessionInfoRail, this.element, model, () => this.widget.focus(),
				(container: HTMLElement) => scope.createInstance(SessionEnvironmentActions, container, model)));
			this._register(this.info.onDidChange(onDidChangeInfo));
			const updateLoading = () => {
				this.widget.element.querySelector(':scope > .ash-chat-list-widget')?.setAttribute('aria-busy', String(model.state === 'loading'));
				this.restoreConversationViewState();
			};
			this._register(model.onDidChange(updateLoading));
			this._register(model.onDidChangeComposer(() => {
				// The outgoing transcript is still mounted before the model switches Threads.
				this.saveConversationViewState();
				this.viewStateResource = undefined;
			}));
			updateLoading();
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	public get infoVisible(): boolean { return this.info.visible; }
	public toggleInfo(): void { this.info.toggle(); }
	public saveState(): Promise<void> { return this.widget.saveState(); }
	public focusDraftPicker(picker: 'workspace' | 'environment'): void {
		if (picker === 'workspace') this.widget.focusWorkspacePicker();
		else this.widget.focusEnvironmentPicker();
	}
	override setVisible(visible: boolean): void {
		if (!visible) this.saveConversationViewState();
		super.setVisible(visible);
		this.info.setVisible(visible);
		this.restoreConversationViewState();
	}

	protected override disposeCore(): void {
		this.saveConversationViewState();
		super.disposeCore();
	}

	private saveConversationViewState(): void {
		if (this.viewStateResource && this.visible) {
			this.viewStateService.set(this.viewStateResource, this.widget.getViewState());
		}
	}

	private restoreConversationViewState(): void {
		if (!this.visible || this.viewStateResource) return;
		const { sessionId, threadId, thread } = this.model;
		if (!sessionId || !threadId || thread?.threadId !== threadId) return;

		// Only a bound transcript can restore a reading anchor or disclosure state.
		const resource = this.viewStateResource = LocalChatSessionUri.forSession(sessionId, threadId);
		const state = this.viewStateService.get(resource);
		if (state) this.widget.restoreViewState(state);
	}
}
