import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { autorun, observableFromEvent } from '../../../../../../base/common/observable.js';
import { localize } from '../../../../../../nls.js';
import { LocalChatSessionUri } from '../../../common/model/chatUri.js';
import { IChatSideChatService } from '../../../common/chatSideChatService.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { h } from '../../../../../../base/browser/dom.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import type { IChatWidgetModel } from '../chatWidget.js';
import './media/chatRequestOrigin.css';

/** Origin is read from the conversation model, so it survives reload without UI-owned metadata. */
export class ChatRequestOriginPart extends Disposable {
	constructor(
		container: HTMLElement,
		model: IChatWidgetModel,
		@IChatSideChatService sideChats: IChatSideChatService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		const node = h(container.ownerDocument, 'div', { className: 'ash-chat-side-chat-origin' });
		node.hidden = true;
		container.prepend(node);
		const button = this._register(new Button(node, { ...defaultButtonStyles, label: '', icon: Lxicon.arrowLeft, presentation: 'quiet' }));
		const current = observableFromEvent(this, model.onDidChange, () => model.sessionId && model.threadId ? LocalChatSessionUri.forSession(model.sessionId, model.threadId) : undefined);
		this._register(button.onDidClick(() => {
			const resource = current.get();
			if (resource) void sideChats.revealSideChatSource(resource).catch(error => notifications.error(error));
		}));
		this._register(autorun(reader => {
			const resource = current.read(reader);
			const origin = resource && sideChats.observeSideChatOrigin(resource).read(reader);
			node.hidden = !origin;
			button.label = origin?.sourceTitle ? localize('chat.btw.backTitle', 'Back to {0}', origin.sourceTitle) : localize('chat.btw.back', 'Back to Source Conversation');
		}));
		this._register(toDisposable(() => node.remove()));
	}
}
