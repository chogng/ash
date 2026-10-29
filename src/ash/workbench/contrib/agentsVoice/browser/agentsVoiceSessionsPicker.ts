import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IChatSessionNavigationService } from '../../../services/chat/common/chatSessionNavigationService.js';

/** Navigates the session owner's catalog; it never changes a live media session's source. */
export class AgentsVoiceSessionsPicker extends Disposable {
	private readonly pickers = this._register(new DisposableStore());

	constructor(@IQuickInputService private readonly quickInput: IQuickInputService,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
		@INotificationService private readonly notifications: INotificationService,
	) { super(); }

	show(): void {
		this.pickers.clear();
		const lifetime = this.pickers.add(new DisposableStore());
		const picker = lifetime.add(this.quickInput.createQuickPick<IQuickPickItem & { readonly sessionId: string; readonly threadId: string; }>());
		const active = this.navigation.getActiveConversation();
		const items = this.navigation.getConversations().map(conversation => ({
			...conversation, label: conversation.title || localize('agentsVoice.untitled', 'Untitled conversation'),
			picked: conversation.sessionId === active?.sessionId && conversation.threadId === active.threadId,
		}));
		picker.placeholder = localize('agentsVoice.sessions.hint', 'Open a conversation to start voice there.');
		picker.ariaLabel = localize('agentsVoice.sessions', 'Conversations');
		picker.items = items;
		picker.activeItems = items.filter(item => item.picked);
		lifetime.add(picker.onDidAccept(() => {
			const selected = picker.activeItems[0];
			if (!selected) return;
			picker.hide();
			void this.navigation.openConversation(selected.sessionId, selected.threadId).catch(error => {
				if (!this.isDisposed) this.notifications.error(localize('agentsVoice.operationFailed', 'Voice conversation: {0}', String(error)));
			});
		}));
		lifetime.add(picker.onDidHide(() => this.pickers.clear()));
		picker.show();
	}
}
