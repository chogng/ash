import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { NewChatContextAttachments } from './newChatContextAttachments.js';

/** File pastes are attachments; ordinary text pastes remain editor input. */
export class NewChatInputPasteTarget extends Disposable {
	constructor(container: HTMLElement, attachments: NewChatContextAttachments) {
		super();
		this._register(addDisposableListener(container, 'paste', event => {
			const files = [...(event.clipboardData?.files ?? [])];
			if (files.length === 0) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			void attachments.attachFiles(files);
		}, true));
	}
}
