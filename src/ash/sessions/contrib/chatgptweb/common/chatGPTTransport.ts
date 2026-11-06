import type { VSBuffer } from '../../../../base/common/buffer.js';
import type { Event } from '../../../../base/common/event.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

export const chatGPTTransportChannel = 'sessions.chatgpt.transport';

/** A local sign-in failure, carried by name across IPC without exposing credential contents. */
export class ChatGPTAuthenticationError extends Error {
	public override readonly name = 'ChatGPTAuthenticationError';
}

export interface ChatGPTAuthenticationContext {
	readonly id: string;
	readonly cacheScope?: string;
}

/** Transport data stays inside the ChatGPT client and its host adapter; UI consumers use ChatGPTService. */
export interface ChatGPTRequest {
	readonly path: string;
	readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: string | VSBuffer;
}

export interface ChatGPTResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
}

export interface IChatGPTTransport {
	readonly native?: true;
	readonly onDidChangeAuthentication?: Event<void>;
	getCacheScope(): Promise<string | undefined>;
	request(id: string, request: ChatGPTRequest): Promise<ChatGPTResponse>;
	/** Pulling one chunk at a time keeps streamed replies bounded and preserves backpressure. */
	read(id: string): Promise<VSBuffer | null>;
	cancel(id: string): Promise<void>;
}

export const chatGPTNativeTransportChannel = 'sessions.chatgpt.nativeTransport';
export const IChatGPTNativeTransport = createServiceIdentifier<IChatGPTTransport>('chatGPTNativeTransport');
export const IChatGPTTransport = createServiceIdentifier<IChatGPTTransport>('chatGPTTransport');

export const chatGPTHistoryCooldownMs = 60_000;

export function readChatGPTRetryAfter(value: string | null | undefined, now: number): number | undefined {
	const header = value?.trim() ?? '';
	const deadline = /^\d+$/u.test(header) ? now + Number(header) * 1000 : Date.parse(header);
	return Number.isSafeInteger(deadline) && deadline > now ? deadline : undefined;
}
