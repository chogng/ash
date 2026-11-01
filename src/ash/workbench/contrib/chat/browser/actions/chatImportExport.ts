import { createUuid } from '../../../../../base/common/uuid.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { isRecord } from '../../../../../base/common/types.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IAppServerApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IChatService, type ThreadItem, type ThreadRead } from '../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService, withChatConversation } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { IChatWidgetService } from '../chat.js';
import { getToolSpecificDataDescription } from '../accessibility/chatResponseAccessibleView.js';

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
	// Provider call IDs may repeat in later Turns. Results enrich the original
	// call in place, without adding a second message at the result's position.
	const toolKey = (turnId: string, toolCallId: string): string => JSON.stringify([turnId, toolCallId]);
	const results = new Map(conversation.transcript.entries.flatMap(entry => entry.type === 'item' && entry.item.type === 'toolResult'
		? [[toolKey(entry.turnId, entry.item.toolCallId), entry.item] as const] : []));
	const stoppedTurns = new Set(conversation.thread.turns.filter(turn => turn.status === 'completed' || turn.status === 'failed' || turn.status === 'interrupted').map(turn => turn.turnId));
	for (const entry of conversation.transcript.entries) {
		if (entry.type === 'turnError') { stoppedTurns.add(entry.turnId); }
	}
	for (const entry of conversation.transcript.entries) {
		if (entry.type === 'item' && (entry.item.type === 'userMessage' || entry.item.type === 'agentMessage')) {
			messages.push({ role: entry.item.type === 'userMessage' ? 'user' : 'assistant', text: entry.item.text, partial: entry.transient });
		} else if (entry.type === 'item' && entry.item.type === 'toolCall') {
			const result = results.get(toolKey(entry.turnId, entry.item.toolCallId));
			const message = toolTranscriptMessage({ call: entry.item, result, stopped: stoppedTurns.has(entry.turnId) });
			if (message) { messages.push(message); }
		} else if (entry.type === 'voiceTranscript') {
			messages.push({ role: entry.transcript.speaker === 'user' ? 'user' : 'assistant', text: entry.transcript.text, partial: false });
		}
	}
	return { format: 'ash.chat.transcript', version: 1, title: conversation.thread.title, messages };
}

function toolTranscriptMessage({ call, result, stopped }: {
	readonly call: Extract<ThreadItem, { readonly type: 'toolCall'; }>;
	readonly result: Extract<ThreadItem, { readonly type: 'toolResult'; }> | undefined;
	readonly stopped: boolean;
}): SavedTranscript['messages'][number] | undefined {
	const partial = !result && !stopped;
	if (partial && (call.name === 'imagegen' || call.binding?.sourceChain.some(source => source.type === 'mcp' && source.remoteName === 'imagegen'))) { return undefined; }
	let exitCode: number | undefined;
	let error = result?.isError ? result.text : undefined;
	if (result && (call.name === 'shell-command' || call.binding?.activity?.type === 'command')) {
		// shell-command returns a successful tool envelope even when its process
		// exits unsuccessfully. Read only that envelope's status, never its output.
		let value: unknown;
		try { value = JSON.parse(result.text); } catch { /* Other tools and execution failures may return plain text. */ }
		if (isRecord(value) && value.tool === 'shell-command' && isRecord(value.result)
			&& typeof value.result.exit_code === 'number' && Number.isSafeInteger(value.result.exit_code)) {
			exitCode = value.result.exit_code;
			error = undefined;
		}
	}
	const failed = result?.isError || exitCode !== undefined && exitCode !== 0;
	let summary: string;
	if (result) {
		summary = failed ? localize('chat.tool.failed', '{0} · Failed', call.name) : localize('chat.tool.completed', '{0} · Completed', call.name);
	} else {
		summary = stopped ? localize('chat.tool.stopped', '{0} · No result', call.name) : localize('chat.tool.pending', '{0} · Awaiting result', call.name);
	}
	const sections = [summary, getToolSpecificDataDescription(call.binding?.activity)];
	if (call.argumentsJson) { sections.push(`${localize('chat.tool.input', 'Input')}\n${call.argumentsJson}`); }
	if (exitCode !== undefined && exitCode !== 0) { sections.push(localize('chat.transfer.toolExitCode', 'Tool execution failed with exit code {0}', exitCode)); }
	if (error) { sections.push(`${localize('chat.tool.error', 'Error')}\n${error}`); }
	return { role: 'assistant', text: sections.filter(Boolean).join('\n\n'), partial };
}

/** Saved documents contain readable messages, never authority to resume or execute a Thread. */
export function registerChatExportActions(): DisposableStore {
	const store = new DisposableStore();
	store.add(registerAction2(class ExportChatAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.export', title: localize2('chat.transfer.export', 'Chat: Export Conversation Transcript'),
				shortTitle: localize2('chat.transfer.export.label', 'Export Transcript…'),
				f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true),
				menu: { id: MenuId.ChatTitle, when: ChatContextKeys.enabled.isEqualTo(true), group: '1_cutcopypaste', order: 9 },
			});
		}
		public override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
			const navigation = accessor.get(IChatSessionNavigationService);
			const selected = context === undefined ? accessor.get(IChatWidgetService).lastFocusedWidget ?? navigation.getActiveConversation() : context;
			if (!selected || typeof selected !== 'object' || !('sessionId' in selected) || !('threadId' in selected)
				|| typeof selected.sessionId !== 'string' || !selected.sessionId || typeof selected.threadId !== 'string' || !selected.threadId) {
				return;
			}
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
