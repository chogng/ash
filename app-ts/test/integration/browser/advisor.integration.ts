import { createTestEditorServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { ChatListWidget } from '../../../src/ash/workbench/contrib/chat/browser/widget/chatListWidget.js';
import { chatTranscriptListItems, type IChatListItem } from '../../../src/ash/workbench/contrib/chat/browser/widget/chatListItems.js';
import type { ThreadTranscriptEntry } from '../../../src/ash/workbench/services/chat/common/chatService.js';
import { formatNlsMessage, setNlsResolver } from '../../../src/ash/nls.js';
import { builtinLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';

const locale = new URLSearchParams(window.location.search).get('locale');
if (locale) {
	const catalog = builtinLanguagePackCatalogs.find(candidate => candidate.locale === locale)!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, parameters));
}

const container = document.createElement('main');
document.body.append(container);
const services = createTestEditorServices();
registerCodeEditorServices(services);
const widget = services.createInstance(ChatListWidget, container, {});
window.addEventListener('pagehide', () => { widget.dispose(); services.dispose(); }, { once: true });
widget.element.style.height = '160px';
widget.setVisible(true);
const entries: ThreadTranscriptEntry[] = [
	{ type: 'item', entryId: 'call', turnId: 'turn', transient: false, item: { type: 'toolCall', itemId: 'call', turnId: 'turn', toolCallId: 'consult', name: 'advisor', argumentsJson: '{"question":"Check cancellation"}' } },
	{ type: 'item', entryId: 'result', turnId: 'turn', transient: false, item: { type: 'toolResult', itemId: 'result', turnId: 'turn', toolCallId: 'consult', text: JSON.stringify({ status: 'reviewed', model: { provider: 'test', model: 'reviewer' }, advice: 'Check **cancellation** before writing.', question: 'Check cancellation', sourceSequence: 12, usage: { inputTokens: 120, outputTokens: 8 } }), isError: false } },
];
widget.render(chatTranscriptListItems(entries));
const refresh = document.createElement('button');
refresh.textContent = 'Refresh transcript';
refresh.addEventListener('click', () => widget.render(chatTranscriptListItems(entries)));
document.body.append(refresh);
const history: IChatListItem[] = Array.from({ length: 40 }, (_, index) => ({
	id: `message-${index}`,
	type: 'userMessage',
	text: `Message ${index}`,
	transient: false,
}));
const fill = document.createElement('button');
fill.textContent = 'Fill transcript';
fill.addEventListener('click', () => widget.render(history));
document.body.append(fill);
const prepend = document.createElement('button');
prepend.textContent = 'Prepend history';
prepend.addEventListener('click', () => widget.render([{ id: 'earlier', type: 'userMessage', text: 'Earlier message', transient: false }, ...history]));
document.body.append(prepend);

const policyStop = document.createElement('button');
policyStop.textContent = 'Show policy stop';
policyStop.addEventListener('click', () => widget.render(chatTranscriptListItems([{
	type: 'turnError',
	entryId: 'turn-error:policy-stop',
	turnId: 'policy-stop',
	error: { code: 'policyCircuitBreaker', message: 'Automatic review rejected three consecutive actions.', retryable: false },
}], 'policy-stop')));
document.body.append(policyStop);

const configuration = services.get((await import('../../../src/ash/platform/configuration/common/configuration.js')).IConfigurationService);
const codeBlockActions: readonly [string, () => Promise<void>][] = [
	['Show code reply', async () => {
		widget.element.style.width = '320px';
		widget.render([{ id: 'code-reply', type: 'agentMessage', text: `Regular text with \`inline code\`.\n\n\`\`\`ts\nconst value = "${'long value '.repeat(30)}";\n\`\`\``, transient: false }]);
	}],
	['Fill code history', async () => {
		widget.element.style.width = '320px';
		widget.render(Array.from({ length: 40 }, (_, index) => ({ id: `code-${index}`, type: 'agentMessage' as const, text: `Reply ${index}\n\n\`\`\`ts\nconst value = ${index};\n\`\`\``, transient: false })));
	}],
	['Update editor typography', async () => {
		await configuration.updateValue('editor.fontFamily', 'Courier New');
		await configuration.updateValue('editor.fontSize', 16);
		await configuration.updateValue('editor.lineHeight', 26);
	}],
	['Customize code blocks', async () => {
		await configuration.updateValue('chat.editor.fontFamily', 'Arial');
		await configuration.updateValue('chat.editor.fontSize', 20);
		await configuration.updateValue('chat.editor.lineHeight', 30);
	}],
	['Turn code wrap on', async () => { await configuration.updateValue('chat.editor.wordWrap', 'on'); }],
	['Restore code defaults', async () => {
		for (const key of ['chat.editor.fontFamily', 'chat.editor.fontSize', 'chat.editor.lineHeight', 'chat.editor.wordWrap']) await configuration.updateValue(key, undefined);
	}],
	['Use automatic editor line height', async () => {
		await configuration.updateValue('editor.fontSize', 18);
		await configuration.updateValue('editor.lineHeight', 0);
	}],
];
for (const [label, action] of codeBlockActions) {
	const button = document.createElement('button');
	button.textContent = label;
	button.addEventListener('click', () => { void action(); });
	document.body.append(button);
}
