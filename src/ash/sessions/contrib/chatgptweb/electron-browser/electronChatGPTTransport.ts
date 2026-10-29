import { VSBuffer, encodeBase64 } from '../../../../base/common/buffer.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import type { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { chatGPTTransportChannel, type ChatGPTRequest, type ChatGPTResponse, type IChatGPTTransport } from '../common/chatGPTTransport.js';

/** Only ChatGPT HTTP requests cross this channel. Conversation and UI state remain in the contribution. */
export class ElectronChatGPTTransport implements IChatGPTTransport {
	private readonly channel: IChannel;
	constructor(@IMainProcessService mainProcess: IMainProcessService) {
		this.channel = mainProcess.getChannel(chatGPTTransportChannel);
	}
	request(id: string, request: ChatGPTRequest): Promise<ChatGPTResponse> {
		// Channel arguments are JSON; nested VSBuffer instances do not survive serialization.
		return this.channel.call('request', [id, request.body instanceof VSBuffer ? { ...request, body: { base64: encodeBase64(request.body) } } : request]);
	}
	read(id: string): Promise<VSBuffer | null> {
		return this.channel.call('read', [id]);
	}
	cancel(id: string): Promise<void> {
		return this.channel.call('cancel', [id]);
	}
}
