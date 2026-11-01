import { createUuid } from '../../../../../base/common/uuid.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IAppServerApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IChatService, type ThreadRead } from '../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService, withChatConversation } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { IChatWidgetService } from '../chat.js';

interface SavedTranscript {
	readonly format: 'ash.chat.transcript';
	readonly version: 1;
	readonly title: string;
	readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly text: string; readonly partial: boolean; }[];
}

const maxTranscriptBytes = 10 * 1024 * 1024;

function parseTranscript(content: string): SavedTranscript {
	const invalid = localize('chat.transfer.invalid', 'This file is not a supported Ash chat transcript.');
	if (new TextEncoder().encode(content).byteLength > maxTranscriptBytes) { throw new Error(localize('chat.transfer.tooLarge', 'The chat transcript exceeds the document limits: 10 MB, 10,000 messages and a 1,024-character title.')); }
	let value: unknown;
	try { value = JSON.parse(content); } catch { throw new TypeError(invalid); }
	if (!value || typeof value !== 'object') { throw new TypeError(invalid); }
	const data = value as Partial<SavedTranscript>;
	if (data.format !== 'ash.chat.transcript' || data.version !== 1 || typeof data.title !== 'string' || data.title.length > 1024
		|| !Array.isArray(data.messages) || data.messages.length > 10_000
		|| data.messages.some(message => !message || typeof message !== 'object' || (message.role !== 'user' && message.role !== 'assistant')
			|| typeof message.text !== 'string' || typeof message.partial !== 'boolean')) { throw new TypeError(invalid); }
	return data as SavedTranscript;
}

function snapshotTranscript(conversation: ThreadRead): SavedTranscript {
	const messages: SavedTranscript['messages'][number][] = [];
	for (const entry of conversation.transcript.entries) {
		if (entry.type === 'item' && (entry.item.type === 'userMessage' || entry.item.type === 'agentMessage')) {
			messages.push({ role: entry.item.type === 'userMessage' ? 'user' : 'assistant', text: entry.item.text, partial: entry.transient });
		} else if (entry.type === 'voiceTranscript') {
			messages.push({ role: entry.transcript.speaker === 'user' ? 'user' : 'assistant', text: entry.transcript.text, partial: false });
		}
	}
	return { format: 'ash.chat.transcript', version: 1, title: conversation.thread.title, messages };
}

/** Saved documents contain readable messages, never authority to resume or execute a Thread. */
export function registerChatExportActions(): DisposableStore {
	const store = new DisposableStore();
	store.add(registerAction2(class ExportChatAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.export', title: localize2('chat.transfer.export', 'Chat: Export Conversation Transcript'),
				f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true)
			});
		}
		public override async run(accessor: ServicesAccessor): Promise<void> {
			const navigation = accessor.get(IChatSessionNavigationService);
			const selected = accessor.get(IChatWidgetService).lastFocusedWidget ?? navigation.getActiveConversation();
			if (!selected?.sessionId || !selected.threadId) { return; }
			const { sessionId, threadId } = selected;
			const chat = accessor.get(IChatService);
			const dialogs = accessor.get(IFileDialogService);
			const files = accessor.get(IFileService);
			const connection = navigation.captureConnection?.(sessionId);
			let content = '';
			const capture = async (conversation: ThreadRead): Promise<void> => {
				const transcript = snapshotTranscript(conversation);
				content = JSON.stringify(transcript, null, 2);
				if (transcript.title.length > 1024 || transcript.messages.length > 10_000 || new TextEncoder().encode(content).byteLength > maxTranscriptBytes) {
					throw new Error(localize('chat.transfer.tooLarge', 'The chat transcript exceeds the document limits: 10 MB, 10,000 messages and a 1,024-character title.'));
				}
			};
			try {
				if (connection) {
					await connection.assertCurrent();
					const conversation = await chat.readThread(sessionId, threadId);
					await connection.assertCurrent();
					await capture(conversation);
				} else {
					await withChatConversation(chat, accessor.get(IAppServerApi), sessionId, threadId, capture);
				}
			} finally { connection?.dispose(); }
			const resource = await dialogs.showSaveDialog({
				title: localize('chat.transfer.export', 'Chat: Export Conversation Transcript'),
				filters: [{ name: localize('chat.transfer.file', 'Ash Chat Transcript'), extensions: ['json'] }]
			});
			if (resource) { await files.writeFile({ resource, content }); }
		}
	}));
	store.add(registerAction2(class ImportChatAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.import', title: localize2('chat.transfer.import', 'Chat: Open Saved Transcript (Read-Only)'),
				f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true)
			});
		}
		public override async run(accessor: ServicesAccessor): Promise<void> {
			const dialogs = accessor.get(IFileDialogService);
			const files = accessor.get(IFileService);
			const editors = accessor.get(IEditorService);
			const paths = await dialogs.showOpenDialog({
				canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
				title: localize('chat.transfer.import', 'Chat: Open Saved Transcript (Read-Only)'),
				filters: [{ name: localize('chat.transfer.file', 'Ash Chat Transcript'), extensions: ['json'] }]
			});
			if (!paths?.length) { return; }
			if ((await files.stat(paths[0])).sizeBytes > maxTranscriptBytes) { throw new Error(localize('chat.transfer.tooLarge', 'The chat transcript exceeds the document limits: 10 MB, 10,000 messages and a 1,024-character title.')); }
			const document = parseTranscript((await files.readFile(paths[0])).content);
			const content = document.messages.map(message => {
				const role = message.role === 'user' ? localize('chat.copyAll.user', 'User') : localize('chat.copyAll.assistant', 'Assistant');
				const partial = message.partial ? ` (${localize('chat.transfer.partial', 'partial')})` : '';
				return `## ${role}${partial}\n\n${message.text}`;
			}).join('\n\n');
			await editors.openEditor({
				resource: URI.from({ scheme: 'ash-chat-transcript', path: `/${createUuid()}.md` }),
				label: localize('chat.transfer.importedTitle', 'Saved Chat: {0}', document.title), languageId: 'markdown',
				readOnly: true, showBreadcrumbs: false, initialText: `# ${document.title}\n\n${content}`
			}, { pinned: true });
		}
	}));
	return store;
}
