import { IDocsService } from '../../../../contrib/docs/common/docsService.js';
import { URI } from '../../../../../base/common/uri.js';
import { IArtifactCatalogService } from '../../../../services/artifactCatalog/common/artifactCatalogService.js';
import { createTestArtifactCatalogService, createTestDocsService } from '../../../../test/common/testArtifactCatalogService.js';
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
import { autorun } from '../../../../../base/common/observable.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { INotificationService, Severity, type INotification, type INotificationHandle } from '../../../../../platform/notification/common/notification.js';
import { NotificationsModel } from '../../../../../workbench/common/notifications.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import type { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ChatGPTAuthenticationError, IChatGPTTransport, type ChatGPTRequest } from '../../common/chatGPTTransport.js';
import { ChatGPTService, IChatGPTService, selectedChatConversationId } from '../../browser/chatGPTService.js';
import { ElectronChatGPTTransport } from '../../electron-browser/electronChatGPTTransport.js';
import { chatCreationKinds, getChatCreationContext } from '../../../../common/chatCreation.js';

const lifecycle = { onWillShutdown: Event.None } as ILifecycleService;

function notificationService(model?: NotificationsModel): INotificationService {
	return {
		error: (message: string) => { model?.addNotification({ severity: Severity.Error, message }); },
		notify: (notification: INotification): INotificationHandle => model?.addNotification(notification) ?? ({
			onDidClose: Event.None, onDidChangeVisibility: Event.None,
			progress: { infinite() { }, total() { }, worked() { }, done() { } },
			close() { }, updateMessage() { }, updateSeverity() { }, updateActions() { },
		}),
	} as INotificationService;
}

