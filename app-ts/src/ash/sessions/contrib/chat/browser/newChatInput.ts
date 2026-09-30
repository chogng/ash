import './media/chatInput.css';
import { h } from '../../../../base/browser/dom.js';
import { localize, onDidChangeNls } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { IDictationService } from '../../../../platform/dictation/common/dictationService.js';
import type { IChatWidgetModel } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import type { ChatInputDelegate } from '../../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { ChatInputPart } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import { ChatInputEditor } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputEditor.js';

/** Sessions owns its composer layout and editor policy while sharing input operations. */
export class NewChatInputWidget extends ChatInputPart {
	private readonly heading: HTMLHeadingElement;
	private submittedMessage = false;
	private displayedThreadId: string | undefined;

	constructor(
		container: HTMLElement,
		delegate: ChatInputDelegate,
		private readonly model: IChatWidgetModel,
		dictation: IDictationService | undefined,
		@IContextMenuService contextMenus: IContextMenuService,
		@IContextViewService contextViews: IContextViewService,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
		@INotificationService notifications: INotificationService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(container, {
			...delegate,
			send: async (text, skills, contexts) => {
				this.submittedMessage = true;
				this.updateConversation();
				try {
					await delegate.send(text, skills, contexts);
				} catch (error) {
					if (this.model.items.length === 0) {
						this.submittedMessage = false;
					}
					this.updateConversation();
					throw error;
				}
			},
		}, contextMenus, contextViews, accessibleViews, notifications, dictation, {
			create: options => instantiationService.createInstance(ChatInputEditor, {
				...options,
				height: { minimum: 48, maximum: 240 },
			}),
		});
		this.element.classList.add('ash-sessions-chat-input');
		this.heading = h(container.ownerDocument, 'h2');
		this.heading.className = 'ash-sessions-chat-welcome-heading';
		this.heading.textContent = localize('sessions.chat.welcome', 'What can we work on?');
		this.element.prepend(this.heading);
		this.displayedThreadId = model.threadId;
		this._register(model.onDidChange(() => {
			if (this.displayedThreadId !== model.threadId) {
				// Materializing the draft does not start another conversation; switching an existing Thread does.
				if (this.displayedThreadId !== undefined) {
					this.submittedMessage = false;
				}
				this.displayedThreadId = model.threadId;
			}
			this.updateConversation();
		}));
		this._register(onDidChangeNls(() => {
			this.heading.textContent = localize('sessions.chat.welcome', 'What can we work on?');
		}));
		this.updateConversation();
	}

	private updateConversation(): void {
		const hasConversation = this.submittedMessage || this.model.items.length > 0;
		this.element.classList.toggle('has-conversation', hasConversation);
		this.heading.hidden = hasConversation;
	}
}
