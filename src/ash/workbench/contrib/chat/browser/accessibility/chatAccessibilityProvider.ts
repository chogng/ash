import { localize } from '../../../../../nls.js';
import type { IChatListItem } from '../../common/model/chatViewModel.js';

/** Message labels shared by the transcript and its plain-text presentation. */
export class ChatAccessibilityProvider {
	public getWidgetAriaLabel(): string {
		return localize('chat.transcript.label', 'Chat transcript');
	}

	public getAriaLabel(item: IChatListItem): string {
		if (item.label) return item.label;
		switch (item.type) {
			case 'voiceTranscript': return localize('chat.voice.transcript.label', 'Voice transcript');
			case 'hook': return 'Hook';
			case 'userMessage':
			case 'userContext':
			case 'userImage':
			case 'userImageAttachment':
			case 'userAudioAttachment':
				return localize('chat.transcript.you', 'You');
			case 'queuedMessage': return localize('chat.queue.pending', 'Queued');
			case 'historyRedo': return localize('chat.history.undoneMarker', 'Request undone');
			case 'agentMessage':
				return 'Ash';
			case 'reasoning':
				return item.transient ? localize('chat.thinking.active', 'Thinking…') : localize('chat.thinking.complete', 'Reasoning complete');
			case 'plan':
				return localize('chat.transcript.plan', 'Plan');
			case 'toolCall':
				return localize('chat.transcript.toolCall', 'Tool call');
			case 'toolResult':
				return item.isError ? localize('chat.transcript.toolError', 'Tool error') : localize('chat.transcript.toolResult', 'Tool result');
			case 'advisor':
				return localize('advisor.settings.title', 'Advisor');
			case 'turnError':
				return localize('chat.transcript.error', 'Error');
		}
	}
}
