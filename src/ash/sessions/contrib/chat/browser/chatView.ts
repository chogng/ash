import { ILogService } from '../../../../platform/log/common/log.js';
import { logSessionHistoryBinding } from '../../../services/sessions/browser/sessionOpenTelemetryService.js';
import './media/chatView.css';
import { h } from '../../../../base/browser/dom.js';
import type { URI } from '../../../../base/common/uri.js';
import { LocalChatSessionUri } from '../../../../workbench/contrib/chat/common/model/chatUri.js';
import { ISessionsChatViewStateService } from './chatViewStateService.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IChatService } from '../../../../workbench/services/chat/common/chatService.js';
import { ISessionProviderScopeService } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { ChatWidgetModel } from '../../../browser/chatWidgetModel.js';
import { SessionInfoRail } from '../../../browser/parts/sessionInfoRail.js';
import type { ISessionsConversationPane } from '../../../browser/parts/sessionView.js';
import type { SessionsViewSelection } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionContext } from '../../../services/sessions/browser/sessionContext.js';
import { NewChatInSessionWidget } from './newChatInSessionWidget.js';
import { NewChatWidget } from './newChatWidget.js';

interface INewChatViewOptions {
	readonly panelId: string;
	readonly selection: SessionsViewSelection;
	readonly createNewSession: () => void;
	readonly onDidChangeInfo: () => void;
}

/** Retains one Code surface and its provider scope when a draft acquires a durable Session identity. */
export class NewChatView extends Disposable implements ISessionsConversationPane {
	readonly element: HTMLElement;
	private readonly widget: NewChatWidget;
	private readonly info: SessionInfoRail;
	private visible = false;
	private viewStateResource: URI | undefined;

	constructor(
		container: HTMLElement,
		options: INewChatViewOptions,
		@ISessionProviderScopeService providerScopes: ISessionProviderScopeService,
		@IChatService chatService: IChatService,
		@ISessionsManagementService sessions: ISessionsManagementService,
		@ISessionsChatViewStateService private readonly viewStateService: ISessionsChatViewStateService,
	) {
		super();
		this.element = h(container.ownerDocument, 'div', { className: 'ash-sessions-chat-content' });
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));

		const { selection, panelId, createNewSession, onDidChangeInfo } = options;
		try {
			const scope = this._register(providerScopes.createScope(
				selection.kind === 'session' ? selection.active.session.sessionId : undefined,
				selection.kind === 'untitled' ? selection.session.providerId : undefined,
			));
			const model = scope.createInstance(ChatWidgetModel, chatService, selection, sessions);
			try {
				scope.registerInstance(ISessionContext, model);
				const log = scope.getOptional(ILogService);
				if (log) this._register(logSessionHistoryBinding(log, model.onDidFinishHistoryBinding));
				this.widget = this._register(scope.createInstance(model.isNestedDraft ? NewChatInSessionWidget : NewChatWidget,
					this.element, { panelId, model, createNewSession }));
			} catch (error) {
				model.dispose();
				throw error;
			}
			this.info = this._register(scope.createInstance(SessionInfoRail, this.element, model, () => this.widget.focus()));
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

	public get model(): ChatWidgetModel { return this.widget.model; }
	public get sessionId(): ISessionsConversationPane['sessionId'] { return this.widget.sessionId; }
	public get infoVisible(): boolean { return this.info.visible; }
	public toggleInfo(): void { this.info.toggle(); }
	public focus(): void { this.widget.focus(); }
	public saveState(): Promise<void> { return this.widget.saveState(); }
	public focusDraftPicker(picker: 'workspace' | 'environment'): void {
		if (picker === 'workspace') this.widget.focusWorkspacePicker();
		else this.widget.focusEnvironmentPicker();
	}
	public startVoiceConversation(): Promise<void> { return this.widget.startVoiceConversation(); }
	public addContext(...args: Parameters<ISessionsConversationPane['addContext']>): void { this.widget.addContext(...args); }
	acquireContext(...args: Parameters<ISessionsConversationPane['acquireContext']>): ReturnType<ISessionsConversationPane['acquireContext']> { return this.widget.acquireContext(...args); }
	public appendToDraft(...args: Parameters<ISessionsConversationPane['appendToDraft']>): void { this.widget.appendToDraft(...args); }
	public captureDraft(): ReturnType<ISessionsConversationPane['captureDraft']> { return this.widget.captureDraft(); }
	public restoreDraft(...args: Parameters<ISessionsConversationPane['restoreDraft']>): void { this.widget.restoreDraft(...args); }
	public setVisible(visible: boolean): void {
		if (!visible) this.saveConversationViewState();
		this.visible = visible;
		this.widget.setVisible(visible);
		this.info.setVisible(visible);
		this.restoreConversationViewState();
	}

	protected override disposeCore(): void {
		this.saveConversationViewState();
		super.disposeCore();
	}

	private saveConversationViewState(): void {
		if (this.visible && this.viewStateResource) {
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
