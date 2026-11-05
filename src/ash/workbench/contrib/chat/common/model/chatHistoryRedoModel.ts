import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import type { IChatService, Thread } from '../../../../services/chat/common/chatService.js';
import type { IChatListItem } from './chatViewModel.js';

/** Projects the backend's redo checkpoint while the conversation owns its subscription. */
export class ChatHistoryRedoModel extends Disposable {
	private request = 0;
	private checkpoint: IChatListItem['historyRedoTarget'];

	constructor(private readonly chat: IChatService, private readonly changed: () => void) {
		super();
	}

	reset(): void {
		this.request++;
		if (!this.checkpoint) return;
		this.checkpoint = undefined;
		this.changed();
	}

	async refresh(sessionId: string, threadId: string): Promise<void> {
		this.reset();
		const request = this.request;
		try {
			const history = await this.chat.readHistoryState(sessionId, threadId);
			if (this.isDisposed || request !== this.request || !history.canRedo) return;
			this.checkpoint = { sessionId, threadId, expectedSequence: history.sequence };
			this.changed();
		} catch {
			// The transcript remains readable when the optional history control is unavailable.
		}
	}

	item(thread: Thread | undefined): IChatListItem | undefined {
		const checkpoint = this.checkpoint;
		if (!checkpoint || thread?.status !== 'active' || thread.sessionId !== checkpoint.sessionId
			|| thread.threadId !== checkpoint.threadId || thread.sequence < checkpoint.expectedSequence) return undefined;
		return {
			id: `history-redo:${JSON.stringify([thread.sessionId, thread.threadId])}`,
			type: 'historyRedo', text: '', transient: false,
			label: localize('chat.history.undoneMarker', 'Request undone'),
			historyRedoTarget: { ...checkpoint, expectedSequence: thread.sequence },
		};
	}
}
