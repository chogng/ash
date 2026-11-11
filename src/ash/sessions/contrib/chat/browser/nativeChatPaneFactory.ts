import { ISessionProviderScopeService } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { ScopedSessionConversationPane } from '../../../browser/parts/scopedSessionConversationPane.js';
import type { SessionsViewSelection } from '../../../services/sessions/browser/sessionsService.js';
import type { ISessionsConversationPane } from '../../../browser/parts/sessionView.js';
import { NativeChatWidget } from './widget/nativeChatWidget.js';
import { AshChatModel } from './ashChatModel.js';
import { ReplyChatInputFactory } from './replyChatInput.js';
import type { ChatInputDelegate } from '../../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import type { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';

/** Composes the native Chat pane in the selected provider scope. */
export class NativeChatPaneFactory extends Disposable {
	constructor(
		@ISessionProviderScopeService private readonly providerScopes: ISessionProviderScopeService,
	) {
		super();
	}

	public createModel(selection: SessionsViewSelection, owner: DisposableStore): AshChatModel {
		const scope = owner.add(this.createScope(selection));
		return owner.add(this.instantiateModel(scope, selection));
	}

	public createPane(container: HTMLElement, panelId: string, selection: SessionsViewSelection, createNewSession: () => void): ISessionsConversationPane {
		const owner = new DisposableStore();
		let model: AshChatModel | undefined;
		try {
			const scope = owner.add(this.createScope(selection));
			model = this.instantiateModel(scope, selection);
			const inputModel = model;
			const inputs = scope.createInstance(ReplyChatInputFactory);
			const pane = scope.createInstance<NativeChatWidget<AshChatModel>>(NativeChatWidget, container, panelId, model, createNewSession,
				(inputContainer: HTMLElement, delegate: ChatInputDelegate) => inputs.createSessionInput(inputContainer, delegate, inputModel, owner));
			return new ScopedSessionConversationPane(pane, owner, model);
		} catch (error) { model?.dispose(); owner.dispose(); throw error; }
	}
	private createScope(selection: SessionsViewSelection): InstantiationService {
		return this.providerScopes.createScope(selection.kind === 'session' ? selection.active.session.sessionId : undefined, selection.kind === 'untitled' ? selection.session.providerId : undefined);
	}

	private instantiateModel(scope: InstantiationService, selection: SessionsViewSelection): AshChatModel {
		return scope.createInstance(AshChatModel, selection, 'session');
	}
}
