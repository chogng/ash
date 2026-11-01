import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { AccessibilitySignal, IAccessibilitySignalService } from '../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { IChatService } from '../../../../services/chat/common/chatService.js';

/** Window-scoped Chat feedback consumes canonical committed transitions once. */
export class ChatAccessibilityService extends Disposable {
	constructor(@IChatService chat: IChatService, @IAccessibilitySignalService signals: IAccessibilitySignalService) {
		super();
		// This is a bounded notification cursor, not a second copy of turn state.
		const cursors = new Map<string, number>();
		this._register(toDisposable(() => cursors.clear()));
		this._register(chat.onDidBecomeReady(() => cursors.clear()));
		this._register(chat.onDidUpdateThread(envelope => {
			if (envelope.update.type !== 'committed') { return; }
			const key = JSON.stringify([envelope.sessionId, envelope.threadId]);
			if (envelope.durableSequence <= (cursors.get(key) ?? -1)) { return; }
			cursors.delete(key);
			cursors.set(key, envelope.durableSequence);
			if (cursors.size > 100) { cursors.delete(cursors.keys().next().value!); }
			const event = envelope.update.event;
			if (event.type === 'turnAccepted') { void signals.playSignal(AccessibilitySignal.chatRequestSent); }
			if (event.type === 'turnCompleted' || event.type === 'turnFailed') { void signals.playSignal(AccessibilitySignal.chatResponseReceived); }
			if (event.type === 'interactionRequested' && event.interaction.request.type !== 'dynamicTool') {
				void signals.playSignal(AccessibilitySignal.chatUserActionRequired);
			}
		}));
	}
}
