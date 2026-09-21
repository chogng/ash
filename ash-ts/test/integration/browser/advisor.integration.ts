import { ChatListWidget } from '../../../src/ash/workbench/contrib/chat/browser/list/chatListWidget.js';
import { chatTranscriptListItems } from '../../../src/ash/workbench/contrib/chat/browser/list/chatListItems.js';
import type { ThreadTranscriptEntry } from '../../../src/ash/workbench/services/chat/common/chatService.js';
import '../../../src/ash/workbench/contrib/chat/browser/media/chat.css';

const container = document.createElement('main');
document.body.append(container);
const widget = new ChatListWidget(container);
const entries: ThreadTranscriptEntry[] = [
	{ type: 'item', entryId: 'call', turnId: 'turn', transient: false, item: { type: 'toolCall', itemId: 'call', turnId: 'turn', toolCallId: 'consult', name: 'advisor', argumentsJson: '{"question":"Check cancellation"}' } },
	{ type: 'item', entryId: 'result', turnId: 'turn', transient: false, item: { type: 'toolResult', itemId: 'result', turnId: 'turn', toolCallId: 'consult', text: JSON.stringify({ status: 'reviewed', model: { provider: 'test', model: 'reviewer' }, advice: 'Check **cancellation** before writing.', question: 'Check cancellation', sourceSequence: 12, usage: { inputTokens: 120, outputTokens: 8 } }), isError: false } },
];
widget.render(chatTranscriptListItems(entries));
const refresh = document.createElement('button');
refresh.textContent = 'Refresh transcript';
refresh.addEventListener('click', () => widget.render(chatTranscriptListItems(entries)));
document.body.append(refresh);
