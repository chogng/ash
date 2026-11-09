export const conversationShareMaxBytes = 10 * 1024 * 1024;
export const conversationShareMaxMessages = 10_000;
export const conversationShareRetentionDays = 30;
export const conversationShareId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ConversationShareMessage {
	readonly role: 'user' | 'assistant';
	readonly text: string;
	readonly timestamp?: number;
}

/** Public, read-only message data. Live conversation and tool identities never cross this boundary. */
export interface ConversationShare {
	readonly version: 1;
	readonly title: string;
	readonly messages: readonly ConversationShareMessage[];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate and project at the public service boundary before retaining any user data. */
export function parseConversationShare(value: unknown): ConversationShare | undefined {
	if (!isObject(value) || value.version !== 1 || typeof value.title !== 'string' || value.title.length > 1024
		|| !Array.isArray(value.messages) || !value.messages.length || value.messages.length > conversationShareMaxMessages) return undefined;
	const messages: ConversationShareMessage[] = [];
	for (const message of value.messages as unknown[]) {
		if (!isObject(message) || message.role !== 'user' && message.role !== 'assistant' || typeof message.text !== 'string') return undefined;
		const timestamp = message.timestamp;
		if (timestamp !== undefined && (typeof timestamp !== 'number' || !Number.isFinite(new Date(timestamp).getTime()))) return undefined;
		messages.push({ role: message.role, text: message.text, timestamp });
	}
	return { version: 1, title: value.title, messages };
}
