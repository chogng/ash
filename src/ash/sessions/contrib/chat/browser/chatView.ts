import { ILogService } from '../../../../platform/log/common/log.js';
import { logSessionHistoryBinding } from '../../../services/sessions/browser/sessionOpenTelemetryService.js';
import './media/chatView.css';
import { h } from '../../../../base/browser/dom.js';
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

/** Retains one Code surface and its provider scope when a draft acquires a durable Session identity. */
export class NewChatView extends Disposable implements ISessionsConversationPane {
	readonly element: HTMLElement;
	private widget!: NewChatWidget;
	private info!: SessionInfoRail;

	constructor(
		ownerDocument: Document,
		private readonly panelId: string,
		private readonly selection: SessionsViewSelection,
		private readonly createNewSession: () => void,
		private readonly onDidChangeInfo: () => void,
		@ISessionProviderScopeService private readonly providerScopes: ISessionProviderScopeService,
		@IChatService private readonly chatService: IChatService,
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
	) {
		super();
		this.element = h(ownerDocument, 'div', { className: 'ash-code-conversation' });
		this._register(toDisposable(() => this.element.remove()));
	}

	public render(parent: HTMLElement): void {
		parent.append(this.element);
		const selection = this.selection;
		const scope = this._register(this.providerScopes.createScope(
			selection.kind === 'session' ? selection.active.session.sessionId : undefined,
			selection.kind === 'untitled' ? selection.session.providerId : undefined,
		));
		const model = scope.createInstance(ChatWidgetModel, this.chatService,
			selection.kind === 'session' ? { kind: 'session', active: selection.active } : { kind: 'untitled', session: selection.session },
			this.sessions);
		scope.registerInstance(ISessionContext, model);
		const log = scope.getOptional(ILogService);
		if (log) this._register(logSessionHistoryBinding(log, model.onDidFinishHistoryBinding));
		try {
			this.widget = this._register(scope.createInstance(model.isNestedDraft ? NewChatInSessionWidget : NewChatWidget, this.element, this.panelId, model, this.createNewSession));
		} catch (error) {
			model.dispose();
			throw error;
		}
		this.info = this._register(scope.createInstance(SessionInfoRail, this.element, model, () => this.widget.focus()));
		this._register(this.info.onDidChange(this.onDidChangeInfo));
		const updateLoading = (): void => {
			this.widget.element.querySelector(':scope > .ash-chat-list-widget')?.setAttribute('aria-busy', String(model.state === 'loading'));
		};
		this._register(model.onDidChange(updateLoading));
		updateLoading();
	}

	public get model(): ChatWidgetModel { return this.widget.model; }
	public get sessionId(): ISessionsConversationPane['sessionId'] { return this.widget.sessionId; }
	public get infoVisible(): boolean { return this.info.visible; }
	public toggleInfo(): void { this.info.toggle(); }
	public focus(): void { this.widget.focus(); }
	public focusDraftPicker(picker: 'workspace' | 'environment'): void {
		if (picker === 'workspace') this.widget.focusWorkspacePicker();
		else this.widget.focusEnvironmentPicker();
	}
	public startVoiceConversation(): Promise<void> { return this.widget.startVoiceConversation(); }
	public addContext(...args: Parameters<ISessionsConversationPane['addContext']>): void { this.widget.addContext(...args); }
	public appendToDraft(...args: Parameters<ISessionsConversationPane['appendToDraft']>): void { this.widget.appendToDraft(...args); }
	public captureDraft(): ReturnType<ISessionsConversationPane['captureDraft']> { return this.widget.captureDraft(); }
	public restoreDraft(...args: Parameters<ISessionsConversationPane['restoreDraft']>): void { this.widget.restoreDraft(...args); }
	public setVisible(visible: boolean): void {
		this.widget.setVisible(visible);
		this.info.setVisible(visible);
	}
}
