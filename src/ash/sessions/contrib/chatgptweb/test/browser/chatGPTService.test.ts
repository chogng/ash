import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { chatGPTModelCatalog, simpleChatGPTModelCatalog } from '../../../../../../../test/fixtures/chatGPTModels.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IStorageService } from '../../../../../platform/storage/common/storage.js';
import type { ChatGPTRequest, IChatGPTTransport } from '../../common/chatGPTTransport.js';
import { ChatGPTService } from '../../browser/chatGPTService.js';

function fixture(respond: (path: string, signal: AbortSignal, request: ChatGPTRequest) => Promise<Response>) {
	const requests = new Map<string, { controller: AbortController; reader?: ReadableStreamDefaultReader<Uint8Array>; }>();
	const transport: IChatGPTTransport = {
		async request(id, request) {
			const pending = { controller: new AbortController(), reader: undefined as ReadableStreamDefaultReader<Uint8Array> | undefined };
			requests.set(id, pending);
			const response = await respond(request.path, pending.controller.signal, request);
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
	if (path.includes('/models?')) { return Response.json(simpleChatGPTModelCatalog([{ slug: 'model', title: 'Model' }])); }
	if (path.includes('/conversations?')) { return Response.json({ items: [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }], total: 2 }); }
	const id = path.split('/').at(-1)!;
	return Response.json({ title: id, current_node: 'reply', mapping: { reply: { parent: null, message: { id: 'reply', author: { role: 'assistant' }, content: { parts: [id + ' reply'] } } } } });
}
suite('ChatGPT shared service', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('all five presets send their mapped targets and family changes preserve the product level', async () => {
		const sent: Record<string, unknown>[] = [];
		let catalog = chatGPTModelCatalog();
		using chat = fixture(async (path, _signal, request) => {
			if (path.includes('/models?')) { return Response.json(catalog); }
			if (path.includes('/.headers/')) { return Response.json({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'fixture' }); }
			if (path.endsWith('/prepare')) {
				sent.push(JSON.parse(String(request.body)));
				return Response.json({ conduit_token: 'fixture' });
			}
			if (path.endsWith('/f/conversation')) {
				sent.push(JSON.parse(String(request.body)));
				return new Response('data: {"message":{"id":"reply","author":{"role":"assistant"},"content":{"parts":["Reply"]}}}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
			}
			return response(path);
		});
		await chat.reload();
		assert.equal(chat.state.get().model, 'latest');
		assert.equal(chat.state.get().modelPreset, '0');
		for (const [preset, model, effort] of [
			['0', 'gpt-6-instant', undefined], ['1', 'gpt-6-thinking', 'standard'], ['2', 'gpt-6-thinking', 'extended'],
			['6', 'gpt-6-thinking', 'max'], ['3', 'gpt-6-pro', undefined],
		] as const) {
			chat.setModelPreset(preset);
			chat.setModelPreset('unknown');
			assert.equal(chat.state.get().modelPreset, preset);
			chat.setDraft('Use selected preset');
			await chat.send();
			assert.ok(sent.slice(-2).every(body => body.model === model && body.thinking_effort === effort));
			if (effort === undefined) { assert.ok(sent.slice(-2).every(body => !('thinking_effort' in body))); }
		}
		assert.equal(sent.length, 10);
		chat.setModel('5.6');
		assert.equal(chat.state.get().modelPreset, '3');
		chat.setModelPreset('6');
		chat.setDraft('Use other family');
		await chat.send();
		assert.ok(sent.slice(-2).every(body => body.model === 'gpt-5-6-thinking' && body.thinking_effort === 'max'));
		catalog = chatGPTModelCatalog();
		catalog.versions[1]!.intelligence_presets = catalog.versions[1]!.intelligence_presets.filter(preset => preset.id !== 6);
		await chat.reload();
		assert.equal(chat.state.get().modelPreset, '0');
	});

	test('history routing models and effort restore the matching family and product preset', async () => {
		using chat = fixture(async path => {
			if (path.includes('/models?')) { return Response.json(chatGPTModelCatalog()); }
			if (path.includes('/conversation/')) {
				return Response.json({
					default_model_slug: path.endsWith('/three') ? 'gpt-5-6-pro' : 'gpt-6-thinking', current_node: 'reply', mapping: {
						reply: {
							parent: null, message: {
								id: 'reply', author: { role: 'assistant' }, content: { parts: ['Reply'] }, metadata: { thinking_effort: path.endsWith('/one') ? 'max' : 'unsupported' },
							}
						}
					},
				});
			}
			return response(path);
		});
		await chat.reload();
		await chat.select('one');
		assert.equal(chat.state.get().model, 'latest');
		assert.equal(chat.state.get().modelPreset, '6');
		await chat.select('two');
		assert.equal(chat.state.get().modelPreset, '1');
		await chat.select('three');
		assert.equal(chat.state.get().model, '5.6');
		assert.equal(chat.state.get().modelPreset, '3');
	});

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
