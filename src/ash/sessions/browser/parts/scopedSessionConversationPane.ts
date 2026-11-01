import { Disposable } from '../../../base/common/lifecycle.js';
import type { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import type { ISessionsConversationPane } from './sessionView.js';
import type { ChatWidgetModel } from '../chatWidgetModel.js';

/** A retained pane releases its host-specific model bindings when the pane is closed. */
export class ScopedSessionConversationPane extends Disposable implements ISessionsConversationPane {
	constructor(private readonly pane: ISessionsConversationPane, scope: IInstantiationService, model: Pick<ChatWidgetModel, 'state' | 'items' | 'onDidChange'>) {
		super();
		this._register(scope);
		this._register(pane);
		const update = (): void => {
			const loading = model.state === 'loading';
			pane.element.querySelector(':scope > .ash-chat-list-widget, :scope > .ash-cowork-list-widget')?.setAttribute('aria-busy', String(loading));
		};
		this._register(model.onDidChange(update));
		update();
	}
	get element() { return this.pane.element; }
	get sessionId() { return this.pane.sessionId; }
	get model() { return this.pane.model; }
	focus(): void { this.pane.focus(); }
	startVoiceConversation(): Promise<void> { return this.pane.startVoiceConversation(); }
	addContext(...args: Parameters<ISessionsConversationPane['addContext']>): void { this.pane.addContext(...args); }
	appendToDraft(...args: Parameters<ISessionsConversationPane['appendToDraft']>): void { this.pane.appendToDraft(...args); }
	captureDraft(): ReturnType<ISessionsConversationPane['captureDraft']> { return this.pane.captureDraft(); }
	restoreDraft(...args: Parameters<ISessionsConversationPane['restoreDraft']>): void { this.pane.restoreDraft(...args); }
	setVisible(visible: boolean): void { this.pane.setVisible(visible); }
}
