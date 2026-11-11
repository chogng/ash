import { h } from '../../../../../../base/browser/dom.js';
import type { ChatTurnErrorAction, IChatListItem } from '../../../common/model/chatViewModel.js';
import { ChatErrorContentPart } from './chatErrorContentPart.js';

/** Presents the recovery choices available for the failed provider request. */
export class ChatQuotaExceededPart extends ChatErrorContentPart {
	constructor(article: HTMLElement, item: Pick<IChatListItem, 'detail' | 'action' | 'secondaryAction'>,
		classPrefix: string, onAction: ((action: ChatTurnErrorAction) => void | Promise<void>) | undefined,
	) {
		const controls = h(article.ownerDocument, 'div', { className: 'ash-chat-quota-error-actions' });
		super(article, item, classPrefix, onAction, controls);
		if (item.secondaryAction) this.addAction(item.secondaryAction);
		if (controls.childElementCount) article.append(controls);
	}
}
