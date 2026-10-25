import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { chatGPTModelCatalog, simpleChatGPTModelCatalog } from '../../../../../../../test/fixtures/chatGPTModels.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IStorageService } from '../../../../../platform/storage/common/storage.js';
import type { ChatGPTRequest, IChatGPTTransport } from '../../common/chatGPTTransport.js';
import { ChatGPTService } from '../../browser/chatGPTService.js';

function fixture(respond: (path: string, signal: AbortSignal, request: ChatGPTRequest) => Promise<Response>, retained?: string) {
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
	const values = new Map<string, string>(retained ? [['sessions.chatgpt.conversation', retained]] : []);
	return new ChatGPTService(transport, { get: (key: string) => values.get(key), store: (key: string, value: string) => { values.set(key, value); }, remove: (key: string) => { values.delete(key); } } as unknown as IStorageService);
}
function response(path: string): Response {
	assert.ok(!path.endsWith('/me'), 'The chat must not request an account identity');
	if (path.includes('/models?')) { return Response.json(simpleChatGPTModelCatalog([{ slug: 'model', title: 'Model' }])); }
	if (path.includes('/pins?')) { return Response.json([]); }
	if (path.includes('/gizmos/snorlax/sidebar?')) { return Response.json({ items: [], cursor: null }); }
	if (path.includes('/conversations?')) { return Response.json({ items: [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }], total: 2 }); }
	const id = path.split('/').at(-1)!;
	return Response.json({ title: id, current_node: 'reply', mapping: { reply: { parent: null, message: { id: 'reply', author: { role: 'assistant' }, content: { parts: [id + ' reply'] } } } } });
}
suite('ChatGPT shared service', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	for (const navigation of ['history', 'new'] as const) {
		test(`leaving active voice for ${navigation} waits for persistence and retains the new history entry`, async () => {
			const entered = new DeferredPromise<void>(); const saved = new DeferredPromise<void>();
			using chat = fixture(async path => {
				if (path.startsWith('/service/realtime/vp?')) { return new Response('v=0\r\ns=Answer\r\n'); }
				if (path.endsWith('/conversation/created-voice')) {
					await entered.complete(); await saved.p;
					return Response.json({
						title: 'Saved voice conversation', current_node: 'voice-reply', mapping: {
							'voice-reply': { parent: null, message: { id: 'voice-reply', author: { role: 'assistant' }, content: { parts: ['Spoken reply'] } } },
						}
					});
				}
				return response(path);
			});
			const channel = { readyState: 'open', onmessage: undefined as ((event: { data: string; }) => void) | undefined, close() { this.readyState = 'closed'; } };
			class Peer {
				connectionState = 'new';
				localDescription: RTCSessionDescriptionInit | undefined;
				onconnectionstatechange: (() => void) | undefined;
				createDataChannel() { return channel; }
				addTrack() { } addTransceiver() { }
				async createOffer() { return { type: 'offer', sdp: 'v=0\r\ns=Offer\r\n' }; }
				async setLocalDescription(value: RTCSessionDescriptionInit) { this.localDescription = value; }
				async setRemoteDescription() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); }
				close() { this.connectionState = 'closed'; }
			}
			const track = { stop() { } }; const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
			const audio = { setAttribute() { }, async play() { }, pause() { }, remove() { } };
			const window = {
				RTCPeerConnection: Peer, document: { createElement: () => audio, body: { append() { } } },
				navigator: { userActivation: { isActive: true }, mediaDevices: { getUserMedia: async () => stream } },
			} as unknown as Window & typeof globalThis;
			await chat.reload(); await chat.startVoice(window);
			assert.equal(chat.state.get().voice, 'connected');
			channel.onmessage!({ data: JSON.stringify({ type: 'conversation_update', payload: { conversation_id: 'created-voice', parent_message_id: 'voice-reply' } }) });
			const moving = navigation === 'history' ? chat.select('two') : chat.newChat();
			await entered.p;
			assert.equal(chat.state.get().voice, 'stopping');
			assert.equal(chat.state.get().conversationId, 'created-voice');
			assert.equal(channel.readyState, 'closed');
			await saved.complete(); await moving; await chat.stopVoice(); await Promise.resolve();
			assert.equal(chat.state.get().voice, 'idle');
			assert.equal(chat.state.get().conversationId, navigation === 'history' ? 'two' : undefined);
			assert.equal(chat.state.get().conversations.find(item => item.id === 'created-voice')?.title, 'Saved voice conversation');
			await chat.select('created-voice');
			assert.equal(chat.state.get().messages[0]?.text, 'Spoken reply');
		});
	}
	test('pinned history merges once without advancing recent pagination, including after an archive', async () => {
		const offsets: number[] = [];
		using chat = fixture(async (path, _signal, request) => {
			if (request.method === 'PATCH') { return Response.json({ success: true }); }
			if (path.includes('/pins?')) { return Response.json([{ item: { id: 'old-pin', title: 'Old pin' } }, { item: { id: 'one', title: 'One' } }]); }
			if (path.includes('/gizmos/snorlax/sidebar?')) { return Response.json({ items: [{ gizmo: { id: 'g-p-project', display: { name: 'Project' } } }], cursor: null }); }
			if (path.includes('/conversations?')) {
				const query = new URL(path, 'https://test.invalid').searchParams;
				const offset = Number(query.get('offset')); offsets.push(offset);
				assert.equal(query.get('hide_snorlax'), 'false');
				return Response.json({ items: offset ? [{ id: 'three', title: 'Three', gizmo_id: 'g-p-project' }] : [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }], total: 3 });
			}
			return response(path);
		});
		await chat.reload();
		assert.deepEqual(chat.state.get().conversations.map(item => [item.id, item.pinned]), [['one', true], ['two', false], ['old-pin', true]]);
		assert.deepEqual(chat.state.get().projects, [{ id: 'g-p-project', title: 'Project' }]);
		await chat.archive('two');
		await chat.loadMore();
		assert.deepEqual(offsets, [0, 1]);
		assert.equal(chat.state.get().conversations.filter(item => item.id === 'one').length, 1);
		assert.equal(chat.state.get().conversations.find(item => item.id === 'three')?.projectId, 'g-p-project');
	});

	test('project and pin failures leave recent chats usable and report the error', async () => {
		using chat = fixture(async path => path.includes('/pins?') || path.includes('/gizmos/snorlax/sidebar?') ? new Response(null, { status: 503 }) : response(path));
		await chat.reload();
		assert.equal(chat.state.get().connected, true);
		assert.equal(chat.state.get().conversations.length, 2);
		assert.match(chat.state.get().error, /503/);
		await chat.select('one');
		assert.equal(chat.state.get().conversationId, 'one');
	});

	test('cold restore and followup remain usable when only the recent list is rate-limited', async () => {
		let sends = 0;
		using chat = fixture(async (path, _signal, request) => {
			if (path.includes('/conversations?')) { return new Response(null, { status: 429 }); }
			if (path.includes('/.headers/')) { return Response.json({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'proof' }); }
			if (path.endsWith('/prepare')) { return Response.json({ conduit_token: 'fixture' }); }
			if (path.endsWith('/f/conversation')) {
				const body = JSON.parse(String(request.body));
				assert.equal(body.conversation_id, 'one'); assert.equal(body.parent_message_id, 'reply'); sends++;
				return new Response('data: {"conversation_id":"one","message":{"id":"next","author":{"role":"assistant"},"content":{"parts":["Still connected"]}}}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
			}
			return response(path);
		}, 'one');
		await chat.reload();
		assert.equal(chat.state.get().connected, true);
		assert.equal(chat.state.get().conversationId, 'one');
		assert.equal(chat.state.get().messages[0]?.text, 'one reply');
		assert.equal(chat.state.get().conversations[0]?.id, 'one');
		assert.match(chat.state.get().error, /conversation list.*continue the current chat/u);
		chat.setDraft('Continue after reopening'); await chat.send();
		assert.equal(sends, 1); assert.equal(chat.state.get().error, '');
	});
	test('conversation actions commit after confirmation and keep drafts and selected title consistent', async () => {
		const writes: { method: string; path: string; body: unknown; }[] = [];
		let reject = false;
		using chat = fixture(async (path, _signal, request) => {
			if (request.method !== 'GET') {
				writes.push({ method: request.method, path, body: request.body ? JSON.parse(String(request.body)) : undefined });
				return reject ? new Response(null, { status: 500 }) : Response.json({ success: true });
			}
			return response(path);
		});
		await chat.reload();
		await chat.select('one');
		chat.setDraft('Keep my draft');
		await chat.rename('one', 'Renamed');
		assert.equal(chat.state.get().title, 'Renamed');
		assert.equal(chat.state.get().conversations[0]!.title, 'Renamed');
		await chat.setPinned('one', true);
		assert.equal(chat.state.get().conversations[0]!.pinned, true);
		await chat.moveToProject('one', 'g-p-project');
		assert.equal(chat.state.get().conversations[0]!.projectId, 'g-p-project');
		reject = true;
		await chat.archive('one');
		assert.equal(chat.state.get().conversations.length, 2);
		assert.equal(chat.state.get().conversationId, 'one');
		assert.equal(chat.state.get().draft, 'Keep my draft');
		assert.match(chat.state.get().error, /500/);
		reject = false;
		await chat.archive('one');
		assert.deepEqual(chat.state.get().conversations.map(item => item.id), ['two']);
		assert.equal(chat.state.get().conversationId, undefined);
		await chat.select('one');
		assert.equal(chat.state.get().draft, 'Keep my draft');
		await chat.deleteConversation('two');
		assert.equal(chat.state.get().conversations.length, 0);
		assert.deepEqual(writes.map(item => [item.method, item.body]), [
			['POST', { title: 'Renamed' }], ['PATCH', { is_starred: true }], ['PATCH', { gizmo_id: 'g-p-project' }],
			['PATCH', { is_archived: true }], ['PATCH', { is_archived: true }], ['DELETE', undefined],
		]);
		assert.ok(writes[0]!.path.endsWith('/conversation/id/one/rename'));
		assert.ok(writes.at(-1)!.path.endsWith('/conversation/id/two'));
	});

	test('pending management fences duplicate writes and navigation without aborting the accepted request', async () => {
		let finish!: () => void;
		let entered!: () => void;
		const started = new Promise<void>(resolve => entered = resolve);
		let writes = 0;
		using chat = fixture(async (path, signal, request) => {
			if (request.method === 'PATCH') {
				writes++; entered(); await new Promise<void>(resolve => finish = resolve);
				assert.equal(signal.aborted, false);
				return Response.json({ success: true });
			}
			return response(path);
		});
		await chat.reload(); await chat.select('one');
		const pending = chat.setPinned('one', true); await started;
		assert.equal(chat.state.get().managing, true);
		await chat.setPinned('one', true); await chat.select('two'); chat.newChat(); await chat.reload();
		assert.equal(writes, 1);
		assert.equal(chat.state.get().conversationId, 'one');
		finish(); await pending;
		assert.equal(chat.state.get().managing, false);
		assert.equal(chat.state.get().conversations[0]!.pinned, true);
	});

	test('project menus read every server page and share links reject a foreign origin', async () => {
		using chat = fixture(async (path, _signal, request) => {
			if (path.includes('/gizmos/snorlax/sidebar?')) {
				const next = new URL(path, 'https://test.invalid').searchParams.get('cursor');
				return Response.json({ items: [{ gizmo: { id: next ? 'g-p-two' : 'g-p-one', display: { name: next ? 'Two' : 'One' } } }], cursor: next ? null : 'next' });
			}
			if (request.method === 'POST' && path.endsWith('/share/v2/create')) { return Response.json({ share_url: 'https://other.test/share/one' }); }
			return response(path);
		});
		assert.deepEqual(await chat.listProjects(new AbortController().signal), [{ id: 'g-p-one', title: 'One' }, { id: 'g-p-two', title: 'Two' }]);
		await chat.reload();
		assert.equal(await chat.share('one'), undefined);
		assert.match(chat.state.get().error, /unsupported/);
	});

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

	test('completed turns retain the canonical continuation and sidebar entry without refetching a rate-limited catalog', async () => {
		let lists = 0;
		let turns = 0;
		const parents: string[] = [];
		using chat = fixture(async (path, _signal, request) => {
			if (path.includes('/conversations?')) {
				lists++;
				return lists > 1 ? new Response(null, { status: 429 }) : response(path);
			}
			if (path.includes('/.headers/')) { return Response.json({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'proof' }); }
			if (path.endsWith('/prepare')) { return Response.json({ conduit_token: 'fixture' }); }
			if (path.endsWith('/f/conversation')) {
				parents.push(JSON.parse(String(request.body)).parent_message_id);
				turns++;
				return new Response(`data: ${JSON.stringify({ conversation_id: 'created', message: { id: `reply-${turns}`, author: { role: 'assistant' }, content: { parts: ['Reply'] } } })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
			}
			if (path.endsWith('/conversation/created')) {
				return Response.json({
					title: 'New accepted conversation', current_node: `hidden-${turns}`, mapping: {
						[`reply-${turns}`]: { parent: null, message: { id: `reply-${turns}`, author: { role: 'assistant' }, content: { parts: ['Reply'] } } },
						[`hidden-${turns}`]: { parent: `reply-${turns}`, message: { id: `hidden-${turns}`, author: { role: 'assistant' }, content: { parts: [''] } } },
					}
				});
			}
			return response(path);
		});
		await chat.reload();
		chat.setDraft('First'); await chat.send();
		chat.setDraft('Follow up'); await chat.send();
		assert.equal(lists, 1);
		assert.equal(parents[1], 'hidden-1');
		assert.equal(chat.state.get().parentId, 'hidden-2');
		assert.equal(chat.state.get().error, '');
		assert.equal(chat.state.get().conversations[0]?.id, 'created');
		assert.equal(chat.state.get().conversations[0]?.title, 'New accepted conversation');
		assert.equal(chat.state.get().conversations.filter(item => item.id === 'created').length, 1);
		await chat.select('one'); await chat.select('created');
		assert.equal(chat.state.get().parentId, 'hidden-2');
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
