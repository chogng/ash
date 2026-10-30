import { VSBuffer, encodeBase64 } from '../../../../base/common/buffer.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import type { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ChatGPTAuthenticationError, chatGPTTransportChannel, type ChatGPTRequest, type ChatGPTResponse, type IChatGPTTransport } from '../common/chatGPTTransport.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { CancellationError } from '../../../../base/common/errors.js';

/** Only ChatGPT HTTP requests cross this channel. Conversation and UI state remain in the contribution. */
export class ElectronChatGPTTransport extends Disposable implements IChatGPTTransport {
	private readonly channel: IChannel;
	private readonly authenticationChanges = this._register(new Emitter<void>());
	public readonly onDidChangeAuthentication = this.authenticationChanges.event;
	private context: Promise<string> | undefined;
	private readonly requests = new Set<string>();
	constructor(@IMainProcessService mainProcess: IMainProcessService) {
		super();
		this.channel = mainProcess.getChannel(chatGPTTransportChannel);
		this._register(this.channel.listen<unknown>('authenticationChanged')(value => {
			this.context = typeof value === 'string' && /^[a-f0-9]{32}$/u.test(value) ? Promise.resolve(value) : undefined;
			this.authenticationChanges.fire();
		}));
		this._register(toDisposable(() => {
			for (const id of this.requests) { void this.channel.call('cancel', [id]).catch(() => { }); }
			this.requests.clear();
		}));
	}
	async request(id: string, request: ChatGPTRequest): Promise<ChatGPTResponse> {
		this.assertNotDisposed();
		this.requests.add(id);
		if (!this.context) {
			const context = this.channel.call<unknown>('authenticationContext').then(value => {
				if (typeof value !== 'string' || !/^[a-f0-9]{32}$/u.test(value)) { throw new ChatGPTAuthenticationError('Authentication context is unavailable'); }
				return value;
			});
			this.context = context;
			void context.catch(() => { if (this.context === context) { this.context = undefined; } });
		}
		const context = await this.context;
		if (this.isDisposed || !this.requests.has(id)) { throw new CancellationError(); }
		// Channel arguments are JSON; nested VSBuffer instances do not survive serialization.
		return this.channel.call('request', [id, request.body instanceof VSBuffer ? { ...request, body: { base64: encodeBase64(request.body) } } : request, context]);
	}
	read(id: string): Promise<VSBuffer | null> { return this.channel.call('read', [id]); }
	cancel(id: string): Promise<void> { this.requests.delete(id); return this.channel.call('cancel', [id]); }
}
