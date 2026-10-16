import type { VSBuffer } from '../../../../base/common/buffer.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

export const chatGPTTransportChannel = 'sessions.chatgpt.transport';

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
	request(id: string, request: ChatGPTRequest): Promise<ChatGPTResponse>;
	/** Pulling one chunk at a time keeps streamed replies bounded and preserves backpressure. */
	read(id: string): Promise<VSBuffer | null>;
	cancel(id: string): Promise<void>;
}

export const IChatGPTTransport = createServiceIdentifier<IChatGPTTransport>('chatGPTTransport');
