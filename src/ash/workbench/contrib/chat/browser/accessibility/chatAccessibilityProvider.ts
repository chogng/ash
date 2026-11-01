import { localize } from '../../../../../nls.js';
import type { IChatListItem } from '../widget/chatListItems.js';

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
			case 'agentMessage':
				return 'Ash';
			case 'reasoning':
				return localize('chat.transcript.reasoning', 'Reasoning');
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
