import { URI } from '../../../../../base/common/uri.js';
import type { ThemeIcon } from '../../../../../base/common/themables.js';
import type { IMarkdownString } from '../../../../../base/common/htmlContent.js';
import type { IOpenAgentsWindowOptions } from '../../../../../platform/native/common/nativeHost.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';
import type { IChatService } from '../../../../services/chat/common/chatService.js';
import { LocalChatSessionUri } from '../model/chatUri.js';

export type ChatContextIconPath = ThemeIcon | URI | { light: URI; dark: URI; };

/** Provider content is resolved into a draft snapshot before the input accepts it. */
export interface StringChatContextValue {
	value?: string;
	name?: string;
	modelDescription?: string;
	iconPath?: ChatContextIconPath;
	uri: URI;
	resourceUri?: URI;
	tooltip?: IMarkdownString;
	readonly commandId?: string;
	readonly handle: number;
}

export interface IChatRequestWorkspaceVariableEntry {
	readonly id: string;
	readonly name: string;
	readonly kind: 'workspace';
	readonly value: string;
	readonly modelDescription?: string;
}

export function createChatReferenceVariableEntry(
	sessionId: string,
	threadId: string,
	name: string,
	content: string,
): ChatContextAttachment {
	return {
		id: `session:${sessionId}:${threadId}`,
		kind: 'chatReference',
		name,
		resource: LocalChatSessionUri.forSession(sessionId, threadId),
		resolve: async () => ({ name, content }),
	};
}

/** Captures the same transcript for the picker and for a dropped conversation. */
export async function captureChatReference(
	chat: IChatService,
	conversation: { readonly sessionId: string; readonly threadId: string; readonly title: string; },
	signal: AbortSignal,
): Promise<ChatContextAttachment[]> {
	if (signal.aborted) return [];
	const { sessionId, threadId, title } = conversation;
	const snapshot = await chat.readThread(sessionId, threadId);
	if (signal.aborted) return [];
	const messages = snapshot.transcript.entries.flatMap(entry => {
		if (entry.type !== 'item' || entry.transient) return [];
		const item = entry.item;
		if (item.type === 'userMessage') return [`User: ${item.text}`];
		if (item.type === 'agentMessage') return [`Assistant: ${item.text}`];
		return [];
	}).join('\n\n');
	const content = `Conversation: ${title}\nSession: ${sessionId}\nThread: ${threadId}\n\n${messages.length > 100_000 ? `[Earlier messages omitted]\n${messages.slice(-100_000)}` : messages}`;
	return [createChatReferenceVariableEntry(sessionId, threadId, title, content)];
}

/** Rehydrates a frozen snapshot at the draft or clipboard boundary. */
export function restoreChatVariableEntry(entry: NonNullable<IOpenAgentsWindowOptions['draft']>['contexts'][number]): ChatContextAttachment {
	const { id, kind, name, content, reference, terminalSnapshot } = entry;
	const resource = entry.resource ? URI.parse(entry.resource) : undefined;
	const resolvedKind = kind === 'image' || kind === 'instruction' || kind === 'toolSelection' ? kind : undefined;
	return {
		id, kind, name, resource, reference, terminalSnapshot,
		resolve: async () => ({ name, content, ...(resolvedKind ? { kind: resolvedKind } : {}) }),
	};
}
