import type { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { Thread } from '../../../../../workbench/services/chat/common/chatService.js';
import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { chatGPTModelCatalog, simpleChatGPTModelCatalog } from '../../../../../../../test/fixtures/chatGPTModels.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import type { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ChatGPTAuthenticationError, IChatGPTTransport, type ChatGPTRequest } from '../../common/chatGPTTransport.js';
import { ChatGPTService, IChatGPTService } from '../../browser/chatGPTService.js';
import { ElectronChatGPTTransport } from '../../electron-browser/electronChatGPTTransport.js';

function fixture(respond: (path: string, signal: AbortSignal, request: ChatGPTRequest) => Promise<Response>, retained?: string, onDidChangeAuthentication?: Event<void>, shared?: { values: Map<string, string>; instantiation: IInstantiationService; }) {
	const requests = new Map<string, { controller: AbortController; reader?: ReadableStreamDefaultReader<Uint8Array>; }>();
	const transport: IChatGPTTransport = {
		onDidChangeAuthentication,
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
	const values = shared?.values ?? new Map<string, string>(retained ? [['sessions.chatgpt.conversation', retained]] : []);
	return new ChatGPTService(transport, { get: (key: string) => values.get(key), keys: () => [...values.keys()], store: (key: string, value: string) => { values.set(key, value); }, remove: (key: string) => { values.delete(key); }, flush: async () => { } } as unknown as IStorageService, shared?.instantiation);
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
	test('closing the window scope cancels pending initialization without resolving disposed services or dispatching late requests', async () => {
		const ready = new DeferredPromise<string>();
		const entered = new DeferredPromise<void>();
		const cancellations: string[] = [];
		let requests = 0;
		const channel: IChannel = {
			listen: () => Event.None,
			call: <T>(command: string, args?: unknown): Promise<T> => {
				if (command === 'authenticationContext') { void entered.complete(); return ready.p as Promise<T>; }
				if (command === 'cancel') { cancellations.push((args as string[])[0]!); return Promise.resolve(undefined as T); }
				if (command === 'request') { requests++; }
				throw new Error(`Unexpected ChatGPT IPC operation: ${command}`);
			},
		};
		using services = new InstantiationService(new ServiceCollection(
			[IChatGPTTransport, new SyncDescriptor(ElectronChatGPTTransport, [], true)],
			[IChatGPTService, new SyncDescriptor(ChatGPTService, [], true)],
			[IStorageService, { get: () => undefined, keys: () => [], store() { }, remove() { } } as unknown as IStorageService],
			[IMainProcessService, { _serviceBrand: undefined, getChannel: () => channel, registerChannel() { } }],
		));
		const chat = services.get(IChatGPTService);
		const pending = chat.reload();
		await entered.p;
		services.dispose();
		await ready.error(new Error('IPC connection closed'));
		await pending;
		assert.equal(requests, 0);
		assert.equal(cancellations.length, 4);
		assert.equal(new Set(cancellations).size, 4);
	});

	test('account changes discard old history and file bindings, cancel a pending read and preserve local draft text', async () => {
		using changes = new Emitter<void>();
		const entered = new DeferredPromise<void>();
		const release = new DeferredPromise<void>();
		const restored = new DeferredPromise<void>();
		let account = 'old';
		let oldSignal: AbortSignal | undefined;
		using chat = fixture(async (path, signal) => {
			if (account === 'old' && path.endsWith('/two')) { oldSignal = signal; await entered.complete(); await release.p; }
			if (account === 'new' && path.includes('/conversations?')) { return Response.json({ items: [{ id: 'new-account-chat', title: 'New account chat' }], total: 1 }); }
			return response(path);
		}, undefined, changes.event);
		await chat.reload(); await chat.select('one');
		chat.setDraft('Local unsent draft');
		const oldRead = chat.select('two');
		await entered.p;
		using listener = chat.state.onDidChange(state => { if (state.connected && state.conversations[0]?.id === 'new-account-chat') { void restored.complete(); } });
		account = 'new';
		changes.fire();
		assert.ok(oldSignal?.aborted);
		assert.deepEqual(chat.state.get().messages, []);
		assert.deepEqual(chat.state.get().attachments, []);
		assert.equal(chat.state.get().conversationId, undefined);
		assert.equal(chat.state.get().draft, 'Local unsent draft');
		await restored.p;
		await release.complete(); await oldRead;
		assert.equal(chat.state.get().conversationId, undefined);
		assert.equal(chat.state.get().conversations[0]?.id, 'new-account-chat');
		assert.equal(chat.state.get().error, '');
		assert.doesNotMatch(chat.getAccessibleContent(), /one reply|two reply/u);
	});
	test('a local sign-in failure preserves an unsent draft without reporting an HTTP rejection or an uncertain reply', async () => {
		let unavailable = false;
		using chat = fixture(async path => {
			if (unavailable) { throw new ChatGPTAuthenticationError('sanitized host failure'); }
			return response(path);
		});
		await chat.reload();
		chat.setDraft('Unsent message');
		const before = chat.state.get();
		unavailable = true;
		await chat.send();
		const after = chat.state.get();
		assert.equal(after.draft, 'Unsent message');
		assert.deepEqual(after.messages, before.messages);
		assert.equal(after.parentId, before.parentId);
		assert.equal(after.uncertain, false);
		assert.equal(after.sending, false);
		assert.match(after.error, /sign-in is unavailable/u);
		assert.doesNotMatch(after.error, /401|sanitized host failure/u);
		assert.ok(chat.getAccessibleContent().includes(after.error));
	});

	test('reopening retries failed initialization without duplicating pending or successful loads', async () => {
		let rejected = true;
		let modelRequests = 0;
		let pending = new DeferredPromise<void>();
		let completed = new DeferredPromise<void>();
		using chat = fixture(async path => {
			if (path.includes('/models?')) {
				modelRequests++;
				await pending.p;
				if (rejected) { return new Response(null, { status: 401 }); }
			}
			return response(path);
		});
		using listener = chat.state.onDidChange(state => {
			if (!state.busy) { void completed.complete(); }
		});

		chat.initialize();
		chat.initialize();
		assert.equal(modelRequests, 1);
		await pending.complete();
		await completed.p;
		assert.equal(chat.state.get().connected, false);
		assert.match(chat.state.get().error, /401/u);

		rejected = false;
		pending = new DeferredPromise<void>();
		completed = new DeferredPromise<void>();
		chat.initialize();
		chat.initialize();
		assert.equal(modelRequests, 2);
		await pending.complete();
		await completed.p;
		assert.equal(chat.state.get().connected, true);
		assert.equal(chat.state.get().error, '');
		assert.equal(chat.state.get().model, 'model');
		assert.deepEqual(chat.state.get().conversations.map(item => item.id), ['one', 'two']);

		chat.initialize();
		assert.equal(modelRequests, 2);
	});

	test('New while the first authentication/catalog read is pending keeps initialization alive', async () => {
		const ready = new DeferredPromise<void>();
		const connected = new DeferredPromise<void>();
		const signals: AbortSignal[] = [];
		using chat = fixture(async (path, signal) => {
			if (path.includes('/models?')) { signals.push(signal); await ready.p; }
			return response(path);
		});
		using listener = chat.state.onDidChange(state => { if (state.connected) { void connected.complete(); } });
		chat.initialize();
		chat.newChat();
		assert.equal(signals.length, 2);
		assert.ok(signals[0]!.aborted);
		assert.equal(chat.state.get().busy, true);
		await ready.complete(); await connected.p;
		assert.equal(chat.state.get().model, 'model');
		assert.equal(chat.state.get().error, '');
	});

	test('identifies the region being read and clears loading on completion, failure and navigation', async () => {
		let pending: DeferredPromise<void> | undefined;
		let fail = false;
		using chat = fixture(async path => {
			if (pending) await pending.p;
			if (fail) throw new Error('Synthetic read failure');
			return response(path);
		});
		pending = new DeferredPromise<void>();
		const catalog = chat.reload();
		assert.deepEqual(chat.state.get().loading, { kind: 'history' });
		await pending.complete();
		pending = undefined;
		await catalog;
		assert.equal(chat.state.get().loading, undefined);
		pending = new DeferredPromise<void>();
		const selected = chat.select('one');
		// select first persists any active voice session.
		await Promise.resolve();
		assert.deepEqual(chat.state.get().loading, { kind: 'conversation', id: 'one' });
		await pending.complete();
		pending = undefined;
		await selected;
		fail = true;
		await chat.select('two');
		assert.equal(chat.state.get().loading, undefined);
		assert.equal(chat.state.get().conversationId, 'one');
		assert.match(chat.state.get().error, /Synthetic read failure/);
		chat.newChat();
		assert.equal(chat.state.get().loading, undefined);
	});
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
		const localId = chat.state.get().localConversationId;
		chat.setDraft('First'); await chat.send();
		assert.equal(chat.state.get().localConversationId, localId);
		chat.setDraft('Follow up'); await chat.send();
		assert.equal(lists, 1);
		assert.equal(parents[1], 'hidden-1');
		assert.equal(chat.state.get().parentId, 'hidden-2');
		assert.equal(chat.state.get().error, '');
		assert.equal(chat.state.get().conversations[0]?.id, 'created');
		assert.equal(chat.state.get().conversations[0]?.title, 'New accepted conversation');
		assert.equal(chat.state.get().conversations.filter(item => item.id === 'created').length, 1);
		chat.setDraft('Unsent continuation');
		chat.newChat();
		assert.notEqual(chat.state.get().localConversationId, localId);
		assert.equal(chat.state.get().draft, '');
		await chat.select('one'); await chat.select('created');
		assert.equal(chat.state.get().localConversationId, localId);
		assert.equal(chat.state.get().draft, 'Unsent continuation');
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
	test('the same Send action starts a local task, then binds a normal question to that conversation', async () => {
		const values = new Map<string, string>();
		const routes: string[] = [];
		const model = {
			onDidChange: Event.None,
			send: async (text: string) => { routes.push(`cowork:${text}`); },
		};
		const instantiation = {
			createInstance: () => ({
				prepare: async () => ({ sessionId: 'cowork-session', threadId: 'cowork-thread', model }),
				resolve: async () => ({ session: { sessionId: 'cowork-session' }, threadId: 'cowork-thread' }),
				createModel: () => model,
			})
		} as unknown as IInstantiationService;
		let connected = false;
		const respond = async (path: string, _signal: AbortSignal, request: ChatGPTRequest) => {
			if (!connected && path.includes('/models?')) return new Response(null, { status: 401 });
			if (path.includes('/.headers/')) return Response.json({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'proof' });
			if (path.endsWith('/prepare')) return Response.json({ conduit_token: 'fixture' });
			if (path.endsWith('/f/conversation')) {
				const body = JSON.parse(String(request.body));
				assert.equal(body.conversation_id, undefined);
				routes.push(`reply:${body.messages[0].content.parts[0]}`);
				return new Response('data: {"conversation_id":"bound","message":{"id":"reply","author":{"role":"assistant"},"content":{"parts":["Answer"]}}}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
			}
			return response(path);
		};
		const shared = { values, instantiation };
		using chat = fixture(respond, undefined, undefined, shared);
		await chat.reload();
		chat.setDraft('请把访谈整理成一份报告');
		await chat.send();
		assert.deepEqual(routes, ['cowork:请把访谈整理成一份报告']);
		const localId = chat.state.get().localConversationId;
		const localRow = chat.state.get().conversations.find(item => item.local);
		assert.ok(localRow);
		assert.equal(chat.state.get().conversationId, undefined);
		chat.newChat();
		assert.notEqual(chat.state.get().localConversationId, localId);
		await chat.select(localRow.id);
		assert.equal(chat.state.get().localConversationId, localId);
		chat.dispose();
		using reopened = fixture(respond, undefined, undefined, shared);
		await reopened.reload();
		assert.equal(reopened.state.get().localConversationId, localId);
		assert.equal(reopened.state.get().coworkTasks[0]?.threadId, 'cowork-thread');
		connected = true;
		await reopened.reload();
		reopened.setDraft('Can you explain how to write a report?');
		await reopened.send();
		assert.deepEqual(routes, ['cowork:请把访谈整理成一份报告', 'reply:Can you explain how to write a report?']);
		assert.equal(reopened.state.get().localConversationId, localId);
		assert.equal(reopened.state.get().conversationId, 'bound');
		assert.equal(reopened.state.get().coworkTasks[0]?.threadId, 'cowork-thread');
		assert.ok(!reopened.state.get().conversations.some(item => item.id === localRow.id));
		await reopened.select('two');
		await reopened.select('bound');
		assert.equal(reopened.state.get().localConversationId, localId);
		assert.equal(reopened.state.get().coworkTasks[0]?.threadId, 'cowork-thread');
	});

	test('Cowork progress and artifacts stay with the local Chat through navigation, refresh and restart', async () => {
		using changed = new Emitter<void>();
		const dispatched = new DeferredPromise<void>();
		const finish = new DeferredPromise<void>();
		const values = new Map<string, string>();
		let thread: Thread | undefined;
		const taskModel = {
			onDidChange: changed.event,
			get thread() { return thread; },
			async send(text: string, _mode: string, _skills: unknown, contexts: readonly { content: string; }[]) {
				assert.equal(text, 'Write a report');
				assert.match(contexts[0]!.content, /one reply/u);
				assert.ok([...values.values()].some(value => value.includes('cowork-thread')), 'Task reference is stored before dispatch');
				thread = { turns: [{ status: 'running', items: [{ type: 'plan', itemId: 'plan', text: 'Collect sources' }] }] } as unknown as Thread;
				changed.fire();
				await dispatched.complete();
				await finish.p;
				thread = {
					turns: [{
						status: 'completed', items: [{
							type: 'toolResult', itemId: 'result', content: [{ type: 'artifact', artifact: { source: { type: 'resourceLink', uri: 'file:///report.md' } } }],
						}]
					}]
				} as unknown as Thread;
				changed.fire();
			},
		};
		const instantiation = {
			createInstance: () => ({
				prepare: async () => ({ sessionId: 'cowork-session', threadId: 'cowork-thread', model: taskModel }),
				resolve: async () => ({ session: { sessionId: 'cowork-session' }, threadId: 'cowork-thread' }),
				createModel: () => taskModel,
			})
		} as unknown as IInstantiationService;
		const shared = { values, instantiation };
		let historyFails = false;
		let revised = false;
		const respond = async (path: string) => {
			if (path.endsWith('/conversation/one')) {
				if (historyFails) return new Response(null, { status: 503 });
				if (revised) return Response.json({
					title: 'Updated', current_node: 'revised', mapping: {
						revised: { parent: null, message: { id: 'revised', author: { role: 'assistant' }, content: { parts: ['Updated backend reply'] } } },
					}
				});
			}
			return response(path);
		};
		using chat = fixture(respond, undefined, undefined, shared);
		await chat.reload();
		await chat.select('one');
		const localId = chat.state.get().localConversationId;
		chat.setDraft('Write a report');
		const running = chat.send();
		await dispatched.p;
		assert.equal(chat.state.get().coworkTasks[0]?.thread?.turns[0]?.status, 'running');
		assert.match(chat.getAccessibleContent(), /Collect sources/u);
		await chat.select('two');
		assert.equal(chat.state.get().coworkTasks.length, 0);
		await finish.complete();
		await running;
		await chat.select('one');
		assert.equal(chat.state.get().localConversationId, localId);
		assert.equal(chat.state.get().draft, '');
		revised = true;
		await chat.reload();
		assert.equal(chat.state.get().messages[0]?.text, 'Updated backend reply');
		assert.equal(chat.state.get().coworkTasks.length, 1);
		assert.match(chat.getAccessibleContent(), /file:\/\/\/report\.md/u);
		await chat.select('two');
		historyFails = true;
		await chat.select('one');
		assert.equal(chat.state.get().localConversationId, localId);
		assert.equal(chat.state.get().messages[0]?.text, 'Updated backend reply');
		assert.match(chat.getAccessibleContent(), /file:\/\/\/report\.md/u);
		chat.dispose();
		using reopened = fixture(respond, undefined, undefined, shared);
		await reopened.reload();
		assert.equal(reopened.state.get().localConversationId, localId);
		assert.equal(reopened.state.get().messages[0]?.text, 'Updated backend reply');
		assert.equal(reopened.state.get().coworkTasks[0]?.thread?.turns[0]?.status, 'completed');
		assert.match(reopened.getAccessibleContent(), /file:\/\/\/report\.md/u);
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
