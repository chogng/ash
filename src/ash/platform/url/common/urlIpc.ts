import type { Event } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
import { isRecord } from '../../../base/common/types.js';
import type { IChannel, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import type { IOpenURLOptions, IURLHandler } from './url.js';

/** The URI's encoded spelling crosses IPC intact, including callback query parameters. */
export class URLHandlerChannel implements IServerChannel {
	constructor(private readonly handler: IURLHandler) { }

	public async call<T>(_context: string, command: string, arg?: unknown): Promise<T> {
		if (command !== 'handleURL') {
			throw new Error(`Unknown URL operation: ${command}`);
		}
		if (!Array.isArray(arg) || arg.length !== 2 || typeof arg[0] !== 'string') {
			throw new TypeError('Invalid URL request');
		}
		const options: unknown = arg[1];
		if (options !== undefined && options !== null && (!isRecord(options)
			|| Object.keys(options).some(key => key !== 'trusted' && key !== 'originalUrl')
			|| (options.trusted !== undefined && typeof options.trusted !== 'boolean')
			|| (options.originalUrl !== undefined && typeof options.originalUrl !== 'string'))) {
			throw new TypeError('Invalid URL options');
		}
		return await this.handler.handleURL(URI.parse(arg[0], true), (options ?? undefined) as IOpenURLOptions | undefined) as T;
	}

	public listen<T>(_context: string, event: string): Event<T> {
		throw new Error(`Unknown URL event: ${event}`);
	}
}

export class URLHandlerChannelClient implements IURLHandler {
	constructor(private readonly channel: IChannel) { }

	public async handleURL(uri: URI, options?: IOpenURLOptions): Promise<boolean> {
		const result = await this.channel.call<unknown>('handleURL', [uri.toString(), options]);
		if (typeof result !== 'boolean') {
			throw new TypeError('Invalid URL response');
		}
		return result;
	}
}
