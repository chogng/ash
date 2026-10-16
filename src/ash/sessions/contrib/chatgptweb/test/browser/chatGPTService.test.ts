import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IStorageService } from '../../../../../platform/storage/common/storage.js';
import type { IChatGPTTransport } from '../../common/chatGPTTransport.js';
import { ChatGPTService } from '../../browser/chatGPTService.js';

function fixture(respond: (path: string, signal: AbortSignal) => Promise<Response>) {
	const requests = new Map<string, { controller: AbortController; reader?: ReadableStreamDefaultReader<Uint8Array>; }>();
	const transport: IChatGPTTransport = {
		async request(id, request) {
			const pending = { controller: new AbortController(), reader: undefined as ReadableStreamDefaultReader<Uint8Array> | undefined };
			requests.set(id, pending);
			const response = await respond(request.path, pending.controller.signal);
			pending.reader = response.body?.getReader();
			return { status: response.status, headers: Object.fromEntries(response.headers) };
		},
		async read(id) { const result = await requests.get(id)?.reader?.read(); return !result || result.done ? null : VSBuffer.wrap(new Uint8Array(result.value)); },
		async cancel(id) { const request = requests.get(id); requests.delete(id); request?.controller.abort(); await request?.reader?.cancel().catch(() => { }); },
	};
	const values = new Map<string, string>();
	return new ChatGPTService(transport, { get: (key: string) => values.get(key), store: (key: string, value: string) => { values.set(key, value); }, remove: (key: string) => { values.delete(key); } } as unknown as IStorageService);
}
function response(path: string): Response {
	assert.ok(!path.endsWith('/me'), 'The chat must not request an account identity');
	if (path.includes('/models?')) { return Response.json({ models: [{ slug: 'model', title: 'Model' }], default_model_slug: 'model' }); }
	if (path.includes('/conversations?')) { return Response.json({ items: [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }], total: 2 }); }
	const id = path.split('/').at(-1)!;
	return Response.json({ title: id, current_node: 'reply', mapping: { reply: { parent: null, message: { id: 'reply', author: { role: 'assistant' }, content: { parts: [id + ' reply'] } } } } });
}
suite('ChatGPT shared service', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('selection, catalog, messages and drafts have one owner across view lifetimes', async () => {
		using chat = fixture(async path => response(path));
		await chat.reload();
		assert.equal(chat.state.get().error, '');
		assert.equal(chat.state.get().conversations.length, 2);
		chat.setDraft('new draft');
		await chat.select('one'); chat.setDraft('one draft');
		await chat.select('two'); chat.setDraft('two draft');
		await chat.select('one');
		assert.equal(chat.state.get().draft, 'one draft');
		assert.equal(chat.state.get().conversationId, 'one');
		assert.equal(chat.state.get().messages[0]!.text, 'one reply');
		assert.match(chat.getAccessibleContent(), /one reply/);
		chat.newChat(); assert.equal(chat.state.get().draft, 'new draft');
		await chat.select('two'); assert.equal(chat.state.get().draft, 'two draft');
	});
	test('a superseded history cannot replace the selected chat or its draft', async () => {
		let finish!: () => void;
		let entered!: () => void;
		const started = new Promise<void>(resolve => entered = resolve);
		using chat = fixture(async path => {
			if (path.endsWith('/conversation/one')) { entered(); await new Promise<void>(resolve => finish = resolve); }
			return response(path);
		});
		await chat.reload();
		assert.equal(chat.state.get().error, '');
		const pending = chat.select('one'); await started;
		await chat.select('two'); chat.setDraft('keep two'); finish(); await pending;
		assert.equal(chat.state.get().conversationId, 'two');
		assert.equal(chat.state.get().draft, 'keep two');
		assert.equal(chat.state.get().messages[0]!.text, 'two reply');
	});
	test('retains messages and drafts across web request failures and subsequent recovery', async () => {
		let fail = false;
		using chat = fixture(async path => fail ? new Response(null, { status: 401 }) : response(path));
		chat.setDraft('new draft');
		await chat.reload();
		assert.equal(chat.state.get().draft, 'new draft');
		await chat.select('one'); chat.setDraft('conversation draft');
		const messages = chat.state.get().messages;
		fail = true; await chat.reload();
		assert.match(chat.state.get().error, /401/u);
		assert.equal(chat.state.get().connected, true);
		assert.equal(chat.state.get().draft, 'conversation draft');
		assert.equal(chat.state.get().conversationId, 'one');
		assert.equal(chat.state.get().messages, messages);
		fail = false; await chat.reload();
		assert.equal(chat.state.get().error, '');
		assert.equal(chat.state.get().draft, 'conversation draft');
		assert.equal(chat.state.get().conversationId, 'one');
		chat.newChat(); assert.equal(chat.state.get().draft, 'new draft');
	});
});