function fixture(respond: (path: string, signal: AbortSignal, request: ChatGPTRequest) => Promise<Response>, options?: { values?: Map<string, string>; instantiation?: IInstantiationService; cacheScope?: () => string | undefined; onDidChangeAuthentication?: Event<void>; notifications?: NotificationsModel; native?: true; generated?: IArtifactCatalogService; docs?: IDocsService; }) {
	const requests = new Map<string, { controller: AbortController; reader?: ReadableStreamDefaultReader<Uint8Array>; }>();
	const transport: IChatGPTTransport = {
		native: options?.native,
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
	return new ChatGPTService(transport, { get: (key: string) => values.get(key), keys: () => [...values.keys()], store: (key: string, value: string) => { values.set(key, value); }, remove: (key: string) => { values.delete(key); }, flush: async () => { } } as unknown as IStorageService, lifecycle, notificationService(options?.notifications), options?.generated ?? createTestArtifactCatalogService(), options?.docs ?? createTestDocsService(), options?.instantiation);
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
function voiceWindow() {
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
	return { window, channel };
}

suite('ChatGPT shared service', () => {
	// The jsdom main window belongs to the suite, including when it registers lazily.
	const mainWindowDisposables = getWindowById(1)?.disposables;
	suiteTeardown(() => mainWindowDisposables?.dispose());
	ensureNoDisposablesAreLeakedInTestSuite();
	test('opens an unlisted source conversation only for its owning account', async () => {
		const reads: string[] = [];
		using chat = fixture(async path => {
			reads.push(path);
			return response(path);
		});
		await assert.rejects(chat.select('older-chat', 'b'.repeat(64)));
		assert.equal(reads.length, 0);
		assert.equal(chat.state.get().conversationId, undefined);
		await chat.select('older-chat', 'a'.repeat(64));
		assert.equal(chat.state.get().conversationId, 'older-chat');
		assert.equal(chat.state.get().catalogScope, 'a'.repeat(64));
		assert.ok(reads.some(path => path.endsWith('/older-chat')));
	});

	test('confirmed history publishes complete writing without an active Chat widget', async () => {
		const document = new DeferredPromise<{ markdown: string; account: string | null; }>();
		const writing = ':::writing{title="Published"}\n# Published\n\n<text>Body</text>\n:::';
		const docs: IDocsService = {
			...createTestDocsService(),
			async importMarkdown(source, markdown) {
				await document.complete({ markdown, account: source.accountId });
				return { id: 'published', source, title: 'Published', resource: URI.file('/published.md'), contentType: 'text/markdown', createdAt: 1 };
			},
		};
		using chat = fixture(async path => {
			if (!path.endsWith('/one')) return response(path);
			return Response.json({
				title: 'One', current_node: 'reply', mapping: {
					reply: { parent: 'incomplete', message: { id: 'reply', status: 'finished_successfully', author: { role: 'assistant' }, content: { parts: [writing] } } },
					incomplete: { parent: null, message: { id: 'incomplete', status: 'in_progress', author: { role: 'assistant' }, content: { parts: [writing] } } },
				}
			});
		}, { docs });
		await chat.reload();
		await chat.select('one');
		const publication = await document.p;
		assert.equal(publication.account, 'a'.repeat(64));
		assert.match(publication.markdown, /^# Published\n/u);
		assert.match(publication.markdown, /Body/u);
		assert.doesNotMatch(publication.markdown, /<:ash-rich/u);
	});

	for (const native of [undefined, true] as const) {
		test(`${native ? 'Native' : 'Web'} recent history and sidebar groups have independent freshness after reopening`, async () => {
			mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
			using clock = toDisposable(() => mock.timers.reset());
			const values = new Map<string, string>();
			const reads = { recent: 0, projects: 0, pins: 0, history: 0 };
			let projectTitle = 'Project';
			const createdAt = new Date(100_000);
			const updatedAt = new Date(200_000);
			let pinned = true;
			let ids = ['one', 'two'];
			const respond = async (path: string) => {
				if (path.includes('/gizmos/snorlax/sidebar?')) {
					reads.projects++;
					return Response.json({
						items: [{ gizmo: { id: 'g-p-project', display: { name: projectTitle }, created_at: createdAt.toISOString(), updated_at: updatedAt.toISOString() } }],
						cursor: null,
					});
				}
				if (path.includes('/pins?')) {
					reads.pins++;
					return Response.json(pinned ? [{ item: { id: 'pin', title: 'Pin' } }] : []);
				}
				if (path.includes('/conversations?')) {
					reads.recent++;
					return Response.json({ items: ids.map(id => ({ id, title: id })) });
				}
				if (native && path.includes('/conversations/')) {
					if (path.includes('/conversations/one?')) { reads.history++; }
					return Response.json({ title: 'Conversation', current_node: 'reply', messages: [], page_info: { has_previous_page: false } });
				}
				if (path.endsWith('/conversation/one')) { reads.history++; }
				return response(path);
			};
			{
				using chat = fixture(respond, { values, native });
				await chat.reload();
				await chat.refresh();
				assert.deepEqual(reads, { recent: 1, projects: 1, pins: 1, history: 0 });
			}
			using reopened = fixture(respond, { values, native });
			const connected = new DeferredPromise<void>();
			using ready = autorun(reader => {
				if (reopened.state.read(reader).connected) void connected.complete();
			});
			reopened.initialize();
			await connected.p;
			assert.deepEqual(reopened.state.get().projects, [{
				id: 'g-p-project', title: 'Project', createdAt: createdAt.getTime(), updatedAt: updatedAt.getTime(),
			}]);
			assert.equal(reopened.state.get().conversations.find(item => item.id === 'pin')?.pinned, true);
			assert.deepEqual(reads, { recent: 1, projects: 1, pins: 1, history: 0 });
			ids = ['new', ...ids];
			mock.timers.tick(5 * 60_000 - 1);
			await reopened.refresh();
			assert.equal(reopened.state.get().conversations.some(item => item.id === 'new'), false);
			assert.deepEqual(reads, { recent: 1, projects: 1, pins: 1, history: 0 });
			mock.timers.tick(1);
			await reopened.refresh();
			assert.deepEqual(reads, { recent: 2, projects: 1, pins: 1, history: 0 });
			assert.equal(reopened.state.get().conversations[0]?.id, 'new');
			assert.equal(reopened.state.get().conversations.find(item => item.id === 'pin')?.pinned, true);

			projectTitle = 'Renamed project';
			pinned = false;
			mock.timers.tick(10 * 60_000 - 1);
			await reopened.refresh();
			assert.deepEqual(reads, { recent: 3, projects: 1, pins: 1, history: 0 });
			mock.timers.tick(1);
			await reopened.refresh();
			assert.deepEqual(reads, { recent: 3, projects: 2, pins: 2, history: 0 });
			assert.equal(reopened.state.get().projects[0]?.title, 'Renamed project');
			assert.equal(reopened.state.get().conversations.some(item => item.pinned), false);

			await reopened.reload();
			assert.deepEqual(reads, { recent: 4, projects: 3, pins: 3, history: 0 }, 'Manual reload can refresh fresh lists');
			await reopened.select('one');
			assert.equal(reopened.state.get().conversationId, 'one');
			const historyReads = reads.history;
			await reopened.refresh();
			assert.deepEqual(reads, { recent: 4, projects: 3, pins: 3, history: historyReads + Number(!!native) });
		});
	}

	test('refreshes the project list when a fresh legacy catalog lacks project timestamps', async () => {
		const now = Date.now();
		const updatedAt = new Date(now - 60_000);
		const values = new Map([[`sessions.chatgpt.catalog.v1:${'a'.repeat(64)}`, JSON.stringify({
			projects: [{ id: 'g-p-project', title: 'Project' }],
			projectsFetchedAt: now,
			pinsFetchedAt: now,
		})]]);
		let projectReads = 0;
		using chat = fixture(async path => {
			if (path.includes('/gizmos/snorlax/sidebar?')) {
				projectReads++;
				return Response.json({ items: [{ gizmo: { id: 'g-p-project', display: { name: 'Project' }, updated_at: updatedAt.toISOString() } }], cursor: null });
			}
			assert.ok(!path.includes('/pins?'), 'Legacy pins still have a fresh cache');
			return response(path);
		}, { values });
		const connected = new DeferredPromise<void>();
		using ready = autorun(reader => {
			if (chat.state.read(reader).connected) void connected.complete();
		});
		chat.initialize();
		await connected.p;
		assert.equal(projectReads, 1);
		assert.equal(chat.state.get().projects[0]?.updatedAt, updatedAt.getTime());
	});

	test('restores confirmed project instructions offline within their account scope', async () => {
		const values = new Map<string, string>();
		const id = 'g-p-project';
		const scope = 'a'.repeat(64);
		let instructions = 'Written in ChatGPT';
		let saveAllowed = false;
		const respond = async (path: string, _signal: AbortSignal, request: ChatGPTRequest) => {
			if (path.includes('/gizmos/snorlax/sidebar?')) {
				return Response.json({ items: [{ gizmo: { id, display: { name: 'Project' } } }], cursor: null });
			}
			if (path.split('?')[0].endsWith(`/gizmos/${id}`)) {
				return Response.json({
					gizmo: { id, instructions, display: { name: 'Project' } },
					files: [{ file_id: 'file-example', name: 'example.txt' }],
				});
			}
			if (path.endsWith(`/projects/${id}`) && request.method === 'PATCH') {
				if (!saveAllowed) return new Response(null, { status: 503 });
				assert.ok(typeof request.body === 'string');
				instructions = JSON.parse(request.body).instructions;
				return new Response(null, { status: 204 });
			}
			return response(path);
		};
		using chat = fixture(respond, { values });
		using otherWindow = fixture(respond, { values });
		await chat.reload();
		await otherWindow.reload();
		await chat.loadProjectDetails(id, scope, new AbortController().signal);
		await otherWindow.reload();
		const assertRestored = async (description: string) => {
			using offline = fixture(async () => assert.fail('Offline restoration should not make requests'), { values });
			offline.setNetworkAvailable(false);
			await offline.reload();
			assert.equal(offline.state.get().projects[0]?.id, id);
			assert.deepEqual(offline.projectDetails.get().get(id), { description });
		};
		await assertRestored(instructions);
		const edit = await chat.editProjectDetails(id, new AbortController().signal);
		await assert.rejects(edit.save({ ...edit.details, description: 'Rejected edit' }));
		await assertRestored('Written in ChatGPT');
		saveAllowed = true;
		await edit.save({ ...edit.details, description: '' });
		assert.equal(instructions, '');
		await assertRestored('');

		using otherAccount = fixture(respond, { values, cacheScope: () => 'b'.repeat(64) });
		await otherAccount.reload();
		assert.equal(otherAccount.state.get().projects[0]?.id, id);
		assert.equal(otherAccount.projectDetails.get().get(id), undefined);
	});

	test('serializes first project memory saves across windows and returns saved versions for recovery', async () => {
		const id = 'g-p-project';
		const scope = 'a'.repeat(64);
		const marker = `<!-- ash-project-memory:${id} -->\n`;
		const projectFiles = `/service/backend-api/projects/${id}/files`;
		const contents = new Map<string, string>();
		const files = new Map<string, string>();
		const started = new DeferredPromise<void>();
		const attach = new DeferredPromise<void>();
		let uploads = 0;
		const respond = async (path: string, _signal: AbortSignal, request: ChatGPTRequest) => {
			const url = new URL(path, 'https://fixture.test');
			if (path.includes('/gizmos/snorlax/sidebar?')) {
				return Response.json({ items: [{ gizmo: { id, display: { name: 'Project' } } }], cursor: null });
			}
			if (url.pathname.endsWith(`/gizmos/${id}`)) {
				return Response.json({ gizmo: { id, display: { name: 'Project' } }, files: [...files].map(([file_id, name]) => ({ file_id, name })) });
			}
			if (url.pathname === '/service/backend-api/files' && request.method === 'POST') {
				const file = `file-memory-${++uploads}`;
				return Response.json({ file_id: file, upload_url: `https://fixture.test/${file}` });
			}
			if (url.pathname === '/service/.upload') {
				assert.ok(request.body instanceof VSBuffer);
				contents.set(new URL(url.searchParams.get('url')!).pathname.slice(1), request.body.toString());
				return new Response(null, { status: 204 });
			}
			if (url.pathname === '/service/backend-api/files/process_upload_stream') {
				assert.equal(typeof request.body, 'string');
				return new Response(JSON.stringify({ event: 'file.processing.completed', file_id: JSON.parse(String(request.body)).file_id }));
			}
			if (url.pathname === projectFiles && request.method === 'POST') {
				const [{ file_id, name }] = JSON.parse(String(request.body)).files;
				if (file_id === 'file-memory-1') {
					void started.complete();
					await attach.p;
				}
				files.set(file_id, name);
				return new Response(null, { status: 204 });
			}
			if (url.pathname.startsWith(`${projectFiles}/`) && request.method === 'DELETE') {
				assert.ok(files.delete(url.pathname.split('/').at(-1)!));
				return new Response(null, { status: 204 });
			}
			if (url.pathname === '/service/.resource') {
				const file = new URL(url.searchParams.get('url')!).pathname.split('/').at(-1)!;
				assert.ok(files.has(file));
				return new Response(contents.get(file));
			}
			return response(path);
		};
		using firstWindow = fixture(respond);
		using secondWindow = fixture(respond);
		await Promise.all([firstWindow.reload(), secondWindow.reload()]);
		const signal = new AbortController().signal;
		const [first, second] = await Promise.all([firstWindow.editProjectMemory(id, scope, signal), secondWindow.editProjectMemory(id, scope, signal)]);
		assert.deepEqual(first.versions, []);
		assert.deepEqual(second.versions, []);
		const firstSave = first.save!('First draft');
		const secondSave = second.save!('Second draft');
		const saves = Promise.all([firstSave, secondSave]);
		try {
			await Promise.race([started.p, saves]);
		} finally {
			void attach.complete();
		}
		const [saved, conflict] = await saves;
		assert.equal(saved, undefined);
		assert.deepEqual(conflict?.versions, ['First draft']);
		assert.ok(conflict?.save);
		assert.equal(uploads, 1);
		assert.deepEqual([...files.keys()], ['file-memory-1']);

		// A previously hidden, older source changes the version set even when the current file is unchanged.
		files.set('file-legacy', 'Ash project memory 0000000000001-00000000-0000-0000-0000-000000000000.md');
		contents.set('file-legacy', `${marker}Recovered draft`);
		const recovery = await conflict.save('First draft\nSecond draft');
		assert.deepEqual(recovery?.versions, ['First draft', 'Recovered draft']);
		assert.ok(recovery?.save);
		assert.equal(uploads, 1);
		assert.deepEqual((await secondWindow.editProjectMemory(id, scope, signal)).versions, recovery.versions);
		const merged = 'First draft\nSecond draft\nRecovered draft';
		assert.equal(await recovery.save(merged), undefined);
		assert.deepEqual([...files.keys()], ['file-memory-2']);
		assert.equal(contents.get('file-memory-2'), marker + merged);
		assert.deepEqual((await firstWindow.editProjectMemory(id, scope, signal)).versions, [merged]);
	});

	test('refreshes a stale project from the head and verifies omitted conversations before removing them', async () => {
		mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
		using clock = toDisposable(() => mock.timers.reset());
		const id = 'g-p-project';
		const projectPath = `/gizmos/${id}/conversations`;
		const omitted = ['still-here', 'moved', 'unassigned', 'archived', 'deleted', 'unknown', 'unavailable'];
		const cursors: (string | null)[] = [];
		const checks: string[] = [];
		let changed = false;
		using chat = fixture(async path => {
			if (path.includes('/gizmos/snorlax/sidebar?')) {
				return Response.json({ items: [{ gizmo: { id, display: { name: 'Project' } } }], cursor: null });
			}
			if (path.includes(projectPath)) {
				const cursor = new URLSearchParams(path.split('?')[1]).get('cursor');
				cursors.push(cursor);
				const ids = cursor === 'old-cursor' ? omitted : cursor === 'new-cursor' ? ['still-here'] : [changed ? 'new-head' : 'old-head'];
				return Response.json({
					items: ids.map(id => ({ id, title: id })),
					cursor: cursor ? null : changed ? 'new-cursor' : 'old-cursor',
				});
			}
			const conversation = path.split('/').at(-1)!;
			if (path.includes('/conversation/')) {
				checks.push(conversation);
				if (conversation === 'deleted') return new Response(null, { status: 404 });
				if (conversation === 'unavailable') return new Response(null, { status: 503 });
				const gizmo_id = conversation === 'unassigned' ? null : conversation === 'moved' ? 'g-p-other' : conversation === 'unknown' ? undefined : id;
				return Response.json({ title: conversation, gizmo_id, is_archived: conversation === 'archived', current_node: 'root', mapping: { root: { parent: null } } });
			}
			return response(path);
		});
		await chat.reload();
		await chat.loadProjectConversations(id);
		await chat.loadProjectConversations(id, 'next');
		await chat.loadProjectConversations(id);
		assert.deepEqual(cursors, [null, 'old-cursor']);

		changed = true;
		mock.timers.tick(60_000);
		await chat.loadProjectConversations(id);
		const conversations = chat.state.get().conversations;
		assert.deepEqual(conversations.filter(row => row.projectId === id).map(row => row.id), ['new-head', 'old-head', 'still-here', 'unknown', 'unavailable']);
		assert.equal(conversations.find(row => row.id === 'moved')?.projectId, 'g-p-other');
		assert.ok(conversations.some(row => row.id === 'unassigned' && row.projectId === undefined));
		assert.ok(!conversations.some(row => row.id === 'archived' || row.id === 'deleted'));
		assert.deepEqual(new Set(checks), new Set(['old-head', ...omitted]));
		await chat.loadProjectConversations(id, 'next');
		assert.deepEqual(cursors, [null, 'old-cursor', null, 'new-cursor']);
		assert.equal(chat.state.get().conversations.filter(row => row.id === 'still-here').length, 1);
	});

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
			const paths: string[] = [];
			using fresh = fixture(async path => {
				paths.push(path);
				return response(path);
			}, { values });
			using ready = autorun(reader => {
				if (fresh.state.read(reader).connected) { void loaded.complete(); }
			});
			fresh.newChat({ clearDraft: true });
			await loaded.p;
			assert.equal(paths.length, 1);
			assert.ok(paths[0]?.includes('/models?'));
			assert.deepEqual(fresh.state.get().conversations.map(item => item.id), ['one', 'two']);
			assert.equal(fresh.state.get().draft, '');
			assert.equal(selectedChatConversationId(fresh.state.get()), undefined);
			fresh.setDraft('New draft to restore');
			assert.equal(fresh.setDraftCreationKind('design'), true);
		}
		using restoredNew = fixture(respond, { values });
		await restoredNew.reload();
		assert.equal(selectedChatConversationId(restoredNew.state.get()), undefined);
		assert.equal(restoredNew.state.get().draft, 'New draft to restore');
		assert.equal(restoredNew.state.get().draftCreationKind, 'design');
		await restoredNew.select('one');
		assert.equal(restoredNew.state.get().draft, 'Unsent follow-up');
		assert.equal(restoredNew.state.get().draftCreationKind, undefined);
		restoredNew.newChat();
		assert.equal(restoredNew.state.get().draftCreationKind, undefined);
	});
	test('restores legacy creation choices and only persists the creationKind field', () => {
		const id = 'a8d414f2-4f2a-47ef-91db-9054b51bdfc1';
		for (const reference of [{ id, artifactKind: 'docs' }, { id, artifactKind: 'slides', creationKind: 'docs' }]) {
			const values = new Map([
				['sessions.chatgpt.newDraftId', JSON.stringify(reference)],
				[`sessions.chatgpt.draft:${id}`, 'Original draft'],
			]);
			using chat = fixture(async () => assert.fail('Restoring a local draft must not make requests'), { values });
			assert.equal(chat.state.get().draftCreationKind, 'docs');
			assert.equal(chat.state.get().draft, 'Original draft');
			chat.setDraft('Edited draft');
			assert.deepEqual(JSON.parse(values.get('sessions.chatgpt.newDraftId')!), { id, creationKind: 'docs' });
		}
	});

	test('stages a draft attachment while the background upload retries each failed step', async () => {
		const putStarted = new DeferredPromise<void>();
		const putCanFail = new DeferredPromise<void>();
		const settled = new DeferredPromise<void>();
		const paths: string[] = [];
		let reservations = 0;
		let transfers = 0;
		let confirmations = 0;
		using chat = fixture(async path => {
			if (path === '/service/backend-api/files') {
				paths.push(path);
				return ++reservations === 1 ? new Response(null, { status: 502 })
					: Response.json({ file_id: 'file-draft', upload_url: 'https://fixture.test/draft' });
			}
			if (path.startsWith('/service/.upload?')) {
				paths.push(path);
				if (++transfers === 1) {
					void putStarted.complete();
					await putCanFail.p;
					throw new Error('net::ERR_CONNECTION_CLOSED');
				}
				return new Response(null, { status: 201 });
			}
			if (path === '/service/backend-api/files/file-draft/uploaded') {
				paths.push(path);
				return ++confirmations === 1 ? new Response(null, { status: 503 }) : Response.json({ status: 'success' });
			}
			assert.ok(!path.includes('/f/conversation'), 'A draft with a pending attachment must wait for confirmation');
			return response(path);
		}, { cacheScope: () => undefined });
		await chat.reload();
		using observeUpload = autorun(reader => {
			if (chat.state.read(reader).attachments.some(attachment => attachment.status !== 'uploading')) { void settled.complete(); }
		});
		let attachedLocally = false;
		const attachment = chat.attachFiles([new File(['draft'], 'draft.txt', { type: 'text/plain' })]).then(() => { attachedLocally = true; });
		try {
			await putStarted.p;
			assert.equal(attachedLocally, true);
			assert.equal(chat.state.get().attachments[0]?.status, 'uploading');
			assert.equal(chat.state.get().attachments[0]?.error, undefined);
			chat.setDraft('Still editing');
			await chat.send();
			assert.equal(chat.state.get().draft, 'Still editing');
		} finally {
			void putCanFail.complete();
		}
		await attachment;
		await settled.p;
		assert.equal(chat.state.get().attachments[0]?.status, 'ready');
		assert.equal(chat.state.get().attachments[0]?.file?.id, 'file-draft');
		assert.deepEqual(paths, [
			'/service/backend-api/files', '/service/backend-api/files',
			'/service/.upload?url=https%3A%2F%2Ffixture.test%2Fdraft', '/service/.upload?url=https%3A%2F%2Ffixture.test%2Fdraft',
			'/service/backend-api/files/file-draft/uploaded', '/service/backend-api/files/file-draft/uploaded',
		]);
	});

	for (const [status, expectedAttempts] of [[503, 3], [413, 1]]) {
		test(`reports a ${status} upload failure after ${expectedAttempts} attempts`, async () => {
			let attempts = 0;
			const failed = new DeferredPromise<void>();
			using chat = fixture(async path => {
				if (path === '/service/backend-api/files') {
					attempts++;
					return new Response(null, { status });
				}
				return response(path);
			}, { cacheScope: () => undefined });
			await chat.reload();
			using observeUpload = autorun(reader => {
				if (chat.state.read(reader).attachments[0]?.status === 'failed') { void failed.complete(); }
			});
			await chat.attachFiles([new File(['draft'], 'draft.txt')]);
			await failed.p;
			assert.equal(attempts, expectedAttempts);
			assert.match(chat.state.get().attachments[0]?.error ?? '', new RegExp(String(status), 'u'));
		});
	}

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
			[INotificationService, notificationService()],
			[IChatGPTTransport, new SyncDescriptor(ElectronChatGPTTransport, [], true)],
			[IChatGPTService, new SyncDescriptor(ChatGPTService, [], true)],
			[IArtifactCatalogService, createTestArtifactCatalogService()],
			[IDocsService, createTestDocsService()],
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
		assert.equal(chat.state.get().error, '');
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
			const { window, channel } = voiceWindow();
			await chat.reload(); await chat.startVoice(window);
			assert.equal(chat.state.get().voice, 'connected');
			channel.onmessage!({ data: JSON.stringify({ type: 'conversation_update', payload: { conversation_id: 'created-voice', parent_message_id: 'voice-reply' } }) });
			assert.equal(chat.state.get().conversationId, undefined);
			const moving = navigation === 'history' ? chat.select('two') : chat.newChat();
			await entered.p;
			assert.equal(chat.state.get().voice, 'stopping');
			assert.equal(chat.state.get().conversationId, undefined);
			assert.equal(channel.readyState, 'closed');
			await saved.complete(); await moving; await chat.stopVoice(); await Promise.resolve();
			assert.equal(chat.state.get().voice, 'idle');
			assert.equal(chat.state.get().conversationId, navigation === 'history' ? 'two' : undefined);
			assert.equal(chat.state.get().conversations.find(item => item.id === 'created-voice')?.title, 'Saved voice conversation');
			await chat.select('created-voice');
			assert.equal(chat.state.get().messages[0]?.text, 'Spoken reply');
		});
	}
	for (const failure of ['history read error', 'save timeout'] as const) {
		test(`Reload recovers a new voice conversation without a transcript after a ${failure}`, async () => {
			mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
			using clock = toDisposable(() => mock.timers.reset());
			let saved = false;
			let historyReads = 0;
			const voiceTargets: { conversation_id?: string; parent_message_id: string; }[] = [];
			const sendTargets: { id: string; parentId: string; }[] = [];
			using chat = fixture(async (path, _signal, request) => {
				if (path.startsWith('/service/realtime/vp?')) {
					assert.ok(request.body instanceof VSBuffer);
					const form = await new Response(new Uint8Array(request.body.buffer), { headers: request.headers }).formData();
					const session = form.get('session');
					assert.ok(typeof session === 'string');
					voiceTargets.push(JSON.parse(session));
					return new Response('v=0\r\ns=Answer\r\n');
				}
				if (path.endsWith('/conversation/created-voice')) {
					historyReads++;
					if (!saved) {
						if (failure === 'history read error') { return new Response(null, { status: 503 }); }
						mock.timers.tick(8_000);
						return response(path);
					}
					return Response.json({
						title: 'Saved voice conversation', current_node: 'voice-reply', mapping: {
							'voice-reply': { parent: null, message: { id: 'voice-reply', author: { role: 'assistant' }, content: { parts: ['Spoken reply'] } } },
						},
					});
				}
				if (path.includes('/.headers/')) { return Response.json({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'proof' }); }
				if (path.endsWith('/prepare')) { return Response.json({ conduit_token: 'fixture' }); }
				if (path.endsWith('/f/conversation')) {
					const body = JSON.parse(String(request.body));
					sendTargets.push({ id: body.conversation_id, parentId: body.parent_message_id });
					return new Response('data: {"conversation_id":"created-voice","message":{"id":"next","author":{"role":"assistant"},"content":{"parts":["Text reply"]}}}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
				}
				return response(path);
			});
			const { window, channel } = voiceWindow();
			await chat.reload();
			const draftId = chat.state.get().localConversationId;
			await chat.startVoice(window);
			const parent = failure === 'save timeout' ? { parent_message_id: 'voice-reply' } : {};
			channel.onmessage!({ data: JSON.stringify({ type: 'conversation_update', payload: { conversation_id: 'created-voice', ...parent } }) });
			assert.deepEqual(chat.state.get().voiceTranscript, []);
			await chat.stopVoice();
			assert.equal(historyReads, 1);
			assert.equal(chat.state.get().voice, 'idle');
			assert.equal(chat.state.get().conversationId, undefined);
			assert.equal(chat.state.get().uncertain, true);
			await chat.startVoice(voiceWindow().window);
			assert.equal(voiceTargets.length, 1);
			assert.equal(voiceTargets[0]?.conversation_id, undefined);
			chat.setDraft('Next message');
			await chat.send();
			assert.deepEqual(sendTargets, []);
			await chat.select('two');
			assert.equal(chat.state.get().conversationId, 'two');
			assert.equal(chat.state.get().uncertain, false);
			chat.newChat();
			assert.equal(chat.state.get().localConversationId, draftId);
			assert.equal(chat.state.get().uncertain, true);
			assert.equal(chat.state.get().draft, 'Next message');

			await chat.reload();
			assert.equal(historyReads, 2);
			assert.equal(chat.state.get().uncertain, true);
			assert.equal(chat.state.get().conversations.some(item => item.id === 'created-voice'), false);
			saved = true;
			await chat.reload();
			assert.equal(historyReads, 3);
			assert.equal(chat.state.get().uncertain, false);
			assert.equal(chat.state.get().conversationId, 'created-voice');
			assert.equal(chat.state.get().localConversationId, draftId);
			assert.equal(chat.state.get().draft, 'Next message');
			assert.equal(chat.state.get().parentId, 'voice-reply');
			assert.equal(chat.state.get().messages[0]?.text, 'Spoken reply');
			assert.equal(chat.state.get().conversations.find(item => item.id === 'created-voice')?.title, 'Saved voice conversation');

			chat.setDraft('');
			await chat.startVoice(voiceWindow().window);
			assert.equal(voiceTargets.length, 2);
			assert.equal(voiceTargets[1]?.conversation_id, 'created-voice');
			assert.equal(voiceTargets[1]?.parent_message_id, 'voice-reply');
			await chat.stopVoice();
			chat.setDraft('Next message');
			await chat.send();
			assert.deepEqual(sendTargets, [{ id: 'created-voice', parentId: 'voice-reply' }]);
		});
	}
	test('New abandons the unsaved voice history target', async () => {
		let historyReads = 0;
		using chat = fixture(async path => {
			if (path.startsWith('/service/realtime/vp?')) { return new Response('v=0\r\ns=Answer\r\n'); }
			if (path.endsWith('/conversation/created-voice')) {
				historyReads++;
				return new Response(null, { status: 404 });
			}
			return response(path);
		});
		const { window, channel } = voiceWindow();
		await chat.reload();
		await chat.startVoice(window);
		channel.onmessage!({ data: JSON.stringify({ type: 'conversation_update', payload: { conversation_id: 'created-voice' } }) });
		await chat.stopVoice();
		assert.equal(chat.state.get().uncertain, true);
		chat.newChat();
		await chat.reload();
		assert.equal(historyReads, 1);
		assert.equal(chat.state.get().uncertain, false);
		assert.equal(chat.state.get().conversationId, undefined);
	});
	test('pinned history merges once without advancing recent pagination, including after an archive', async () => {
		mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
		using clock = toDisposable(() => mock.timers.reset());
		const offsets: number[] = [];
		let failNextPage = true;
		using chat = fixture(async (path, _signal, request) => {
			if (request.method === 'PATCH') { return Response.json({ success: true }); }
			if (path.includes('/pins?')) { return Response.json([{ item: { id: 'old-pin', title: 'Old pin' } }, { item: { id: 'one', title: 'One' } }]); }
			if (path.includes('/gizmos/snorlax/sidebar?')) { return Response.json({ items: [{ gizmo: { id: 'g-p-project', display: { name: 'Project' } } }], cursor: null }); }
			if (path.includes('/conversations?')) {
				const query = new URL(path, 'https://test.invalid').searchParams;
				const offset = Number(query.get('offset')); offsets.push(offset);
				assert.equal(query.get('hide_snorlax'), 'false');
				if (offset && failNextPage) {
					failNextPage = false;
					return new Response(null, { status: 429 });
				}
				return Response.json({ items: offset ? [{ id: 'three', title: 'Three', gizmo_id: 'g-p-project' }] : [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }], total: 3 });
			}
			return response(path);
		});
		await chat.reload();
		assert.deepEqual(chat.state.get().conversations.map(item => [item.id, item.pinned]), [['one', true], ['two', false], ['old-pin', true]]);
		assert.deepEqual(chat.state.get().projects, [{ id: 'g-p-project', title: 'Project' }]);
		await chat.archive('two');
		await chat.loadMore();
		assert.equal(chat.state.get().error, '');
		assert.equal(chat.state.get().historyListFailed, true);
		await chat.loadMore();
		assert.deepEqual(offsets, [0, 1]);
		assert.deepEqual(chat.state.get().conversations.map(item => item.id), ['one', 'old-pin']);
		mock.timers.tick(60_000);
		await chat.loadMore();
		assert.deepEqual(offsets, [0, 1, 1]);
		assert.equal(chat.state.get().historyListFailed, false);
		assert.equal(chat.state.get().conversations.filter(item => item.id === 'one').length, 1);
		assert.equal(chat.state.get().conversations.find(item => item.id === 'three')?.projectId, 'g-p-project');
	});

	test('project and pin failures leave recent chats usable and report the error', async () => {
		using notifications = new NotificationsModel();
		using chat = fixture(async path => path.includes('/pins?') || path.includes('/gizmos/snorlax/sidebar?') ? new Response(null, { status: 503 }) : response(path), { notifications });
		await chat.reload();
		assert.equal(chat.state.get().connected, true);
		assert.equal(chat.state.get().conversations.length, 2);
		assert.equal(chat.state.get().error, '');
		assert.deepEqual(notifications.getNotifications().map(item => item.message), ['Could not sync ChatGPT history. Previously loaded chats are still available.']);
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

	test('refresh and reopen reuse a cached native transcript after loading an older page', async () => {
		const values = new Map<string, string>();
		const message = (id: string, role: string, text: string) => ({ id, author: { role }, content: { content_type: 'text', parts: [text] } });
		let earlierReads = 0;
		let tailReads = 0;
		const respond = async (path: string) => {
			if (path.includes('/conversations/one/messages?')) {
				earlierReads++;
				return Response.json({ messages: [message('older', 'user', 'Earlier question')], page_info: { has_previous_page: false } });
			}
			if (path.includes('/conversations/one?')) {
				tailReads++;
				return Response.json({
					title: 'One', current_node: 'reply', messages: [message('reply', 'assistant', 'Latest reply')],
					page_info: { has_previous_page: true, start_cursor: 'earlier' },
				});
			}
			return response(path);
		};
		{
			using chat = fixture(respond, { values, native: true });
			await chat.reload();
			await chat.select('one');
			await chat.loadOlderHistory();
			const loaded = chat.state.get().messages;
			assert.deepEqual(loaded.map(item => item.text), ['Earlier question', 'Latest reply']);
			await chat.refresh();
			assert.strictEqual(chat.state.get().messages, loaded);
			assert.equal(chat.state.get().olderCursor, undefined);
			assert.equal(tailReads, 2);
		}
		using reopened = fixture(respond, { values, native: true });
		let cached: ReturnType<typeof reopened.state.get>['messages'] | undefined;
		using listener = autorun(reader => {
			const { messages, uncertain } = reopened.state.read(reader);
			if (uncertain && messages.length) cached ??= messages;
		});
		await reopened.reload();
		assert.ok(cached);
		assert.deepEqual(cached.map(item => item.text), ['Earlier question', 'Latest reply']);
		assert.strictEqual(reopened.state.get().messages, cached);
		assert.equal(reopened.state.get().uncertain, false);
		assert.equal(tailReads, 3);
		assert.equal(earlierReads, 1);
	});

	test('recovers image metadata in an older native transcript cached before image decoding', async () => {
		const scope = 'a'.repeat(64);
		const timeline = `sessions.chat.timeline.v1:chatgpt-web:${scope}:one`;
		const query = 'Project diagram';
		const imageUri = 'https://images.openai.com/static-rsc-4/diagram?purpose=fullsize';
		const older = { id: 'older', role: 'assistant', text: `<AsyncImage query="${query}"/>` };
		const unavailable = { id: 'unavailable', role: 'assistant', text: '<AsyncImage ref="missing"/>' };
		const latest = { id: 'latest', role: 'assistant', text: 'Latest reply' };
		const values = new Map([
			[`sessions.chatgptExperimental.conversation:${scope}`, 'one'],
			[timeline, JSON.stringify({
				localId: 'local-one', tasks: [], history: {
					title: 'One', parentId: latest.id, olderCursor: 'unloaded', messages: [older, unavailable, latest],
				}
			})],
		]);
		const remote = (reply: typeof older, metadata?: object) => ({
			id: reply.id, author: { role: reply.role }, content: { content_type: 'text', parts: [reply.text] }, metadata,
		});
		const diagram = {
			componentName: 'AsyncImage', status: 'resolved',
			state: { images: [{ content_url: imageUri, image_search_query: query, title: query }] },
		};
		const olderWithImage = remote(older, {
			model_dil_v2: { appData: { opGenui: { componentResults: { diagram } } } },
		});
		let earlierReads = 0;
		using chat = fixture(async path => {
			if (path.includes('/conversations/one/messages?')) {
				assert.equal(new URL(path, 'https://chatgpt.com').searchParams.get('before'), 'earlier');
				if (++earlierReads === 1) return new Response(null, { status: 503 });
				return Response.json({
					messages: [olderWithImage, remote(unavailable)],
					page_info: { has_previous_page: true, start_cursor: 'unloaded' },
				});
			}
			if (path.includes('/conversations/one?')) {
				return Response.json({
					title: 'One', current_node: latest.id, messages: [remote(latest)],
					page_info: { has_previous_page: true, start_cursor: 'earlier' },
				});
			}
			return response(path);
		}, { values, native: true });
		await chat.reload();
		assert.deepEqual(chat.state.get().messages.map(message => message.id), [older.id, unavailable.id, latest.id]);
		assert.equal(chat.state.get().messages[0]?.asyncImagesDecoded, undefined);
		await chat.reload();
		const { messages, olderCursor } = chat.state.get();
		assert.deepEqual(messages.map(message => message.id), [older.id, unavailable.id, latest.id]);
		assert.deepEqual(messages[0]?.imageGroups, [{ query, images: [{ uri: imageUri, label: query, source: undefined }] }]);
		assert.equal(messages[1]?.imageGroups, undefined);
		assert.equal(messages[1]?.asyncImagesDecoded, true);
		assert.equal(olderCursor, 'unloaded');
		assert.deepEqual(JSON.parse(values.get(timeline)!).history.messages[0].imageGroups, [
			{ query, images: [{ uri: imageUri, label: query }] },
		]);
		await chat.reload();
		assert.equal(earlierReads, 2);
	});

	test('cold restore and followup remain usable when only the recent list is rate-limited', async () => {
		mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
		using clock = toDisposable(() => mock.timers.reset());
		let sends = 0;
		let historyRateLimited = true;
		const legacyTimeline = 'sessions.chat.timeline.v1:chatgpt-web:one';
		const values = new Map([
			['sessions.chatgpt.conversation', 'one'],
			[legacyTimeline, JSON.stringify({ localId: 'legacy-local-id', tasks: [], history: { title: 'Legacy title', parentId: 'legacy-reply', messages: [] } })],
		]);
		using chat = fixture(async (path, _signal, request) => {
			if (historyRateLimited && path.includes('/conversations?')) { return new Response(null, { status: 429 }); }
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
		assert.equal(chat.state.get().error, '');
		assert.equal(chat.state.get().historyListFailed, true);
		chat.setDraft('Continue after reopening'); await chat.send();
		assert.equal(sends, 1); assert.equal(chat.state.get().error, '');
		assert.equal(chat.state.get().historyListFailed, true);
		historyRateLimited = false;
		await chat.refresh();
		assert.equal(chat.state.get().historyListFailed, true);
		mock.timers.tick(60_000);
		await chat.refresh();
		assert.equal(chat.state.get().historyListFailed, false);
	});

	test('a 429 on the post-reply read keeps the accepted reply and draft cleared', async () => {
		let sent = false;
		using chat = fixture(async path => {
			if (path.includes('/.headers/')) { return Response.json({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'proof' }); }
			if (path.endsWith('/prepare')) { return Response.json({ conduit_token: 'fixture' }); }
			if (path.endsWith('/f/conversation')) {
				sent = true;
				return new Response('data: {"conversation_id":"one","message":{"id":"next","author":{"role":"assistant"},"content":{"parts":["Accepted reply"]}}}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
			}
			if (sent && path.endsWith('/conversation/one')) { return new Response(null, { status: 429, headers: { 'Retry-After': '26' } }); }
			return response(path);
		});
		await chat.reload();
		await chat.select('one');
		chat.setDraft('Question');
		await chat.send();
		assert.equal(sent, true);
		assert.equal(chat.state.get().messages.at(-1)?.text, 'Accepted reply');
		assert.equal(chat.state.get().error, '');
		assert.equal(chat.state.get().draft, '');
		assert.equal(chat.state.get().uncertain, false);
	});

	test('refresh reads only the recent head and keeps cached pages and the active chat usable', async () => {
		mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
		using clock = toDisposable(() => mock.timers.reset());
		const values = new Map<string, string>();
		const offsets: number[] = [];
		let sidebarReads = 0;
		let ids = ['one', 'two', 'older'];
		let unavailable = false;
		let revised = false;
		const respond = async (path: string): Promise<Response> => {
			if (path.includes('/pins?') || path.includes('/gizmos/snorlax/sidebar?')) { sidebarReads++; }
			if (path.includes('/conversations?')) {
				const offset = Number(new URL(path, 'https://fixture.invalid').searchParams.get('offset'));
				offsets.push(offset);
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
		await chat.refresh();
		assert.deepEqual(offsets, [0, 2]);
		revised = true;
		mock.timers.tick(5 * 60_000);
		await Promise.all([chat.refresh(), chat.refresh()]);
		assert.deepEqual(offsets, [0, 2, 0]);
		assert.equal(sidebarReads, 2);
		assert.equal(chat.state.get().messages[0]?.text, 'Updated remotely');
		assert.equal(chat.state.get().draft, 'Unsent text');

		ids = ['new', 'one', 'older'];
		unavailable = true;
		mock.timers.tick(5 * 60_000);
		await chat.refresh();
		assert.deepEqual(offsets, [0, 2, 0, 0]);
		assert.deepEqual(chat.state.get().conversations.map(item => item.id), ['new', 'one', 'two', 'older']);
		await chat.loadMore();
		assert.deepEqual(offsets, [0, 2, 0, 0, 2]);
		assert.equal(chat.state.get().conversationId, 'two');
		assert.equal(chat.state.get().messages[0]?.text, 'Updated remotely');
		unavailable = false;
		mock.timers.tick(5 * 60_000);
		await chat.refresh();
		assert.equal(sidebarReads, 4);
		assert.deepEqual(chat.state.get().conversations.map(item => item.id), ids);
		assert.equal(chat.state.get().conversationId, undefined);
		assert.equal(chat.state.get().draft, 'Unsent text');
		assert.ok(![...values.keys()].some(key => key.startsWith('sessions.chat.timeline.v1:') && key.endsWith(':two')));

		using offline = fixture(async () => new Response(null, { status: 503 }), { values });
		await offline.reload();
		assert.deepEqual(offline.state.get().conversations.map(item => item.id), ids);
		assert.deepEqual(offline.state.get().messages, []);
	});

	test('manual reload shows the latest Web chats when an older page is rate-limited', async () => {
		mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
		using clock = toDisposable(() => mock.timers.reset());
		const offsets: number[] = [];
		let ids = ['one', 'two', 'older'];
		let rateLimited = false;
		using chat = fixture(async path => {
			if (!path.includes('/conversations?')) return response(path);
			const offset = Number(new URL(path, 'https://fixture.invalid').searchParams.get('offset'));
			offsets.push(offset);
			if (offset && rateLimited) return new Response(null, { status: 429, headers: { 'Retry-After': '30' } });
			return Response.json({ items: ids.slice(offset, offset + 2).map(id => ({ id, title: id })), total: ids.length });
		});
		await chat.reload();
		await chat.loadMore();
		ids = ['new', ...ids];
		rateLimited = true;
		await chat.reload();
		assert.deepEqual(offsets, [0, 2, 0, 2]);
		assert.deepEqual(chat.state.get().conversations.map(item => item.id), ids);
		assert.equal(chat.state.get().hasMore, true);
		assert.equal(chat.state.get().historyListFailed, true);

		rateLimited = false;
		mock.timers.tick(29_999);
		await chat.refresh();
		assert.deepEqual(offsets, [0, 2, 0, 2]);
		assert.equal(chat.state.get().conversations[0]?.id, 'new');
		mock.timers.tick(1);
		await chat.refresh();
		assert.deepEqual(offsets, [0, 2, 0, 2, 0]);
		assert.equal(chat.state.get().historyListFailed, false);
		await chat.loadMore();
		assert.deepEqual(offsets, [0, 2, 0, 2, 0, 2]);
		assert.deepEqual(chat.state.get().conversations.map(item => item.id), ids);
		assert.equal(chat.state.get().hasMore, false);
	});

	test('refresh recalibrates recent pagination when a later page changes but the head stays the same', async () => {
		mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
		using clock = toDisposable(() => mock.timers.reset());
		const offsets: number[] = [];
		let ids = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];
		using chat = fixture(async path => {
			if (!path.includes('/conversations?')) { return response(path); }
			const offset = Number(new URL(path, 'https://fixture.invalid').searchParams.get('offset'));
			offsets.push(offset);
			return Response.json({ items: ids.slice(offset, offset + 2).map(id => ({ id, title: id })), total: ids.length });
		});
		await chat.reload();
		await chat.loadMore();
		assert.deepEqual(chat.state.get().conversations.map(item => item.id), ids.slice(0, 4));

		ids = ids.filter(id => id !== 'three');
		mock.timers.tick(5 * 60_000);
		await chat.refresh();
		assert.deepEqual(chat.state.get().conversations.map(item => item.id), ['one', 'two', 'three', 'four']);
		await chat.loadMore();
		await chat.loadMore();

		assert.deepEqual(offsets, [0, 2, 0, 2, 4]);
		assert.deepEqual(chat.state.get().conversations.map(item => item.id).slice(0, ids.length), ids);
		assert.equal(chat.state.get().hasMore, false);
	});

	test('a remote snapshot in flight cannot undo an acknowledged local delete', async () => {
		mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
		using clock = toDisposable(() => mock.timers.reset());
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
		mock.timers.tick(5 * 60_000);
		const stale = chat.refresh();
		await entered.p;
		await chat.deleteConversation('two');
		await released.complete();
		await stale;
		assert.ok(deleted);
		assert.deepEqual(chat.state.get().conversations.map(item => item.id), ['one']);
	});

	for (const kind of chatCreationKinds) {
		test(`${kind} creation reaches the real online request and survives offline replay without changing displayed text`, async () => {
			const text = 'Create the requested work';
			const sent: string[] = [];
			let user: { id: string; author: { role: string; }; content: { parts: string[]; }; } | undefined;
			const respond = async (path: string, _signal: AbortSignal, request: ChatGPTRequest): Promise<Response> => {
				if (path.includes('/.headers/')) return Response.json({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'proof' });
				if (path.endsWith('/prepare')) return Response.json({ conduit_token: 'fixture' });
				if (path.endsWith('/f/conversation')) {
					const body = JSON.parse(String(request.body));
					user = body.messages[0];
					sent.push(user!.content.parts[0]!);
					assert.equal(body.creationKind, undefined);
					return new Response('data: {"conversation_id":"created"}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
				}
				if (path.endsWith('/conversation/created')) {
					return Response.json({
						title: 'Created', current_node: 'reply', mapping: {
							question: { parent: null, message: user },
							reply: { parent: 'question', message: { id: 'reply', author: { role: 'assistant' }, status: 'finished_successfully', content: { parts: [':::writing{title="Document"}\n# Document\n:::'] } } },
						}
					});
				}
				return response(path);
			};
			using online = fixture(respond);
			await online.reload();
			assert.equal(online.setDraftCreationKind(kind), true);
			online.setDraft(text);
			await online.send();
			assert.equal(sent.length, 1);
			assert.ok(sent[0]!.startsWith(text + '\n\n'));
			assert.ok(sent[0]!.includes(`name="ash.creation.${kind}"`));
			assert.ok(sent[0]!.includes(getChatCreationContext(kind).content));
			if (kind === 'docs') assert.match(sent[0]!, /:::writing\{title="Document title"\}/u);
			assert.equal(online.state.get().messages.find(message => message.role === 'user')?.text, text);
			assert.equal(online.state.get().messages.find(message => message.role === 'user')?.editableText, text);

			const values = new Map<string, string>();
			using queued = fixture(respond, { values });
			await queued.reload();
			queued.setNetworkAvailable(false);
			assert.equal(queued.setDraftCreationKind(kind), true);
			queued.setDraft(text);
			await queued.send();
			assert.equal(queued.state.get().messages[0]?.text, text);
			assert.equal(sent.length, 1);
			queued.dispose();
			using reopened = fixture(respond, { values });
			reopened.setNetworkAvailable(false);
			await reopened.reload();
			assert.equal(reopened.state.get().messages[0]?.text, text);
			reopened.setNetworkAvailable(true);
			await reopened.refresh();
			assert.equal(sent.length, 2);
			assert.equal(sent[1], sent[0]);
			assert.equal(reopened.state.get().messages.find(message => message.role === 'user')?.text, text);
			assert.equal(reopened.state.get().messages.find(message => message.role === 'user')?.creationKind, kind);
			assert.equal(reopened.state.get().messages.find(message => message.role === 'assistant')?.completion, 'complete');
		});
	}

	test('stopping before submit and a rejected first send preserve the creation choice for retry', async () => {
		const preparing = new DeferredPromise<void>();
		const release = new DeferredPromise<void>();
		const posts: string[] = [];
		let holdPreparation = true;
		using chat = fixture(async (path, _signal, request) => {
			if (path.includes('/.headers/')) return Response.json({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'proof' });
			if (path.endsWith('/prepare')) {
				if (holdPreparation) {
					void preparing.complete();
					await release.p;
				}
				return Response.json({ conduit_token: 'fixture' });
			}
			if (path.endsWith('/f/conversation')) {
				posts.push(JSON.parse(String(request.body)).messages[0].content.parts[0]);
				if (posts.length === 1) return new Response(null, { status: 400 });
				return new Response('data: {"conversation_id":"created"}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
			}
			return response(path);
		});
		await chat.reload();
		const draft = 'Create the plan';
		chat.setDraft(draft);
		assert.equal(chat.setDraftCreationKind('sheet'), true);
		const sending = chat.send();
		await preparing.p;
		try {
			await chat.select('two');
			assert.equal(chat.state.get().conversationId, undefined, 'Navigation waits for the active send');
			await chat.stop();
		} finally {
			holdPreparation = false;
			await release.complete();
		}
		await sending;
		assert.deepEqual(posts, []);
		assert.deepEqual(chat.state.get().messages, []);
		assert.equal(chat.state.get().draft, draft);
		assert.equal(chat.state.get().draftCreationKind, 'sheet');

		await chat.send();
		assert.equal(chat.state.get().uncertain, false);
		assert.equal(chat.state.get().draft, draft);
		assert.equal(chat.state.get().draftCreationKind, 'sheet');
		assert.equal(chat.setDraftCreationKind('slides'), true);
		await chat.send();
		assert.equal(posts.length, 2);
		assert.match(posts[0]!, /name="ash\.creation\.sheet"/u);
		assert.match(posts[1]!, /name="ash\.creation\.slides"/u);
		assert.doesNotMatch(posts[1]!, /name="ash\.creation\.sheet"/u);
		assert.equal(chat.state.get().conversationId, 'created');
	});

	test('offline creation and deletion survive restart, retry safely and suppress stale cloud rows', async () => {
		const values = new Map<string, string>();
		let available = false;
		let deleteRequests = 0;
		let postRequests = 0;
		const projectMoves: unknown[] = [];
		const preparedIds: string[] = [];
		const respond = async (path: string, _signal: AbortSignal, request: ChatGPTRequest): Promise<Response> => {
			if (request.method === 'DELETE') {
				assert.ok(path.endsWith('/conversation/id/two'));
				deleteRequests++;
				return new Response(null, { status: available ? 204 : 503 });
			}
			if (path.includes('/gizmos/snorlax/sidebar?')) {
				return Response.json({ items: [{ gizmo: { id: 'g-research', display: { name: 'Research' } } }], cursor: null });
			}
			if (request.method === 'PATCH' && path.endsWith('/conversation/created-offline')) {
				projectMoves.push(JSON.parse(String(request.body)));
				return new Response(null, { status: 204 });
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
		initial.setDraftTarget({ projectId: 'g-research' });
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
		assert.equal(reopened.state.get().conversations.find(item => item.id === pendingId)?.projectId, 'g-research');
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
		assert.equal(reopened.state.get().conversations.find(item => item.id === 'created-offline')?.projectId, 'g-research');
		assert.deepEqual(projectMoves, [{ gizmo_id: 'g-research' }]);
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
			await reopened.reload();
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
		await chat.moveToProject('one', null);
		assert.equal(chat.state.get().conversations[0]!.projectId, undefined);
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
			['POST', { title: 'Renamed' }], ['PATCH', { is_starred: true }], ['PATCH', { gizmo_id: 'g-p-project' }], ['PATCH', { gizmo_id: null }],
			['PATCH', { is_archived: true }], ['PATCH', { is_archived: true }], ['DELETE', undefined],
		]);
		assert.ok(writes[0]!.path.endsWith('/conversation/id/one/rename'));
		assert.ok(writes.at(-1)!.path.endsWith('/conversation/id/two'));
	});

	test('a failed move keeps the newly created project available for retry', async () => {
		let creates = 0;
		let rejectMove = true;
		using chat = fixture(async (path, _signal, request) => {
			if (request.method === 'POST' && path.endsWith('/projects')) {
				creates++;
				return Response.json({ gizmo: { id: 'g-p-new' } });
			}
			if (request.method === 'PATCH' && path.endsWith('/conversation/one')) {
				return rejectMove ? new Response(null, { status: 500 }) : Response.json({ success: true });
			}
			return response(path);
		});
		await chat.reload();
		const originalProject = chat.state.get().conversations.find(item => item.id === 'one')?.projectId;
		assert.deepEqual(await chat.createProject({ name: 'New project', description: '' }, 'one'), { id: 'g-p-new', moveFailed: true });
		assert.ok(chat.state.get().projects.some(project => project.id === 'g-p-new'));
		assert.equal(chat.state.get().conversations.find(item => item.id === 'one')?.projectId, originalProject);
		rejectMove = false;
		await chat.moveToProject('one', 'g-p-new');
		assert.equal(chat.state.get().conversations.find(item => item.id === 'one')?.projectId, 'g-p-new');
		assert.equal(creates, 1);
	});

	test('does not move a conversation when ChatGPT creates a project with a different memory mode', async () => {
		let moves = 0;
		using chat = fixture(async (path, _signal, request) => {
			if (request.method === 'POST' && path.endsWith('/projects')) {
				return Response.json({ resource: { gizmo: { id: 'g-p-new', memory_scope: 'global' } } });
			}
			if (request.method === 'PATCH' && path.endsWith('/conversation/one')) moves++;
			return response(path);
		});
		await chat.reload();
		const created = await chat.createProject({ name: 'Private project', description: '', memoryMode: 'projectOnly' }, 'one');
		assert.equal(created.id, 'g-p-new');
		assert.ok(created.warning);
		assert.ok(chat.state.get().projects.some(project => project.id === created.id));
		assert.equal(moves, 0);
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

	test('catalog reload reads every project page and share links reject a foreign origin', async () => {
		using chat = fixture(async (path, _signal, request) => {
			if (path.includes('/gizmos/snorlax/sidebar?')) {
				const next = new URL(path, 'https://test.invalid').searchParams.get('cursor');
				return Response.json({ items: [{ gizmo: { id: next ? 'g-p-two' : 'g-p-one', display: { name: next ? 'Two' : 'One' } } }], cursor: next ? null : 'next' });
			}
			if (request.method === 'POST' && path.endsWith('/share/v2/create')) { return Response.json({ share_url: 'https://other.test/share/one' }); }
			return response(path);
		});
		await chat.reload();
		assert.deepEqual(chat.state.get().projects, [{ id: 'g-p-one', title: 'One' }, { id: 'g-p-two', title: 'Two' }]);
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
		assert.equal(chat.state.get().linkedTasks[0]?.thread?.turns[0]?.status, 'running');
		assert.match(chat.getAccessibleContent(), /Collect sources/u);
		await chat.select('two');
		assert.equal(chat.state.get().linkedTasks.length, 0);
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
		assert.equal(chat.state.get().linkedTasks.length, 1);
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
		assert.equal(reopened.state.get().linkedTasks[0]?.thread?.turns[0]?.status, 'completed');
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
		using notifications = new NotificationsModel();
		using chat = fixture(async path => fail ? new Response(null, { status: 401 }) : response(path), { notifications });
		chat.setDraft('new draft');
		await chat.reload();
		assert.equal(chat.state.get().draft, 'new draft');
		await chat.select('one'); chat.setDraft('conversation draft');
		const messages = chat.state.get().messages;
		fail = true; await chat.reload();
		assert.equal(chat.state.get().error, '');
		assert.equal(notifications.getNotifications().length, 1);
		assert.equal(chat.state.get().connected, true);
		assert.equal(chat.state.get().draft, 'conversation draft');
		assert.equal(chat.state.get().conversationId, 'one');
		assert.equal(chat.state.get().messages, messages);
		fail = false; await chat.reload();
		assert.equal(chat.state.get().error, '');
		assert.equal(notifications.getNotifications().length, 0);
		assert.equal(chat.state.get().draft, 'conversation draft');
		assert.equal(chat.state.get().conversationId, 'one');
		chat.newChat(); assert.equal(chat.state.get().draft, 'new draft');
	});

	test('shares one history notification across recent, project, and conversation rate limits', async () => {
		const requests: string[] = [];
		let rateLimited = false;
		using notifications = new NotificationsModel();
		using chat = fixture(async path => {
			if (path.includes('/gizmos/snorlax/sidebar?')) {
				return Response.json({ items: [{ gizmo: { id: 'g-p-one', display: { name: 'Project' } } }], cursor: null });
			}
			if (path.includes('/conversations?') || path.endsWith('/conversation/one')) {
				requests.push(path);
				if (rateLimited) { return new Response(null, { status: 429, headers: { 'Retry-After': '30' } }); }
				if (path.includes('/gizmos/g-p-one/')) { return Response.json({ items: [], cursor: null }); }
			}
			return response(path);
		}, { notifications });
		await chat.reload();
		await chat.select('one');
		const cached = chat.state.get().messages;
		requests.length = 0;
		rateLimited = true;
		await Promise.all([chat.reload(), chat.loadProjectConversations('g-p-one')]);
		assert.equal(requests.length, 3);
		const [notice] = notifications.getNotifications();
		assert.equal(notifications.getNotifications().length, 1);
		assert.match(String(notice?.message), /temporarily limiting history requests/u);
		await notice?.actions?.primary?.[0]?.run();
		assert.equal(requests.length, 3);
		assert.deepEqual(notifications.getNotifications().map(item => item.id), [notice?.id]);
		assert.equal(chat.state.get().messages, cached);
		assert.equal(chat.state.get().error, '');
	});
});
