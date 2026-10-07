import './chatAttachmentWidgets.css';
import { h } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { IconLabel } from '../../../../../base/browser/ui/iconlabel/iconlabel.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';

/** Attachment DOM and its preview live as long as this exact draft entry. */
export class DefaultChatAttachmentWidget extends Disposable {
	public readonly domNode: HTMLElement;
	public readonly removeButton: Button;

	constructor(container: HTMLElement, public readonly attachment: ChatContextAttachment, remove: () => void) {
		super();
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'ash-chat-input-attachment-item';
		this.domNode.setAttribute('role', 'listitem');
		this.domNode.setAttribute('data-attachment-id', attachment.id);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		const type = attachment.kind === 'image' ? localize('chat.context.image', 'Image') : attachment.kind === 'file' ? localize('chat.context.file', 'File') : localize('chat.context.context', 'Context');
		const label = this._register(new IconLabel(this.domNode, { label: attachment.name, description: type, title: attachment.name }));
		label.element.classList.add('ash-chat-attachment-label');
		label.labelElement.classList.add('ash-chat-input-attachment-label');
		this.removeButton = this._register(new Button(this.domNode, {
			label: localize('chat.attach.remove', 'Remove {0}', attachment.name), icon: Lxicon.close, iconOnly: true, size: 'small',
		}));
		this._register(this.removeButton.onDidClick(remove));
	}
}

export class ImageAttachmentWidget extends DefaultChatAttachmentWidget {
	constructor(container: HTMLElement, attachment: ChatContextAttachment, remove: () => void) {
		super(container, attachment, remove);
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
