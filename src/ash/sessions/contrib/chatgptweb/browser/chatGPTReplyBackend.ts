import { ChatReplyError, type IChatReplyBackend } from '../../../common/chatReplyBackend.js';
import { ChatGPTAuthenticationError } from '../common/chatGPTTransport.js';
import { ChatGPTRequestError, type ChatGPTClient, type ChatGPTReplyRequest, type ChatGPTStreamUpdate } from './chatGPTClient.js';

export class ChatGPTReplyBackend implements IChatReplyBackend {
	constructor(private readonly client: ChatGPTClient) { }

	async *streamReply(request: ChatGPTReplyRequest, signal: AbortSignal, beforeSubmit?: () => Promise<void>): AsyncGenerator<ChatGPTStreamUpdate> {
		let acknowledged = false;
		try {
			for await (const update of this.client.send(request, signal, beforeSubmit)) {
				acknowledged = true;
				yield update;
			}
		} catch (error) {
			const disconnected = error instanceof ChatGPTAuthenticationError;
			const rejected = (!acknowledged && disconnected) || (error instanceof ChatGPTRequestError && error.status >= 400 && error.status < 500);
			if (error instanceof Error) {
				throw new ChatReplyError(error.message, rejected ? 'rejected' : 'uncertain', disconnected, { cause: error });
			}
			throw error;
		}
	}

	stopReply(remoteConversationId: string, remoteReplyId: string, signal: AbortSignal): Promise<void> {
		return this.client.stop(remoteConversationId, remoteReplyId, signal);
	}
}
