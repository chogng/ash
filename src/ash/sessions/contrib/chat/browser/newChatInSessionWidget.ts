import { localize } from '../../../../nls.js';
import { ChatInputNoticeLane } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputNoticeHost.js';
import { ChatInputNoticeVariant, ChatInputNoticeWidget } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputNoticeWidget.js';
import { NewChatWidget } from './newChatWidget.js';

/** Uses the shared Code composer while the child conversation is still an unsent draft. */
export class NewChatInSessionWidget extends NewChatWidget {
	protected override renderDraftNotice(container: HTMLElement): void {
		const message = localize('sessions.nestedChat.notice', 'Start a parallel conversation with the same Agent, code, and history.');
		const notice = this._register(new ChatInputNoticeWidget({
			container,
			variant: ChatInputNoticeVariant.Onboarding,
			ariaLabel: message,
			focusInput: () => this.input.focus(),
		}));
		notice.domNode.textContent = message;
		container.insertBefore(notice.domNode, this.input.inputContainerElement);
		notice.setVisible(false);
		const claim = this._register(this.input.noticeHost.occupy(ChatInputNoticeLane.Onboarding, {
			focusTarget: notice,
			onDidChangeLeading: leading => notice.setVisible(leading),
		}));
		this._register(this.model.onDidChange(() => {
			if (this.model.isNestedDraft) return;
			claim.dispose();
			notice.setVisible(false);
		}));
	}
}
