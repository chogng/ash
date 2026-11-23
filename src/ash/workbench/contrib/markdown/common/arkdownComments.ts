import { isUuid, parseUuid } from '../../../../base/common/uuid.js';

export const DOCS_COMMENT_MAX_LENGTH = 8000;
export const DOCS_COMMENTS_MAX_SOURCE_LENGTH = 1024 * 1024;

export const enum DocsCommentState { Open = 'open', Resolved = 'resolved' }

export interface DocsCommentMessage {
	readonly id: string;
	readonly authorId: string;
	readonly body: string;
	readonly createdAt: number;
	readonly editedAt?: number;
}
export interface DocsCommentThread {
	readonly id: string;
	readonly state: DocsCommentState;
	readonly quote?: string;
	readonly messages: readonly DocsCommentMessage[];
}
export type DocsCommentEventPayload =
	| { readonly op: 'create'; readonly message: DocsCommentMessage; readonly quote?: string; }
	| { readonly op: 'reply'; readonly message: DocsCommentMessage; }
	| { readonly op: 'edit'; readonly messageId: string; readonly body: string; readonly editedAt: number; }
	| { readonly op: 'state'; readonly state: DocsCommentState; }
	| { readonly op: 'delete_message'; readonly messageId: string; }
	| { readonly op: 'delete_thread'; };
export type DocsCommentEvent = DocsCommentEventPayload & { readonly version: 1; readonly id: string; readonly threadId: string; readonly clock: number; };

/** Comments travel with the Markdown working copy, including undo, backup and
 * collaboration. Invalid or future metadata stays visible as an ordinary code block. */
export function readDocsCommentEvent(source: string): DocsCommentEvent | undefined {
	if (source.length > DOCS_COMMENTS_MAX_SOURCE_LENGTH) return undefined;
	const match = /^```ash-comments\r?\n([\s\S]*)\r?\n```(?:\r?\n)?$/u.exec(source);
	if (!match) return undefined;
	try { return decode(JSON.parse(match[1])); } catch { return undefined; }
}

export function writeDocsCommentEvent(event: DocsCommentEvent): string {
	const value = decode(event);
	if (!value) throw new TypeError('Invalid document comments');
	const source = '```ash-comments\n' + JSON.stringify(value) + '\n```\n';
	if (source.length > DOCS_COMMENTS_MAX_SOURCE_LENGTH) throw new RangeError('Document comments exceed the size limit');
	return source;
}

function decode(value: unknown): DocsCommentEvent | undefined {
	if (!record(value) || value.version !== 1 || !isUuid(value.id) || !isUuid(value.threadId)
		|| !Number.isSafeInteger(value.clock) || (value.clock as number) < 1 || (value.clock as number) >= Number.MAX_SAFE_INTEGER) return undefined;
	const base = { version: 1 as const, id: parseUuid(value.id), threadId: parseUuid(value.threadId), clock: value.clock as number };
	switch (value.op) {
		case 'create': case 'reply': {
			const message = value.message;
			if (!record(message) || !isUuid(message.id) || !isUuid(message.authorId) || !body(message.body) || !timestamp(message.createdAt)) return undefined;
			if (value.op === 'create' && value.quote !== undefined && (typeof value.quote !== 'string' || value.quote.length > 1000)) return undefined;
			return {
				...base, op: value.op, message: { id: parseUuid(message.id), authorId: parseUuid(message.authorId), body: message.body, createdAt: message.createdAt },
				...(value.op === 'create' && typeof value.quote === 'string' ? { quote: value.quote } : {})
			};
		}
		case 'edit':
			return isUuid(value.messageId) && body(value.body) && timestamp(value.editedAt) ? { ...base, op: 'edit', messageId: parseUuid(value.messageId), body: value.body, editedAt: value.editedAt } : undefined;
		case 'delete_message':
			return isUuid(value.messageId) ? { ...base, op: 'delete_message', messageId: parseUuid(value.messageId) } : undefined;
		case 'state':
			return value.state === DocsCommentState.Open || value.state === DocsCommentState.Resolved ? { ...base, op: 'state', state: value.state } : undefined;
		case 'delete_thread': return { ...base, op: 'delete_thread' };
		default: return undefined;
	}
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function timestamp(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000; }
function body(value: unknown): value is string { return typeof value === 'string' && !!value.trim() && value.length <= DOCS_COMMENT_MAX_LENGTH; }
