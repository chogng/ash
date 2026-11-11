import { localize } from '../../../../../../nls.js';
import type { ToolResultPresentation } from '../../../../../../platform/agentHost/common/agent.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IChatSessionNavigationService } from '../../../../../services/chat/common/chatSessionNavigationService.js';
import { ChatSessionTargetResultPillSubPart } from './toolInvocationParts/chatSessionTargetResultPillSubPart.js';
import './media/chatSubagentOpenChat.css';

/** Adds the side-by-side destination to the originating-host conversation controls. */
export class ChatSubagentOpenChat extends ChatSessionTargetResultPillSubPart {
	constructor(document: Document, target: Extract<ToolResultPresentation, { type: 'sessionTarget'; }>, sourceSessionId: string,
		@IChatSessionNavigationService navigation: IChatSessionNavigationService,
		@INotificationService notifications: INotificationService,
	) {
		super(document, target, sourceSessionId, navigation, notifications);
		this.domNode.classList.add('ash-chat-subagent-navigation');
		this.controls.classList.add('ash-chat-subagent-navigation-actions');
		if (navigation.openToolResult && navigation.openSideConversation) {
			this.addOpenAction(localize('chat.subagent.openToSide', 'Open to the side'), true);
		}
	}
}
