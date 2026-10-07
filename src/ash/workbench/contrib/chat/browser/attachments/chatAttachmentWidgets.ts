import './chatAttachmentWidgets.css';
import { h } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { IconLabel } from '../../../../../base/browser/ui/iconlabel/iconlabel.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { Schemas } from '../../../../../base/common/network.js';
import { REVEAL_IN_EXPLORER_COMMAND_ID } from '../../../files/browser/fileConstants.js';
import { FOCUS_TERMINAL_COMMAND_ID } from '../../../terminal/common/terminal.js';
import { FOCUS_SEARCH_COMMAND_ID } from '../../../search/common/constants.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';

/** Attachment DOM and its preview live as long as this exact draft entry. */
export class DefaultChatAttachmentWidget extends Disposable {
	public readonly domNode: HTMLElement;
	public readonly removeButton: Button;

	constructor(container: HTMLElement, public readonly attachment: ChatContextAttachment, remove: () => void,
		@IOpenerService private readonly opener: IOpenerService,
		@ICommandService private readonly commands: ICommandService,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'ash-chat-input-attachment-item';
		this.domNode.setAttribute('role', 'listitem');
		this.domNode.setAttribute('data-attachment-id', attachment.id);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		const type = attachment.kind === 'image' ? localize('chat.context.image', 'Image') : attachment.kind === 'file' ? localize('chat.context.file', 'File') : localize('chat.context.context', 'Context');
		if (attachment.resource) {
			const open = this._register(new Button(this.domNode, {
				label: attachment.name, ariaLabel: localize('chat.context.open', 'Open {0}', attachment.name),
				title: attachment.resource.toString(), size: 'small', presentation: 'quiet',
			}));
			open.domNode.classList.add('ash-chat-attachment-open', 'ash-chat-input-attachment-label');
			this._register(open.onDidClick(() => { void this.openSource(); }));
		} else {
			const label = this._register(new IconLabel(this.domNode, { label: attachment.name, description: type, title: attachment.name }));
			label.element.classList.add('ash-chat-attachment-label');
			label.labelElement.classList.add('ash-chat-input-attachment-label');
		}
		this.removeButton = this._register(new Button(this.domNode, {
			label: localize('chat.attach.remove', 'Remove {0}', attachment.name), icon: Lxicon.close, iconOnly: true, size: 'small',
		}));
		this._register(this.removeButton.onDidClick(remove));
	}

	private async openSource(): Promise<void> {
		const resource = this.attachment.resource;
		if (!resource) return;
		try {
			if (resource.scheme === Schemas.internal && resource.authority === 'chat-session') {
				const parameters = new URLSearchParams(resource.query);
				const sessionId = parameters.get('sessionId');
				const threadId = parameters.get('threadId');
				if (sessionId && threadId) await this.navigation.openConversation(sessionId, threadId);
			} else if (resource.scheme === Schemas.internal && resource.authority === 'terminal') {
				const id = new URLSearchParams(resource.query).get('id');
				if (id) await this.commands.executeCommand(FOCUS_TERMINAL_COMMAND_ID, id);
			} else if (resource.scheme === Schemas.internal && resource.authority === 'search-results') {
				await this.commands.executeCommand(FOCUS_SEARCH_COMMAND_ID);
			} else if (this.attachment.kind === 'directory') {
				await this.commands.executeCommand(REVEAL_IN_EXPLORER_COMMAND_ID, resource);
			} else {
				await this.opener.open(resource, { fromUserGesture: true, openExternal: resource.scheme === Schemas.https || resource.scheme === Schemas.http });
			}
		} catch (error) {
			if (!this.isDisposed) this.notifications.error(localize('chat.context.openFailed', 'Could not open {0}: {1}', this.attachment.name, String(error)));
		}
	}
}

export class ImageAttachmentWidget extends DefaultChatAttachmentWidget {
	constructor(container: HTMLElement, attachment: ChatContextAttachment, remove: () => void,
		@IOpenerService opener: IOpenerService,
		@ICommandService commands: ICommandService,
		@IChatSessionNavigationService navigation: IChatSessionNavigationService,
		@INotificationService notifications: INotificationService,
	) {
		super(container, attachment, remove, opener, commands, navigation, notifications);
		const image = h(container.ownerDocument, 'img');
		image.className = 'ash-chat-attachment-image';
		image.alt = attachment.name;
		this.domNode.prepend(image);
		void attachment.resolve().then(context => {
			if (!this.isDisposed && /^data:image\/(png|jpeg|gif|webp);base64,/u.test(context.content)) {
				image.src = context.content;
			}
		}, () => {
			if (!this.isDisposed) { image.alt = localize('chat.context.previewFailed', 'Preview unavailable: {0}', attachment.name); }
		});
	}
}
