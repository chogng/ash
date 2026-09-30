import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';

/** Owns the attachments of one composer, including identity during an in-flight submission. */
export class ChatAttachmentModel extends Disposable {
	private readonly entries = new Map<string, ChatContextAttachment>();
	private readonly changes = this._register(new Emitter<void>());
	public readonly onDidChange = this.changes.event;

	public get attachments(): readonly ChatContextAttachment[] {
		return [...this.entries.values()];
	}

	public get size(): number {
		return this.entries.size;
	}

	public addContext(...attachments: ChatContextAttachment[]): void {
		for (const attachment of attachments) {
			this.entries.set(attachment.id, attachment);
		}
		this.changes.fire();
	}

	public delete(...ids: string[]): void {
		let changed = false;
		for (const id of ids) {
			changed = this.entries.delete(id) || changed;
		}
		if (changed) {
			this.changes.fire();
		}
	}

	public clear(): void {
		if (this.entries.size === 0) {
			return;
		}
		this.entries.clear();
		this.changes.fire();
	}
}
