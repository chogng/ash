import type { ChatGPTRequest, IChatGPTTransport } from '../common/chatGPTTransport.js';
import { VSBuffer } from '../../../../base/common/buffer.js';

/** Adapt the contribution's pull-based IPC transport to the client's HTTP/stream parser. */
export function createChatGPTFetch(transport: IChatGPTTransport): typeof fetch {
	return async (input, init) => {
		if (typeof input !== 'string') {
			throw new TypeError('Invalid ChatGPT request');
		}
		let requestBody: string | VSBuffer | undefined;
		const headers = new Headers(init?.headers);
		if (typeof init?.body === 'string') {
			requestBody = init.body;
		} else if (init?.body instanceof Blob) {
			requestBody = VSBuffer.wrap(new Uint8Array(await init.body.arrayBuffer()));
		} else if (init?.body instanceof FormData) {
			const form = new Request('https://chatgpt.com/', { method: 'POST', body: init.body });
			headers.set('Content-Type', form.headers.get('Content-Type')!);
			requestBody = VSBuffer.wrap(new Uint8Array(await form.arrayBuffer()));
		} else if (init?.body != null) {
			throw new TypeError('Invalid ChatGPT request body');
		}
		const id = crypto.randomUUID();
		const signal = init?.signal;
		signal?.throwIfAborted();
		let released = false;
		const release = () => {
			if (released) {
				return;
			}
			released = true;
			signal?.removeEventListener('abort', abort);
			void transport.cancel(id).catch(() => {});
		};
		const abort = () => release();
		signal?.addEventListener('abort', abort, { once: true });
		try {
			const response = await transport.request(id, {
				path: input,
				method: (init?.method ?? 'GET') as ChatGPTRequest['method'],
				headers: Object.fromEntries(headers),
				body: requestBody,
			});
			signal?.throwIfAborted();
			if ([204, 205, 304].includes(response.status)) {
				release();
				return new Response(null, response);
			}
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					try {
						signal?.throwIfAborted();
						const chunk = await transport.read(id);
						signal?.throwIfAborted();
						if (chunk === null) {
							release();
							controller.close();
						} else {
							controller.enqueue(new Uint8Array(chunk.buffer));
						}
					} catch (error) {
						release();
						controller.error(error);
					}
				},
				cancel: release,
			});
			return new Response(body, response);
		} catch (error) {
			release();
			throw error;
		}
	};
}
