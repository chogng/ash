import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, type Event } from '../../../../../base/common/event.js';
import type { URI } from '../../../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../../../platform/instantiation/common/instantiation.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';

export type ChatImageAttachGesture = 'paste' | 'drop';
export interface IChatUserImageAttachmentEvent {
	readonly inputUri: URI;
	readonly attachmentIds: readonly string[];
	readonly gesture: ChatImageAttachGesture;
}
export interface IChatUserImageAttachmentService {
	readonly onDidAttachImages: Event<IChatUserImageAttachmentEvent>;
	didAttachImages(event: IChatUserImageAttachmentEvent): void;
}
export const IChatUserImageAttachmentService = createServiceIdentifier<IChatUserImageAttachmentService>('chatUserImageAttachmentService');

/** Diff only the accepted gesture; restored drafts and reference history never call this producer. */
export function getAddedImageIds(before: readonly ChatContextAttachment[], after: readonly ChatContextAttachment[]): string[] {
	const previous = new Set(before.map(attachment => attachment.id));
	return after.filter(attachment => attachment.kind === 'image' && !previous.has(attachment.id)).map(attachment => attachment.id);
}

export class ChatUserImageAttachmentService extends Disposable implements IChatUserImageAttachmentService {
	private readonly attached = this._register(new Emitter<IChatUserImageAttachmentEvent>());
	public readonly onDidAttachImages = this.attached.event;
	public didAttachImages(event: IChatUserImageAttachmentEvent): void {
		if (event.attachmentIds.length) { this.attached.fire(event); }
	}
}
