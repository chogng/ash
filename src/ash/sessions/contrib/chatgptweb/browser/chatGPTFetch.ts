import type { IChatGPTTransport } from '../common/chatGPTTransport.js';

/** Adapt the contribution's pull-based IPC transport to the client's HTTP/stream parser. */
export function createChatGPTFetch(transport: IChatGPTTransport): typeof fetch {
	return async (input, init) => {
		if (typeof input !== 'string' || (init?.body !== undefined && typeof init.body !== 'string')) { throw new TypeError('Invalid ChatGPT request'); }
		const id = crypto.randomUUID();
		const signal = init?.signal;
		signal?.throwIfAborted();
		let released = false;
		const release = () => {
			if (released) { return; }
			released = true;
			signal?.removeEventListener('abort', abort);
			void transport.cancel(id).catch(() => { });
		};
		const abort = () => release();
		signal?.addEventListener('abort', abort, { once: true });
		try {
			const response = await transport.request(id, {
				path: input, method: (init?.method ?? 'GET') as 'GET' | 'POST',
				headers: Object.fromEntries(new Headers(init?.headers)), body: init?.body as string | undefined,
			});
			signal?.throwIfAborted();
			if ([204, 205, 304].includes(response.status)) { release(); return new Response(null, response); }
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					try {
						signal?.throwIfAborted();
						const chunk = await transport.read(id);
						signal?.throwIfAborted();
						if (chunk === null) { release(); controller.close(); }
						else { controller.enqueue(new Uint8Array(chunk.buffer)); }
					} catch (error) { release(); controller.error(error); }
				},
				cancel: release,
			});
			return new Response(body, response);
		} catch (error) { release(); throw error; }
	};
}
