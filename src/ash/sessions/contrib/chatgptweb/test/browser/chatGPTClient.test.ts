import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { ChatGPTClient, decodeChatGPTStream } from '../../browser/chatGPTClient.js';

const signal = (): AbortSignal => new AbortController().signal;
const json = (value: unknown): Response => Response.json(value);
const account = (): Response => Response.json({ id: 'fixture-user', name: 'Fixture' }, { headers: { 'X-Ash-ChatGPT-Account': 'synthetic-binding', 'X-Ash-ChatGPT-Account-Scope': 'fixture-scope' } });
const message = (id: string, role: string, text: string): object => ({ id, author: { role }, content: { content_type: 'text', parts: [text] } });
async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const value of values) { result.push(value); }
	return result;
}

suite('Bundled ChatGPT client', () => {
	test('reads only the selected branch and sends its actual parent and model', async () => {
		const calls: { path: string; init: RequestInit; }[] = [];
		const client = new ChatGPTClient((async (url, init = {}) => {
			const path = String(url);
			calls.push({ path, init });
			if (path.endsWith('/backend-api/me')) { return account(); }
			if (path.includes('/.headers/')) { return json({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'fixture-requirements', 'OpenAI-Sentinel-Proof-Token': 'fixture-proof', 'OpenAI-Sentinel-Turnstile-Token': 'fixture-vm' }); }
			if (path.endsWith('/f/conversation/prepare')) { return json({ status: 'ready', conduit_token: 'synthetic-conduit' }); }
			if (path.endsWith('/conversation/chat-one')) {
				return json({
					title: 'Chosen branch', current_node: 'reply-two', mapping: {
						root: { parent: null }, user: { parent: 'root', message: message('user', 'user', 'Question') },
						'reply-one': { parent: 'user', message: message('reply-one', 'assistant', 'Other branch') },
						'reply-two': { parent: 'user', message: message('reply-two', 'assistant', 'Selected answer') },
					}
				});
			}
			return new Response('data: {"conversation_id":"chat-one","message":{"id":"reply-three","author":{"role":"assistant"},"content":{"parts":["Next answer"]}}}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
		}) as typeof fetch);
		assert.deepEqual(await client.connect(signal()), { id: 'fixture-scope\0fixture-user', name: 'Fixture' });
		const history = await client.history('chat-one', signal());
		assert.deepEqual(history.messages.map(item => item.text), ['Question', 'Selected answer']);
		const output = await collect(client.send({ text: 'Follow up', model: 'fixture-model', parentId: history.parentId, conversationId: history.id, messageId: 'new-user' }, signal()));
		assert.equal(output[0]!.message!.text, 'Next answer');
		const sent = calls.at(-1)!;
		assert.equal(sent.path, '/service/backend-api/f/conversation');
		assert.equal(new Headers(sent.init.headers).get('Authorization'), null);
		assert.equal(new Headers(sent.init.headers).get('X-Ash-ChatGPT-Account'), 'synthetic-binding');
		assert.equal(new Headers(sent.init.headers).get('OpenAI-Sentinel-Chat-Requirements-Token'), 'fixture-requirements');
		assert.equal(new Headers(sent.init.headers).get('OpenAI-Sentinel-Proof-Token'), 'fixture-proof');
		assert.equal(new Headers(sent.init.headers).get('OpenAI-Sentinel-Turnstile-Token'), 'fixture-vm');
		const body = JSON.parse(String(sent.init.body));
		assert.equal(body.parent_message_id, 'reply-two');
		assert.equal(body.conversation_id, 'chat-one');
		assert.equal(body.model, 'fixture-model');
		assert.deepEqual(body.messages[0].content, { content_type: 'text', parts: ['Follow up'] });
	});

	test('never sends after verification is rejected or cancelled', async () => {
		let resolveVerification!: (response: Response) => void;
		let rejectVerification = true;
		let sent = 0;
		const client = new ChatGPTClient((async url => {
			const path = String(url);
			if (path.endsWith('/me')) { return account(); }
			if (path.endsWith('/prepare')) { return json({ conduit_token: 'fixture-conduit' }); }
			if (path.includes('/.headers/')) {
				return rejectVerification ? new Response(null, { status: 428 }) : new Promise<Response>(resolve => { resolveVerification = resolve; });
			}
			sent++;
			return new Response(null, { status: 500 });
		}) as typeof fetch);
		await client.connect(signal());
		const input = { text: 'Fixture', model: 'fixture', parentId: 'parent', messageId: 'user' };
		await assert.rejects(collect(client.send(input, signal())), /verification could not finish/u);
		rejectVerification = false;
		const controller = new AbortController();
		const pending = collect(client.send(input, controller.signal));
		while (!resolveVerification) { await new Promise<void>(resolve => setTimeout(resolve, 0)); }
		controller.abort();
		resolveVerification(json({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'unused' }));
		await assert.rejects(pending, { name: 'AbortError' });
		assert.equal(sent, 0);
	});

	test('decodes UTF-8 across chunks and v1 deltas without permitting prototype paths', async () => {
		const initial = { conversation_id: 'fixture', message: message('reply', 'assistant', '你') };
		const events = [
			'event: delta_encoding\ndata: "v1"',
			`event: delta\ndata: ${JSON.stringify({ p: '', o: 'add', v: initial })}`,
			`event: delta\ndata: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: '好' })}`,
			`event: delta\ndata: ${JSON.stringify({ p: '/__proto__/polluted', o: 'add', v: true })}`,
			'data: [DONE]',
		].join('\r\n\r\n') + '\r\n\r\n';
		const bytes = new TextEncoder().encode(events);
		const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) { controller.enqueue(Uint8Array.of(byte)); } controller.close(); } });
		const output = await collect(decodeChatGPTStream(stream, signal()));
		assert.equal(output[0]!.message!.text, '你');
		assert.equal(output[1]!.message!.text, '你好');
		assert.equal(Reflect.get(Object.prototype, 'polluted'), undefined);
	});

	test('surfaces a truncated stream and cancels the reader on interruption', async () => {
		const truncated = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {}\n\n')); controller.close(); } });
		await assert.rejects(collect(decodeChatGPTStream(truncated, signal())), /may already have been sent/u);
		let cancelled = false;
		const pending = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
		const controller = new AbortController();
		const iterator = decodeChatGPTStream(pending, controller.signal);
		const next = iterator.next();
		controller.abort();
		await assert.rejects(next);
		assert.equal(cancelled, true);
	});

	test('does not let stream deltas expand sparse arrays or assign array metadata', async () => {
		const initial = { conversation_id: 'fixture', message: message('reply', 'assistant', 'Safe') };
		const events = [
			initial,
			{ p: '/message/content/parts/100000', o: 'add', v: 'Sparse' },
			{ p: '/message/content/parts/length', o: 'replace', v: 200000 },
			{ p: '/message/content/parts/01', o: 'add', v: 'Invalid index' },
			{ p: '/message/content/parts/1', o: 'add', v: 'Next part' },
		].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n';
		const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(events)); controller.close(); } });
		assert.deepEqual((await collect(decodeChatGPTStream(stream, signal()))).map(update => update.message?.text), ['Safe', 'Safe', 'Safe', 'Safe', 'Safe\nNext part']);
	});

	test('clears expired credentials and does not replay a rejected send', async () => {
		let authenticated = false;
		let sends = 0;
		const client = new ChatGPTClient((async url => {
			if (String(url).endsWith('/backend-api/me')) { authenticated = true; return account(); }
			assert.equal(authenticated, true);
			sends++;
			return new Response(null, { status: 401 });
		}) as typeof fetch);
		await client.connect(signal());
		const input = { text: 'Synthetic prompt', model: 'fixture', parentId: 'parent', messageId: 'user' };
		await assert.rejects(collect(client.send(input, signal())), /401/u);
		await assert.rejects(collect(client.send(input, signal())), /local Codex login/u);
		assert.equal(sends, 1);
	});

	test('ignores late account results and authentication rejections after reconnecting', async () => {
		let pending!: (response: Response) => void;
		let delay = true;
		const client = new ChatGPTClient((async () => delay ? new Promise<Response>(resolve => { pending = resolve; }) : account()) as typeof fetch);
		const staleConnect = client.connect(signal());
		delay = false;
		await client.connect(signal());
		pending(account());
		await assert.rejects(staleConnect, { name: 'AbortError' });
		delay = true;
		const staleRequest = client.conversations(0, signal());
		delay = false;
		await client.connect(signal());
		pending(new Response(null, { status: 401 }));
		await assert.rejects(staleRequest, { name: 'AbortError' });
		// A stale 401 must not clear the newer connection.
		await assert.rejects(client.conversations(0, signal()), /unsupported response/u);
	});
});
