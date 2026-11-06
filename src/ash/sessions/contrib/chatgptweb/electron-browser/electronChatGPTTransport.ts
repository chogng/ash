import { VSBuffer, encodeBase64 } from '../../../../base/common/buffer.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import type { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ChatGPTAuthenticationError, chatGPTTransportChannel, chatGPTNativeTransportChannel, type ChatGPTAuthenticationContext, type ChatGPTRequest, type ChatGPTResponse, type IChatGPTTransport } from '../common/chatGPTTransport.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { isRecord } from '../../../../base/common/types.js';

/** Only ChatGPT HTTP requests cross this channel. Conversation and UI state remain in the contribution. */
export class ElectronChatGPTTransport extends Disposable implements IChatGPTTransport {
	private readonly channel: IChannel;
	private readonly authenticationChanges = this._register(new Emitter<void>());
	public readonly onDidChangeAuthentication = this.authenticationChanges.event;
	private context: Promise<ChatGPTAuthenticationContext> | undefined;
	private readonly requests = new Set<string>();
	constructor(@IMainProcessService mainProcess: IMainProcessService, readonly native?: true) {
		super();
		this.channel = mainProcess.getChannel(native ? chatGPTNativeTransportChannel : chatGPTTransportChannel);
		this._register(this.channel.listen<unknown>('authenticationChanged')(value => {
			const context = readContext(value);
			this.context = context ? Promise.resolve(context) : undefined;
			this.authenticationChanges.fire();
		}));
		this._register(toDisposable(() => {
			for (const id of this.requests) { void this.channel.call('cancel', [id]).catch(() => { }); }
			this.requests.clear();
		}));
	}
	private getContext(): Promise<ChatGPTAuthenticationContext> {
		if (!this.context) {
			const context = this.channel.call<unknown>('authenticationContext').then(value => {
				const snapshot = readContext(value);
				if (!snapshot) { throw new ChatGPTAuthenticationError('Authentication context is unavailable'); }
				return snapshot;
			});
			this.context = context;
			void context.catch(() => { if (this.context === context) { this.context = undefined; } });
		}
		return this.context;
	}
	async getCacheScope(): Promise<string | undefined> {
		this.assertNotDisposed();
		return (await this.getContext()).cacheScope;
	}
	async request(id: string, request: ChatGPTRequest): Promise<ChatGPTResponse> {
		this.assertNotDisposed();
		this.requests.add(id);
		const context = await this.getContext();
		if (this.isDisposed || !this.requests.has(id)) { throw new CancellationError(); }
		// Channel arguments are JSON; nested VSBuffer instances do not survive serialization.
		return this.channel.call('request', [id, request.body instanceof VSBuffer ? { ...request, body: { base64: encodeBase64(request.body) } } : request, context.id]);
	}
	read(id: string): Promise<VSBuffer | null> { return this.channel.call('read', [id]); }
	cancel(id: string): Promise<void> {
		// Disposal already cancels every owned request. Late stream cleanup must not
		// send a duplicate cancellation through a connection that may have closed.
		if (!this.requests.delete(id) || this.isDisposed) { return Promise.resolve(); }
		return this.channel.call('cancel', [id]);
	}
}

export class ElectronChatGPTNativeTransport extends ElectronChatGPTTransport {
	constructor(@IMainProcessService mainProcess: IMainProcessService) {
		super(mainProcess, true);
	}
}

function readContext(value: unknown): ChatGPTAuthenticationContext | undefined {
	if (!isRecord(value) || typeof value.id !== 'string' || !/^[a-f0-9]{32}$/u.test(value.id)) { return undefined; }
	const cacheScope = value.cacheScope;
	if (cacheScope !== undefined && (typeof cacheScope !== 'string' || !/^[a-f0-9]{64}$/u.test(cacheScope))) { return undefined; }
	return { id: value.id, cacheScope };
}
