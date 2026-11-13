import { Disposable, type IDisposable } from '../../../base/common/lifecycle.js';
import type { ISessionsConversationPane } from './sessionView.js';
import type { ChatWidgetModel } from '../chatWidgetModel.js';

/** A retained pane releases its host-specific model bindings when the pane is closed. */
export class ScopedSessionConversationPane extends Disposable implements ISessionsConversationPane {
	constructor(private readonly pane: ISessionsConversationPane, scope: IDisposable, model: Pick<ChatWidgetModel, 'state' | 'items' | 'onDidChange'>) {
		super();
		this._register(scope);
		this._register(pane);
		const update = (): void => {
			const loading = model.state === 'loading';
			pane.element.querySelector(':scope > .ash-chat-transcript-viewport')?.setAttribute('aria-busy', String(loading));
		};
		this._register(model.onDidChange(update));
		update();
	}
	get element() { return this.pane.element; }
	get sessionId() { return this.pane.sessionId; }
	get model() { return this.pane.model; }
	get input() { return this.pane.input; }
	focus(): void { this.pane.focus(); }
	startVoiceConversation(): Promise<void> { return this.pane.startVoiceConversation(); }
	addContext(...args: Parameters<ISessionsConversationPane['addContext']>): void { this.pane.addContext(...args); }
	acquireContext(...args: Parameters<ISessionsConversationPane['acquireContext']>): ReturnType<ISessionsConversationPane['acquireContext']> { return this.pane.acquireContext(...args); }
	appendToDraft(...args: Parameters<ISessionsConversationPane['appendToDraft']>): void { this.pane.appendToDraft(...args); }
	captureDraft(): ReturnType<ISessionsConversationPane['captureDraft']> { return this.pane.captureDraft(); }
	restoreDraft(...args: Parameters<ISessionsConversationPane['restoreDraft']>): void { this.pane.restoreDraft(...args); }
	setVisible(visible: boolean): void { this.pane.setVisible(visible); }
}
