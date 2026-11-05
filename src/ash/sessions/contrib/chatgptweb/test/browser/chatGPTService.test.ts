import { ILifecycleService } from '../../../../../workbench/services/lifecycle/common/lifecycle.js';
import type { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { Thread } from '../../../../../workbench/services/chat/common/chatService.js';
import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { suite, suiteTeardown, test } from 'mocha';
import { chatGPTModelCatalog, simpleChatGPTModelCatalog } from '../../../../../../../test/fixtures/chatGPTModels.js';
import { getWindowById } from '../../../../../base/browser/window.js';
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
import { ChatGPTService, IChatGPTService, selectedChatConversationId } from '../../browser/chatGPTService.js';
import { ElectronChatGPTTransport } from '../../electron-browser/electronChatGPTTransport.js';

const lifecycle = { onWillShutdown: Event.None } as ILifecycleService;

function fixture(respond: (path: string, signal: AbortSignal, request: ChatGPTRequest) => Promise<Response>, options?: { values: Map<string, string>; instantiation?: IInstantiationService; cacheScope?: () => string | undefined; onDidChangeAuthentication?: Event<void>; }) {
	const requests = new Map<string, { controller: AbortController; reader?: ReadableStreamDefaultReader<Uint8Array>; }>();
	const transport: IChatGPTTransport = {
		onDidChangeAuthentication: options?.onDidChangeAuthentication,
		async getCacheScope() { return options?.cacheScope ? options.cacheScope() : 'a'.repeat(64); },
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
	const values = options?.values ?? new Map<string, string>();
	return new ChatGPTService(transport, { get: (key: string) => values.get(key), keys: () => [...values.keys()], store: (key: string, value: string) => { values.set(key, value); }, remove: (key: string) => { values.delete(key); }, flush: async () => { } } as unknown as IStorageService, lifecycle, options?.instantiation);
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
	// The jsdom main window belongs to the suite, including when it registers lazily.
	const mainWindowDisposables = getWindowById(1)?.disposables;
	suiteTeardown(() => mainWindowDisposables?.dispose());
	ensureNoDisposablesAreLeakedInTestSuite();
	test('window restoration keeps the selected conversation and its unsent text, while fresh New stays blank', async () => {
		const values = new Map<string, string>();
		const respond = async (path: string) => response(path);
		{
			using chat = fixture(respond, { values });
			await chat.reload();
			chat.setDraft('Old New draft');
			await chat.select('one');
			chat.setDraft('Unsent follow-up');
		}
		{
			using restored = fixture(respond, { values });
			await restored.reload();
			assert.equal(restored.state.get().conversationId, 'one');
			assert.equal(restored.state.get().draft, 'Unsent follow-up');
		}
		{
			const loaded = new DeferredPromise<void>();
			using fresh = fixture(async path => {
				if (path.includes('/conversations?')) { void loaded.complete(); }
				return response(path);
			}, { values });
			fresh.newChat({ clearDraft: true });
			await loaded.p;
			assert.equal(fresh.state.get().draft, '');
			assert.equal(selectedChatConversationId(fresh.state.get()), undefined);
			fresh.setDraft('New draft to restore');
		}
		using restoredNew = fixture(respond, { values });
		await restoredNew.reload();
		assert.equal(selectedChatConversationId(restoredNew.state.get()), undefined);
		assert.equal(restoredNew.state.get().draft, 'New draft to restore');
		await restoredNew.select('one');
		assert.equal(restoredNew.state.get().draft, 'Unsent follow-up');
	});
	test('restores an attachment-only New draft for its account and marks interrupted uploads for retry', async () => {
		const draftId = crypto.randomUUID();
		const ready = { id: crypto.randomUUID(), name: 'ready.txt', size: 5 };
		const interrupted = { id: crypto.randomUUID(), name: 'interrupted.txt', size: 6 };
		const values = new Map([
			['sessions.chatgpt.newDraftId', draftId],
			[`sessions.chatgpt.draftAttachments:${draftId}`, JSON.stringify({
				scope: 'a'.repeat(64),
				attachments: [
					{ ...ready, status: 'ready', file: { id: 'file-ready', mimeType: 'text/plain' } },
					{ ...interrupted, status: 'uploading' },
				],
			})],
		]);
		using restored = fixture(async path => response(path), { values });
		await restored.reload();
		assert.equal(restored.state.get().draft, '');
		assert.equal(restored.state.get().localConversationId, draftId);
		assert.deepEqual(restored.state.get().attachments.map(item => [item.id, item.status, item.file?.id]), [
			[ready.id, 'ready', 'file-ready'], [interrupted.id, 'failed', undefined],
		]);
		using otherAccount = fixture(async path => response(path), { values, cacheScope: () => 'b'.repeat(64) });
		await otherAccount.reload();
		assert.deepEqual(otherAccount.state.get().attachments, []);
	});
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
			[ILifecycleService, lifecycle],
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
		assert.deepEqual(cancellations, []);
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
		}, { onDidChangeAuthentication: changes.event, values: new Map(), cacheScope: () => (account === 'old' ? 'a' : 'b').repeat(64) });
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
		let entered = new DeferredPromise<void>();
		let pending = new DeferredPromise<void>();
		let completed = new DeferredPromise<void>();
		using chat = fixture(async path => {
			if (path.includes('/models?')) {
				modelRequests++;
				void entered.complete();
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
		await entered.p;
		assert.equal(modelRequests, 1);
		await pending.complete();
		await completed.p;
		assert.equal(chat.state.get().connected, false);
		assert.match(chat.state.get().error, /401/u);

		rejected = false;
		entered = new DeferredPromise<void>();
		pending = new DeferredPromise<void>();
		completed = new DeferredPromise<void>();
		chat.initialize();
		chat.initialize();
		await entered.p;
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
		const first = new DeferredPromise<void>();
		const second = new DeferredPromise<void>();
		const signals: AbortSignal[] = [];
		using chat = fixture(async (path, signal) => {
			if (path.includes('/models?')) {
				signals.push(signal);
				void (signals.length === 1 ? first : second).complete();
				await ready.p;
			}
			return response(path);
		});
		using listener = chat.state.onDidChange(state => { if (state.connected) { void connected.complete(); } });
		chat.initialize();
		await first.p;
		chat.newChat();
		await second.p;
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

	test('reopens cached sidebar groups and history before the network answers, and refreshes on retry', async () => {
		const values = new Map<string, string>();
		using initial = fixture(async (path, _signal, request) => {
			if (request.method === 'PATCH') { return Response.json({ success: true }); }
			if (path.includes('/pins?')) { return Response.json([{ item: { id: 'one', title: 'One' } }]); }
			if (path.includes('/gizmos/snorlax/sidebar?')) {
				return Response.json({ items: [{ gizmo: { id: 'g-p-project', display: { name: 'Project' } } }], cursor: null });
			}
			if (path.includes('/conversations?')) {
				return Response.json({ items: [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two', gizmo_id: 'g-p-project' }, { id: 'archived', title: 'Archived' }], total: 3 });
			}
			return response(path);
		}, { values });
		await initial.reload();
		await initial.select('two');
		await initial.select('one');
		await initial.rename('one', 'Renamed pin');
		await initial.archive('archived');
		initial.dispose();

		const entered = new DeferredPromise<void>();
		const release = new DeferredPromise<void>();
		let offline = true;
		using reopened = fixture(async path => {
			if (offline) {
				void entered.complete();
				await release.p;
				return new Response(null, { status: 503 });
			}
			if (path.endsWith('/conversation/two')) {
				return Response.json({
					title: 'Fresh title', current_node: 'reply', mapping: {
						reply: { parent: null, message: { id: 'reply', author: { role: 'assistant' }, content: { parts: ['Fresh reply'] } } },
					}
				});
			}
			return response(path);
		}, { values });
		const pending = reopened.reload();
		await entered.p;
		assert.deepEqual(reopened.state.get().conversations.map(item => [item.id, item.title, item.pinned, item.projectId]), [
			['one', 'Renamed pin', true, undefined], ['two', 'Two', false, 'g-p-project'],
		]);
		assert.deepEqual(reopened.state.get().projects, [{ id: 'g-p-project', title: 'Project' }]);
		assert.equal(reopened.state.get().title, 'Renamed pin');
		assert.equal(reopened.state.get().messages[0]?.text, 'one reply');
		await reopened.select('two');
		assert.equal(reopened.state.get().messages[0]?.text, 'two reply');
		await release.complete();
		await pending;
		assert.equal(reopened.state.get().connected, false);
		assert.equal(reopened.state.get().uncertain, true);
		assert.equal(reopened.state.get().messages[0]?.text, 'two reply');

		offline = false;
		await reopened.reload();
		assert.equal(reopened.state.get().connected, true);
		assert.equal(reopened.state.get().uncertain, false);
		assert.equal(reopened.state.get().messages[0]?.text, 'Fresh reply');

		for (const scope of [() => 'b'.repeat(64), () => undefined]) {
			using differentAccount = fixture(async () => new Response(null, { status: 503 }), { values, cacheScope: scope });
			await differentAccount.reload();
			assert.deepEqual(differentAccount.state.get().conversations, []);
			assert.deepEqual(differentAccount.state.get().messages, []);
		}
	});

	test('opens the local snapshot and shares one history read after its freshness expires', async () => {
		mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
		try {
			const entered = new DeferredPromise<void>();
			const release = new DeferredPromise<void>();
			let reads = 0;
			using chat = fixture(async path => {
				if (!path.endsWith('/conversation/one') || ++reads === 1) return response(path);
				void entered.complete();
				await release.p;
				return Response.json({
					title: 'Updated chat', current_node: 'new-reply', mapping: {
						'new-reply': { parent: null, message: { id: 'new-reply', author: { role: 'assistant' }, content: { parts: ['Updated reply'] } } },
					},
				});
			});
			await chat.reload();
			await chat.select('one');
			await chat.select('two');
			await chat.select('one');
			assert.equal(chat.state.get().messages[0]?.text, 'one reply');
			assert.equal(chat.state.get().uncertain, false);
			assert.equal(reads, 1);

			await chat.select('two');
			mock.timers.tick(60_000);
			const opening = chat.select('one');
			await entered.p;
			const repeated = Array.from({ length: 8 }, () => chat.select('one'));
			assert.equal(chat.state.get().conversationId, 'one');
			assert.equal(chat.state.get().messages[0]?.text, 'one reply');
			assert.equal(chat.state.get().uncertain, true);
			await release.complete();
			await Promise.all([opening, ...repeated]);
			assert.equal(chat.state.get().messages[0]?.text, 'Updated reply');
			assert.equal(chat.state.get().uncertain, false);
			await chat.select('one');
			assert.equal(reads, 2);
		} finally {
			mock.timers.reset();
		}
	});

	test('cold restore and followup remain usable when only the recent list is rate-limited', async () => {
		let sends = 0;
		const legacyTimeline = 'sessions.chat.timeline.v1:chatgpt-web:one';
		const values = new Map([
			['sessions.chatgpt.conversation', 'one'],
			[legacyTimeline, JSON.stringify({ localId: 'legacy-local-id', tasks: [], history: { title: 'Legacy title', parentId: 'legacy-reply', messages: [] } })],
		]);
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
		}, { values });
		await chat.reload();
		assert.equal(chat.state.get().connected, true);
		assert.equal(chat.state.get().conversationId, 'one');
		assert.equal(chat.state.get().localConversationId, 'legacy-local-id');
		assert.equal(values.has(legacyTimeline), false);
		assert.equal(chat.state.get().messages[0]?.text, 'one reply');
		assert.equal(chat.state.get().conversations[0]?.id, 'one');
		assert.match(chat.state.get().error, /conversation list.*continue the current chat/u);
		chat.setDraft('Continue after reopening'); await chat.send();
		assert.equal(sends, 1); assert.equal(chat.state.get().error, '');
	});

	test('refresh synchronizes cloud additions, edits and confirmed deletions across loaded pages and disk', async () => {
		const values = new Map<string, string>();
		let ids = ['one', 'two', 'older'];
		let unavailable = false;
		let revised = false;
		const respond = async (path: string): Promise<Response> => {
			if (path.includes('/conversations?')) {
				const offset = Number(new URL(path, 'https://fixture.invalid').searchParams.get('offset'));
				return Response.json({ items: ids.slice(offset, offset + 2).map(id => ({ id, title: id })), total: ids.length });
			}
			if (path.endsWith('/conversation/two')) {
				if (unavailable) { return new Response(null, { status: 503 }); }
				if (!ids.includes('two')) { return new Response(null, { status: 404 }); }
				if (revised) {
					return Response.json({
						title: 'two', current_node: 'new-turn', mapping: {
							'new-turn': { parent: null, message: { id: 'new-turn', author: { role: 'assistant' }, content: { parts: ['Updated remotely'] } } },
						}
					});
				}
			}
			return response(path);
		};
		using chat = fixture(respond, { values });
		await chat.reload();
		await chat.loadMore();
		await chat.select('two');
		chat.setDraft('Unsent text');
		revised = true;
		await chat.refresh();
		assert.equal(chat.state.get().messages[0]?.text, 'Updated remotely');
		assert.equal(chat.state.get().draft, 'Unsent text');

		ids = ['new', 'one', 'older'];
		unavailable = true;
		await chat.refresh();
		assert.deepEqual(chat.state.get().conversations.map(item => item.id), ['new', 'one', 'older', 'two']);
		assert.equal(chat.state.get().conversationId, 'two');
		assert.equal(chat.state.get().messages[0]?.text, 'Updated remotely');
		unavailable = false;
		await chat.refresh();
		assert.deepEqual(chat.state.get().conversations.map(item => item.id), ids);
		assert.equal(chat.state.get().conversationId, undefined);
		assert.equal(chat.state.get().draft, 'Unsent text');
		assert.ok(![...values.keys()].some(key => key.startsWith('sessions.chat.timeline.v1:') && key.endsWith(':two')));

		using offline = fixture(async () => new Response(null, { status: 503 }), { values });
		await offline.reload();
		assert.deepEqual(offline.state.get().conversations.map(item => item.id), ids);
		assert.deepEqual(offline.state.get().messages, []);
	});

	test('a remote snapshot in flight cannot undo an acknowledged local delete', async () => {
		const entered = new DeferredPromise<void>();
		const released = new DeferredPromise<void>();
		let held = false;
		let deleted = false;
		using chat = fixture(async (path, _signal, request) => {
			if (path.includes('/conversations?') && held) {
				void entered.complete();
				await released.p;
				return response(path);
			}
			if (request.method === 'DELETE') {
				assert.ok(path.endsWith('/conversation/id/two'));
				deleted = true;
				return new Response(null, { status: 204 });
			}
			return response(path);
		});
		await chat.reload();
		held = true;
		const stale = chat.refresh();
		await entered.p;
		await chat.deleteConversation('two');
		await released.complete();
		await stale;
		assert.ok(deleted);
		assert.deepEqual(chat.state.get().conversations.map(item => item.id), ['one']);
	});

	test('offline creation and deletion survive restart, retry safely and suppress stale cloud rows', async () => {
		const values = new Map<string, string>();
		let available = false;
		let deleteRequests = 0;
		let postRequests = 0;
		const preparedIds: string[] = [];
		const respond = async (path: string, _signal: AbortSignal, request: ChatGPTRequest): Promise<Response> => {
			if (request.method === 'DELETE') {
				assert.ok(path.endsWith('/conversation/id/two'));
				deleteRequests++;
				return new Response(null, { status: available ? 204 : 503 });
			}
			if (path.endsWith('/prepare')) {
				preparedIds.push(JSON.parse(String(request.body)).messages[0].id);
				return available ? Response.json({ conduit_token: 'proof' }) : new Response(null, { status: 503 });
			}
			if (path.includes('/.headers/')) { return Response.json({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'proof' }); }
			if (path.endsWith('/f/conversation')) {
				postRequests++;
				return new Response('data: {"conversation_id":"created-offline"}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
			}
			return response(path);
		};
		using initial = fixture(respond, { values });
		await initial.reload();
		initial.setNetworkAvailable(false);
		initial.setDraft('Cancel this before it is sent');
		await initial.send();
		await initial.deleteConversation(selectedChatConversationId(initial.state.get())!);
		initial.setDraft('Keep this offline chat');
		await initial.send();
		await initial.deleteConversation('two');
		const pendingId = selectedChatConversationId(initial.state.get());
		assert.ok(pendingId?.startsWith('pending:'));
		assert.equal(initial.state.get().pendingCreation, 'queued');
		assert.equal(postRequests, 0);
		assert.equal(deleteRequests, 0);
		initial.dispose();

		using otherAccount = fixture(respond, { values, cacheScope: () => 'b'.repeat(64) });
		await otherAccount.reload();
		assert.deepEqual(otherAccount.state.get().conversations.map(item => item.id), ['one', 'two']);
		assert.equal(postRequests, 0);

		using reopened = fixture(respond, { values });
		reopened.setNetworkAvailable(false);
		await reopened.reload();
		assert.equal(selectedChatConversationId(reopened.state.get()), pendingId);
		assert.equal(reopened.state.get().messages[0]?.text, 'Keep this offline chat');
		assert.deepEqual(reopened.state.get().conversations.map(item => item.id), [pendingId, 'one']);
		reopened.setNetworkAvailable(true);
		await reopened.refresh();
		assert.equal(postRequests, 0);
		assert.equal(deleteRequests, 1);
		assert.equal(reopened.state.get().pendingCreation, 'queued');
		available = true;
		await reopened.refresh();
		await reopened.refresh();
		assert.equal(postRequests, 1);
		assert.equal(deleteRequests, 2);
		assert.equal(preparedIds.length, 2);
		assert.equal(preparedIds[0], preparedIds[1]);
		assert.equal(reopened.state.get().conversationId, 'created-offline');
		assert.ok(!reopened.state.get().conversations.some(item => item.id === 'two' || item.id.startsWith('pending:')));
		reopened.dispose();
		using restarted = fixture(respond, { values });
		await restarted.reload();
		assert.ok(!restarted.state.get().conversations.some(item => item.id === 'two'));
		assert.equal(postRequests, 1);
		assert.equal(deleteRequests, 2);
	});

	for (const duringPreparation of [false, true]) {
		test(duringPreparation
			? 'deleting a queued chat cancels its in-flight preparation'
			: 'deleting the second queued chat while the first is submitting keeps its text off the transport', async () => {
				const entered = new DeferredPromise<AbortSignal>();
				const release = new DeferredPromise<void>();
				const payloads: { phase: string; text: string; }[] = [];
				using chat = fixture(async (path, signal, request) => {
					if (path.includes('/.headers/')) { return Response.json({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'proof' }); }
					const preparing = path.endsWith('/prepare');
					if (preparing || path.endsWith('/f/conversation')) {
						const text = JSON.parse(String(request.body)).messages[0].content.parts[0];
						payloads.push({ phase: preparing ? 'prepare' : 'submit', text });
						if (duringPreparation ? preparing && text === 'Second' : !preparing && text === 'First') {
							await entered.complete(signal);
							await release.p;
						}
						return preparing
							? Response.json({ conduit_token: 'proof' })
							: new Response('data: {"conversation_id":"sent-first"}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
					}
					return response(path);
				});
				await chat.reload();
				chat.setNetworkAvailable(false);
				chat.setDraft('First');
				await chat.send();
				chat.newChat();
				chat.setDraft('Second');
				await chat.send();
				const secondId = selectedChatConversationId(chat.state.get());
				assert.ok(secondId && secondId.startsWith('pending:'));

				chat.setNetworkAvailable(true);
				const syncing = chat.refresh();
				const signal = await entered.p;
				const deleting = chat.deleteConversation(secondId);
				const abortedOnDelete = signal.aborted;
				await release.complete();
				await Promise.all([syncing, deleting]);

				const expected = [{ phase: 'prepare', text: 'First' }, { phase: 'submit', text: 'First' }];
				if (duringPreparation) { expected.push({ phase: 'prepare', text: 'Second' }); }
				assert.deepEqual(payloads, expected);
				assert.equal(abortedOnDelete, duringPreparation);
				assert.ok(chat.state.get().conversations.some(item => item.id === 'sent-first'));
				assert.ok(!chat.state.get().conversations.some(item => item.id === secondId));
				assert.equal(chat.state.get().pendingSync, false);
			});
	}

	for (const cancelled of [false, true]) {
		test(`an ambiguous creation reconciles by message ID after restart without posting again (${cancelled ? 'deleted offline' : 'retained'})`, async () => {
			const values = new Map<string, string>();
			let messageId: string | undefined;
			let indexed = false;
			let posts = 0;
			let deletes = 0;
			const respond = async (path: string, _signal: AbortSignal, request: ChatGPTRequest): Promise<Response> => {
				if (request.method === 'DELETE') {
					assert.ok(path.endsWith('/conversation/id/cloud-created'));
					deletes++;
					return new Response(null, { status: 204 });
				}
				if (path.endsWith('/prepare')) { return Response.json({ conduit_token: 'proof' }); }
				if (path.includes('/.headers/')) { return Response.json({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'proof' }); }
				if (path.endsWith('/f/conversation')) {
					posts++;
					messageId = JSON.parse(String(request.body)).messages[0].id;
					throw new Error('Connection lost after accepting message');
				}
				if (path.includes('/conversations?') && indexed) {
					return Response.json({ items: [{ id: 'cloud-created', title: 'Accepted on cloud' }, { id: 'one', title: 'One' }], total: 2 });
				}
				if (path.endsWith('/conversation/cloud-created') && messageId) {
					return Response.json({
						title: 'Accepted on cloud', current_node: messageId, mapping: {
							[messageId]: { parent: null, message: { id: messageId, author: { role: 'user' }, content: { parts: ['Saved question'] } } },
						}
					});
				}
				return response(path);
			};
			using initial = fixture(respond, { values });
			initial.setNetworkAvailable(false);
			await initial.reload();
			initial.setDraft('Saved question');
			await initial.send();
			initial.setNetworkAvailable(true);
			await initial.refresh();
			assert.equal(posts, 1);
			assert.equal(initial.state.get().pendingCreation, 'submitted');
			initial.dispose();

			using reopened = fixture(respond, { values });
			await reopened.reload();
			await reopened.refresh();
			assert.equal(posts, 1);
			assert.equal(reopened.state.get().pendingCreation, 'submitted');
			if (cancelled) {
				reopened.setNetworkAvailable(false);
				await reopened.deleteConversation(selectedChatConversationId(reopened.state.get())!);
				reopened.setNetworkAvailable(true);
				assert.equal(deletes, 0);
			}
			indexed = true;
			await reopened.refresh();
			assert.equal(posts, 1);
			assert.equal(deletes, cancelled ? 1 : 0);
			assert.equal(reopened.state.get().conversationId, cancelled ? undefined : 'cloud-created');
			assert.equal(reopened.state.get().pendingCreation, undefined);
			assert.equal(reopened.state.get().messages[0]?.id, cancelled ? undefined : messageId);
			assert.equal(reopened.state.get().conversations.some(item => item.id === 'cloud-created'), !cancelled);
			assert.ok(!reopened.state.get().conversations.some(item => item.id.startsWith('pending:')));
		});
	}

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
			chat.setModel('latest', preset);
			chat.setModel('latest', 'unknown');
			assert.equal(chat.state.get().modelPreset, preset);
			chat.setDraft('Use selected preset');
			await chat.send();
			assert.ok(sent.slice(-2).every(body => body.model === model && body.thinking_effort === effort));
			if (effort === undefined) { assert.ok(sent.slice(-2).every(body => !('thinking_effort' in body))); }
		}
		assert.equal(sent.length, 10);
		chat.setModel('5.6');
		assert.equal(chat.state.get().modelPreset, '3');
		chat.setModel('5.6', '6');
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
	test('a new ChatGPT draft retains its chosen model for task-like prompts and follow-ups', async () => {
		const requests: { model: string; conversation?: string; text: string; }[] = [];
		const instantiation = {
			createInstance: () => { throw new Error('An explicit ChatGPT model must not start a Cowork task'); },
		} as unknown as IInstantiationService;
		using chat = fixture(async (path, _signal, request) => {
			if (path.includes('/models?')) {
				return Response.json(simpleChatGPTModelCatalog([{ slug: 'model', title: 'Model' }, { slug: 'chosen', title: 'Chosen' }]));
			}
			if (path.endsWith('/conversation/one')) {
				return Response.json({ ...await response(path).json(), default_model_slug: 'model' });
			}
			if (path.includes('/.headers/')) return Response.json({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'proof' });
			if (path.endsWith('/prepare')) return Response.json({ conduit_token: 'fixture' });
			if (path.endsWith('/f/conversation')) {
				const body = JSON.parse(String(request.body));
				requests.push({ model: body.model, conversation: body.conversation_id, text: body.messages[0].content.parts[0] });
				return new Response('data: {"conversation_id":"bound","message":{"id":"reply","author":{"role":"assistant"},"content":{"parts":["Answer"]}}}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
			}
			return response(path);
		}, { values: new Map(), instantiation });
		await chat.reload();
		await chat.select('one');
		chat.setDraft('Existing conversation draft');
		chat.newChat();
		chat.setModel('chosen');
		chat.setDraft('请把访谈整理成一份报告');
		assert.equal(selectedChatConversationId(chat.state.get()), undefined);
		assert.equal(chat.state.get().model, 'chosen');
		assert.deepEqual(chat.state.get().messages, []);
		assert.deepEqual(chat.state.get().attachments, []);
		await chat.select('one');
		assert.equal(chat.state.get().model, 'model');
		chat.newChat();
		assert.equal(chat.state.get().model, 'chosen');
		assert.equal(chat.state.get().draft, '请把访谈整理成一份报告');
		await chat.send();
		chat.setDraft('再写一份报告');
		await chat.send();
		assert.deepEqual(requests, [
			{ model: 'chosen', conversation: undefined, text: '请把访谈整理成一份报告' },
			{ model: 'chosen', conversation: 'bound', text: '再写一份报告' },
		]);
		await chat.select('one');
		assert.equal(chat.state.get().draft, 'Existing conversation draft');
	});

	test('a task-like prompt in a default ChatGPT draft is sent through ChatGPT', async () => {
		const prompt = '请把访谈整理成一份报告';
		const requests: { text: string; model: string; }[] = [];
		let nativeCalls = 0;
		const instantiation = {
			createInstance: () => { nativeCalls++; throw new Error('Native task creation must not run'); },
		} as unknown as IInstantiationService;
		using chat = fixture(async (path, _signal, request) => {
			if (path.includes('/.headers/')) return Response.json({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'proof' });
			if (path.endsWith('/prepare')) return Response.json({ conduit_token: 'fixture' });
			if (path.endsWith('/f/conversation')) {
				const body = JSON.parse(String(request.body));
				requests.push({ text: body.messages[0].content.parts[0], model: body.model });
				return new Response('data: {"conversation_id":"bound","message":{"id":"reply","author":{"role":"assistant"},"content":{"parts":["Answer"]}}}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
			}
			return response(path);
		}, { values: new Map(), instantiation });
		await chat.reload();
		chat.setDraft(prompt);
		await chat.send();
		assert.deepEqual(requests, [{ text: prompt, model: 'model' }]);
		assert.equal(nativeCalls, 0);
		assert.equal(chat.state.get().conversationId, 'bound');
	});

	test('saved Cowork references survive navigation, refresh and restart', async () => {
		using changed = new Emitter<void>();
		const localId = 'legacy-conversation';
		const values = new Map([[
			`sessions.chat.timeline.v1:chatgpt-web:local:${localId}`,
			JSON.stringify({ localId, tasks: [{ sessionId: 'cowork-session', threadId: 'cowork-thread', prompt: 'Write a report' }] }),
		]]);
		let thread = { turns: [{ status: 'running', items: [{ type: 'plan', itemId: 'plan', text: 'Collect sources' }] }] } as unknown as Thread;
		const taskModel = {
			onDidChange: changed.event,
			get thread() { return thread; },
		};
		const instantiation = {
			createInstance: () => ({
				resolve: async () => ({ session: { sessionId: 'cowork-session' }, threadId: 'cowork-thread' }),
				createModel: () => taskModel,
			})
		} as unknown as IInstantiationService;
		const shared = { values, instantiation };
		let historyFails = false;
		let revised = false;
		const respond = async (path: string) => {
			if (path.includes('/.headers/')) return Response.json({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'proof' });
			if (path.endsWith('/prepare')) return Response.json({ conduit_token: 'fixture' });
			if (path.endsWith('/f/conversation')) {
				return new Response('data: {"conversation_id":"one","message":{"id":"reply","author":{"role":"assistant"},"content":{"parts":["one reply"]}}}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
			}
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
		using chat = fixture(respond, shared);
		await chat.reload();
		await chat.select(`local:${localId}`);
		assert.equal(chat.state.get().coworkTasks[0]?.thread?.turns[0]?.status, 'running');
		assert.match(chat.getAccessibleContent(), /Collect sources/u);
		await chat.select('two');
		assert.equal(chat.state.get().coworkTasks.length, 0);
		thread = {
			turns: [{
				status: 'completed', items: [{
					type: 'toolResult', itemId: 'result', content: [{ type: 'artifact', artifact: { source: { type: 'resourceLink', uri: 'file:///report.md' } } }],
				}]
			}]
		} as unknown as Thread;
		await chat.select(`local:${localId}`);
		chat.setDraft('What is a report?');
		await chat.send();
		assert.equal(chat.state.get().conversationId, 'one');
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
		using reopened = fixture(respond, shared);
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
