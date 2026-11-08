import { URI } from '../../../../../base/common/uri.js';
import type { ThemeIcon } from '../../../../../base/common/themables.js';
import type { IMarkdownString } from '../../../../../base/common/htmlContent.js';
import type { IOpenAgentsWindowOptions } from '../../../../../platform/native/common/nativeHost.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';
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
): ChatContextAttachment {
	return {
		id: `session:${sessionId}:${threadId}`,
		kind: 'chatReference',
		name,
		resource: LocalChatSessionUri.forSession(sessionId, threadId),
		resolve: async () => ({ name, content: '', chatReference: { sessionId, threadId } }),
	};
}

/** Legacy conversation attachments retain their original captured content. */
export function restoreChatVariableEntry(entry: NonNullable<IOpenAgentsWindowOptions['draft']>['contexts'][number]): ChatContextAttachment {
	const { id, kind, name, content, reference, terminalSnapshot } = entry;
	const resource = entry.resource ? URI.parse(entry.resource) : undefined;
	if (entry.chatReference) {
		const source = resource && LocalChatSessionUri.parse(resource);
		if (!source) throw new TypeError('Invalid chat reference source');
		return { ...createChatReferenceVariableEntry(source.sessionId, source.threadId, name), id, reference };
	}
	const resolvedKind = kind === 'image' || kind === 'instruction' || kind === 'toolSelection' ? kind : undefined;
	return {
		id, kind, name, resource, reference, terminalSnapshot,
		resolve: async () => ({ name, content, ...(resolvedKind ? { kind: resolvedKind } : {}) }),
	};
}
