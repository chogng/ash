/** A backend reports whether a failed send can be retried without duplicating a turn. */
export class ChatReplyError extends Error {
	constructor(
		message: string,
		readonly outcome: 'rejected' | 'uncertain',
		readonly disconnected: boolean,
		options: ErrorOptions,
	) {
		super(message, options);
	}
}

/** A confirmed backend attachment reference. */
export interface ChatReplyAttachment {
	readonly id: string;
	readonly name: string;
	readonly mimeType: string;
	readonly size: number;
	readonly width?: number;
	readonly height?: number;
}
export interface ChatReplyResource {
	readonly uri: string;
	readonly name: string;
	readonly kind: 'image' | 'audio' | 'video' | 'document' | 'html' | 'chart';
	readonly mimeType?: string;
	readonly frameOrigin?: string;
}
export interface ChatReplyReference { readonly id: string; readonly url: string; readonly title: string; readonly snippet: string; }
export interface ChatReplyMessage {
	readonly id: string;
	readonly role: 'user' | 'assistant';
	readonly text: string;
	/** Message time in Unix milliseconds. Older history may omit it. */
	readonly timestamp?: number;
	readonly resources?: readonly ChatReplyResource[];
	readonly references?: readonly ChatReplyReference[];
	/** Execution content stays in the conversation record, separate from answer Markdown. */
	readonly activity?: { readonly kind: 'call' | 'result' | 'progress'; readonly tool?: string; readonly failed: boolean; };
}

export interface ChatReplyRequest {
	readonly text: string;
	readonly model: string;
	readonly thinkingEffort?: string;
	readonly parentId: string;
	readonly conversationId?: string;
	readonly messageId: string;
	readonly files?: readonly ChatReplyAttachment[];
}

export interface ChatReplyUpdate {
	readonly conversationId?: string;
	readonly message?: ChatReplyMessage;
}

export interface IChatReplyBackend {
	streamReply(request: ChatReplyRequest, signal: AbortSignal): AsyncIterable<ChatReplyUpdate>;
	stopReply(remoteConversationId: string, remoteReplyId: string, signal: AbortSignal): Promise<void>;
}
