import { h } from '../../../../../../base/browser/dom.js';
import type { ThreadGoal } from '../../../../../services/chat/common/chatService.js';
import { formatChatGoal } from '../../../common/model/chatViewModel.js';
import './media/chatGoalBannerWidget.css';

/** Presents the conversation model's current goal in the owning chat widget. */
export class ChatGoalBannerWidget {
	readonly domNode: HTMLDivElement;

	constructor(ownerDocument: Document) {
		this.domNode = h(ownerDocument, 'div', { className: 'ash-chat-goal-banner' });
		this.domNode.hidden = true;
	}

	setGoal(goal: ThreadGoal | undefined): void {
		this.domNode.hidden = !goal;
		this.domNode.textContent = goal ? formatChatGoal(goal) : '';
	}
}
