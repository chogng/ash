import { createServer } from 'node:http';
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { Editor } from '../../../automation/editor.js';
import { drawImageAnnotation } from '../../../automation/design.js';
import type { Workbench } from '../../../automation/workbench.js';
import { readUserSettings, writeUserSettings } from '../../../automation/settings.js';
import { simpleChatGPTModelCatalog } from '../../../fixtures/chatGPTModels.js';
import { chatGPTAuthDocument } from '../../../fixtures/chatGPTAuth.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import shareWorker from '../../../../services/chat-share/worker.js';
import { connectProfile } from './sessionProfileFixture.js';

declare global {
	var ashNativeFixture: { advance(): void; readonly sends: number; readonly pendingInitializations: number; readonly cancelledInitializations: number; releaseInitialization(): void; setOffline(value: boolean): void; setRecentHistoryRateLimited(value: boolean): void; setClockOffset(milliseconds: number): void; readonly recentHistoryRequests: number; holdUploads(value: boolean): void; readonly heldUploads: number; readonly uploadedFiles: Record<string, string>; };
}

/** Keep production IPC, Rust authentication, transport, verification and UI; replace only service I/O. */
async function installService(application: ElectronApplication, holdInitialization = false, historyReplySuffix = '', historyImage = false, projectFiles = false): Promise<void> {
	await application.evaluate(async ({ app, session, webContents }, { catalog, authentication, holdInitialization, historyReplySuffix, historyImage, projectFiles }) => {
		const fs = process.getBuiltinModule('fs/promises');
		const path = process.getBuiltinModule('path');
		const home = path.join(process.env.HOME!, '.codex');
		await fs.mkdir(home, { recursive: true });
		await fs.writeFile(path.join(home, 'auth.json'), authentication);
		let sends = 0; let step = 0; let reply: ReadableStreamDefaultController<Uint8Array> | undefined;
		let cancelledInitializations = 0;
		let offline = false;
		let recentHistoryRateLimited = false;
		let recentHistoryRequests = 0;
		let uploadsHeld = false;
		let heldUploads = 0;
		const now = Date.now;
		const uploadedFiles: Record<string, string> = {};
		const initializing = new Set<() => void>();
		const pendingUploads = new Set<() => void>();
		const message = (id: string, role: string, text: string, create_time?: number) => ({ id, author: { role }, content: { content_type: 'text', parts: [text] }, create_time });
		const live: Record<string, { parent: string | null; message: ReturnType<typeof message>; }> = {};
		let head: string | null = null;
		let userId = '';
		let liveTitle = 'Live fixture';
		const chunk = (text: string) => {
			const id = `reply-live-${sends}`;
			live[id] = { parent: userId, message: message(id, 'assistant', text, 1_794_245_520 + (sends - 1) * 60) }; head = id;
			return new TextEncoder().encode(`data: ${JSON.stringify({ conversation_id: 'fixture-live', message: live[id]!.message })}\n\n`);
		};
		globalThis.ashNativeFixture = {
			get sends() { return sends; },
			get pendingInitializations() { return initializing.size; },
			get cancelledInitializations() { return cancelledInitializations; },
			setOffline(value) { offline = value; },
			setRecentHistoryRateLimited(value) { recentHistoryRateLimited = value; },
			setClockOffset(milliseconds) { Date.now = milliseconds === 0 ? now : () => now() + milliseconds; },
			get recentHistoryRequests() { return recentHistoryRequests; },
			holdUploads(value) {
				uploadsHeld = value;
				if (!value) for (const release of pendingUploads) release();
			},
			get heldUploads() { return heldUploads; },
			get uploadedFiles() { return uploadedFiles; },
			releaseInitialization() {
				holdInitialization = false;
				for (const release of [...initializing]) { release(); }
			},
			advance() {
				step++;
				reply!.enqueue(chunk(step === 1 ? 'First chunk, second chunk' : 'First chunk, second chunk, complete'));
				if (step === 2) {
					// The server continuation can be a hidden leaf after the visible reply.
					const id = `leaf-${sends}`; live[id] = { parent: head, message: message(id, 'assistant', '') }; head = id;
					reply!.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); reply!.close();
				}
			},
		};
		const installed = new WeakSet<Electron.Session>();
		const install = (storage: Electron.Session) => {
			if (installed.has(storage)) { return; } installed.add(storage);
			storage.protocol.handle('https', request => {
				const url = new URL(request.url);
				if (url.hostname !== 'chatgpt.com') { return new Response(null, { status: 404 }); }
				if (url.pathname === '/sentinel-fixture.js') {
					return new Response('export const api = { finalizeChatRequirements: async () => ({ chatRequirementsToken: "synthetic-proof" }) };', { headers: { 'Content-Type': 'text/javascript' } });
				}
				return new Response('<!doctype html><title>ChatGPT verification fixture</title><script type="module" src="/sentinel-fixture.js"></script>', { headers: { 'Content-Type': 'text/html' } });
			});
			storage.fetch = async (input, init) => {
				const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
				if (url.origin === 'https://fixture.oaiusercontent.com' && init?.method === 'PUT') {
					uploadedFiles[decodeURIComponent(url.pathname.slice(1))] = Buffer.from(init.body as Uint8Array).toString('utf8');
					return new Response(null, { status: 204 });
				}
				if (url.hostname !== 'chatgpt.com') { throw new Error('Unexpected fixture origin'); }
				if (historyImage && url.pathname === '/backend-api/files/file_diagram/download') {
					return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#396da8"/></svg>', { headers: { 'Content-Type': 'image/svg+xml' } });
				}
				if (url.pathname === '/backend-api/conversations') { recentHistoryRequests++; }
				if (offline) { return new Response(null, { status: 503 }); }
				if (url.pathname.endsWith('/files') && init?.method === 'POST') {
					const { file_name: name } = JSON.parse(String(init.body));
					if (uploadsHeld) {
						heldUploads++;
						await new Promise<void>((resolve, reject) => {
							const signal = init.signal!;
							const release = () => { pendingUploads.delete(release); signal.removeEventListener('abort', abort); resolve(); };
							const abort = () => { pendingUploads.delete(release); reject(signal.reason); };
							signal.throwIfAborted();
							pendingUploads.add(release);
							signal.addEventListener('abort', abort, { once: true });
						});
					}
					return Response.json({ file_id: 'file-' + name.replace(/[^a-z0-9]/gu, '-'), upload_url: 'https://fixture.oaiusercontent.com/' + encodeURIComponent(name) + '?fixture=1' });
				}
				if (url.pathname.endsWith('/uploaded')) { return Response.json({ status: 'success' }); }
				if (url.pathname.endsWith('/models')) {
					if (holdInitialization) {
						await new Promise<void>((resolve, reject) => {
							const release = () => { initializing.delete(release); init?.signal?.removeEventListener('abort', abort); resolve(); };
							const abort = () => { cancelledInitializations++; initializing.delete(release); reject(init!.signal!.reason); };
							init?.signal?.throwIfAborted();
							initializing.add(release);
							init?.signal?.addEventListener('abort', abort, { once: true });
						});
					}
					return Response.json(catalog);
				}
				if (url.pathname.endsWith('/pins')) { return Response.json([{ item: { id: 'history-pin', title: 'Pinned native history' } }]); }
				if (url.pathname.endsWith('/gizmos/snorlax/sidebar')) {
					return Response.json({ items: projectFiles ? [{ gizmo: { id: 'g-p-files-fixture', display: { name: 'File project fixture' } } }] : [], cursor: null });
				}
				if (projectFiles && url.pathname === '/backend-api/gizmos/g-p-files-fixture') {
					return Response.json({
						gizmo: { id: 'g-p-files-fixture', display: { name: 'File project fixture' } },
						files: [{ file_id: 'file-fixture-notes', name: 'project-fixture.txt' }, { file_id: 'file-fixture-other', name: 'other-fixture.txt' }],
					});
				}
				if (projectFiles && url.pathname.startsWith('/backend-api/files/download/file-fixture-')) {
					return new Response(url.pathname.endsWith('-notes') ? 'Saved project material fixture' : 'Second project file');
				}
				if (url.pathname.endsWith('/conversations')) {
					if (recentHistoryRateLimited) return new Response(null, { status: 429 });
					const items = [{ id: 'history-one', title: 'First native history' }, { id: 'history-two', title: 'Second native history' }, ...Array.from({ length: 30 }, (_, index) => ({ id: `history-extra-${index}`, title: `Additional history ${index}` }))];
					return Response.json({ items, total: items.length });
				}
				if (url.pathname === '/backend-api/conversations/history-one') {
					return Response.json({
						title: 'First native history', current_node: 'native-answer',
						messages: [message('native-answer', 'assistant', 'Experimental history answer')],
						page_info: { has_previous_page: true, start_cursor: 'fixture-before' },
					});
				}
				if (url.pathname === '/backend-api/conversations/history-one/messages' && url.searchParams.get('before') === 'fixture-before') {
					return Response.json({
						messages: [message('native-question', 'user', 'Experimental earlier question')],
						page_info: { has_previous_page: false },
					});
				}
				if (url.pathname === '/backend-api/conversations/fixture-live') {
					return Response.json({
						title: 'Live fixture', current_node: head,
						messages: Object.values(live).map(node => node.message),
						page_info: { has_previous_page: false },
					});
				}
				if (url.pathname.endsWith('/conversation/fixture-live')) {
					if (init?.method === 'PATCH' && typeof JSON.parse(String(init.body)).is_starred === 'boolean') return Response.json({ success: true });
					return Response.json({ title: liveTitle, current_node: head, mapping: live });
				}
				if (url.pathname.endsWith('/conversation/id/fixture-live/rename') && init?.method === 'POST') {
					liveTitle = JSON.parse(String(init.body)).title;
					return Response.json({ success: true });
				}
				if (url.pathname.endsWith('/conversation/id/fixture-live') && init?.method === 'DELETE') {
					return Response.json({ success: true });
				}
				if (url.pathname.endsWith('/share/v2/create') && init?.method === 'POST') {
					const body = JSON.parse(String(init.body));
					if (body.conversation_id !== 'fixture-live' || body.current_node_id !== head) return Response.json({ error: 'Wrong share target' }, { status: 400 });
					return Response.json({ share_url: 'https://chatgpt.com/share/fixture-live' });
				}
				if (url.pathname.endsWith('/conversation/new_branch') && init?.method === 'POST') {
					const body = JSON.parse(String(init.body));
					if (body.conversation_id !== 'fixture-live' || body.message_id !== 'reply-live-1') {
						return Response.json({ error: 'Wrong fork target' }, { status: 400 });
					}
					return Response.json({
						conversation: {
							title: 'Fork preview', current_node: body.message_id,
							mapping: { ...live, [body.message_id]: { parent: live[body.message_id]!.parent, message: message(body.message_id, 'assistant', 'Fork history from ChatGPT') } },
						}
					});
				}
				if (url.pathname.includes('/conversation/history-')) {
					const first = url.pathname.endsWith('history-one');
					const question = historyImage && first ? {
						...message('question', 'user', 'History question'),
						content: {
							content_type: 'multimodal_text', parts: [
								{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_diagram', width: 80, height: 40 }, 'History question',
							]
						},
						metadata: { attachments: [{ id: 'file_diagram', name: 'diagram.svg', mime_type: 'image/svg+xml', size: 126 }] },
					} : message('question', 'user', 'History question');
					return Response.json({
						title: first ? 'First native history' : 'Second native history', current_node: 'answer', mapping: {
							question: { parent: null, message: question },
							answer: { parent: 'question', message: message('answer', 'assistant', first ? 'History one answer' + historyReplySuffix : 'History two answer') },
						}
					});
				}
				if (url.pathname.endsWith('/prepare')) { return Response.json({ conduit_token: 'synthetic-conduit' }); }
				if (url.pathname.endsWith('/stop_conversation')) { return Response.json({ success: true }); }
				if (url.pathname === '/realtime/vp') { return Response.json({ error: 'Synthetic unavailable voice service' }, { status: 404 }); }
				if (url.pathname.endsWith('/f/conversation') && init?.method === 'POST') {
					const request = JSON.parse(String(init.body));
					if (sends && (request.conversation_id !== 'fixture-live' || request.parent_message_id !== head)) { return Response.json({ error: 'Wrong continuation' }, { status: 400 }); }
					userId = request.messages[0].id; live[userId] = { parent: head, message: request.messages[0] };
					sends++; step = 0;
					return new Response(new ReadableStream<Uint8Array>({ start(controller) { reply = controller; controller.enqueue(chunk('First chunk')); } }), { headers: { 'Content-Type': 'text/event-stream' } });
				}
				throw new Error(`Unexpected fixture path: ${url.pathname}`);
			};
		};
		install(session.defaultSession); for (const contents of webContents.getAllWebContents()) { install(contents.session); }
		app.on('session-created', install);
	}, { catalog: simpleChatGPTModelCatalog([{ slug: 'fixture', title: 'Fixture model' }]), authentication: chatGPTAuthDocument(), holdInitialization, historyReplySuffix, historyImage, projectFiles });
}

const ashFixtureModel = { provider: 'custom-chat-routing-fixture', model: 'ash-routing-fixture' };

async function createConversationShareServer() {
	const records = new Map<string, string>();
	const environment = {
		SHARES: {
			async put(key: string, value: string) { records.set(key, value); },
			async get(key: string) {
				const value = records.get(key);
				return value ? { uploaded: new Date(), json: async () => JSON.parse(value) } : null;
			},
		},
		PUBLISH_LIMIT: { limit: async () => ({ success: true }) },
	};
	const server = createServer(async (request, response) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const result = await shareWorker.fetch(new Request(new URL(request.url!, origin), {
				method: request.method,
				headers: new Headers(request.headers as Record<string, string>),
				body: request.method === 'POST' ? new Uint8Array(Buffer.concat(chunks)) : undefined,
			}), environment);
			response.writeHead(result.status, Object.fromEntries(result.headers)).end(Buffer.from(await result.arrayBuffer()));
		} catch {
			response.writeHead(500).end();
		}
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Ash share fixture has no port');
	const origin = `http://127.0.0.1:${address.port}`;
	return { origin, records, [Symbol.asyncDispose]: () => server[Symbol.asyncDispose]() };
}

function createAshModelServer(ashRequests: string[], replySuffix = '') {
	return createServer(async (request, response) => {
		if (request.method === 'GET') {
			response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: ashFixtureModel.model }] }));
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		ashRequests.push((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; }).model);
		const content = JSON.stringify('Answer from Ash' + replySuffix);
		response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`data: {"id":"ash-chat","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":${content}},"finish_reason":null}]}\n\ndata: {"id":"ash-chat","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
	});
}

async function configureAshModel(catalog: ReturnType<typeof createAshModelServer>, application: ElectronApplication, workbench: Workbench, workspace: string): Promise<void> {
	await new Promise<void>(resolve => catalog.listen(0, '127.0.0.1', resolve));
	const address = catalog.address();
	if (!address || typeof address === 'string') throw new Error('Ash model fixture has no port');
	const connection = await connectProfile(application, undefined, workspace, workbench.page);
	try {
		const config = await connection.client.request(APP_SERVER_METHODS['config/read'], {});
		await connection.client.request(APP_SERVER_METHODS['provider/configure'], {
			commandId: 'chat-routing-fixture', expectedRevision: config.revision, config: {
				connection: ashFixtureModel.provider, provider: ashFixtureModel.provider, baseUrl: `http://127.0.0.1:${address.port}/v1`,
				custom: { name: 'Ash routing fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 },
				modelContext: { [ashFixtureModel.model]: { contextWindow: 272_000 } },
			},
		});
		await connection.client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: ashFixtureModel.provider, apiKey: 'isolated-fixture-key' });
	} finally { await connection.close(); }
	const settings = await readUserSettings(workbench.page);
	await writeUserSettings(workbench.page, JSON.stringify({ ...JSON.parse(settings.content), 'models.hidden': [{ ...ashFixtureModel, visible: true }] }), settings.revision);
}

test.describe('Experimental ChatGPT desktop entry', () => {
	test.use({ electronUserSettings: { 'window.startupWindow': 'ide', 'workbench.locale': 'zh-CN' } });

	test('opens native history, pages on demand, streams a reply, and switches the default entry in Settings', { tag: ['@electron-app-server'] }, async ({ application, workbench }) => {
		await installService(application as ElectronApplication);
		const page = await workbench.openAgentsWindow('electron');
		const commands = new QuickAccess(page);
		const web = page.getByRole('region', { name: 'ChatGPT', exact: true });
		const native = page.getByRole('region', { name: 'ChatGPT（实验性）', exact: true });
		const newChat = page.locator('[data-action-id="sessions.newSession"]').getByRole('button', { name: '新建', exact: true });
		await expect(native).toBeVisible();
		await expect(web).toBeHidden();
		const savedChat = page.locator('[data-item="chatgpt-native:history-one"] .ash-sessions-list-item');
		await savedChat.click();
		await expect(native).toContainText('Experimental history answer');
		await expect(native.getByText('Experimental earlier question', { exact: true })).toHaveCount(0);
		await native.locator('.ash-chat-history-pagination').getByRole('button').click();
		await expect(native).toContainText('Experimental earlier question');
		await page.locator('.ash-window-mode-control').getByRole('button', { name: '代码', exact: true }).click();
		await expect(native).toBeHidden();
		await expect(savedChat).toHaveCount(0);
		await page.locator('.ash-window-mode-control').getByRole('button', { name: '聊天 / Agents', exact: true }).click();
		await expect(savedChat).toBeVisible();
		await savedChat.click();
		await expect(native).toContainText('Experimental history answer');
		await expect(savedChat).toHaveAttribute('aria-current', 'page');
		await newChat.click();
		const nativeInput = new Editor(native);
		await nativeInput.waitForEditorFocus();
		await nativeInput.waitForTypeInEditor('Experimental draft');
		await native.getByRole('button', { name: '发送', exact: true }).click();
		await expect(native).toContainText('First chunk');
		await (application as ElectronApplication).evaluate(() => { ashNativeFixture.advance(); ashNativeFixture.advance(); });
		await expect(native).toContainText('First chunk, second chunk, complete');

		await commands.runCommand('workbench.action.openSettings');
		const settings = page.locator('.ash-sessions-settings-dialog');
		await settings.getByRole('button', { name: '通用', exact: true }).click();
		const backend = settings.getByRole('combobox', { name: '默认 ChatGPT 入口', exact: true });
		await expect(backend).toHaveText('ChatGPT（实验性）');
		await backend.press('Enter');
		await page.getByRole('option', { name: 'ChatGPT 网页版', exact: true }).click();
		await expect(backend).toHaveText('ChatGPT 网页版');
		await expect.poll(async () => JSON.parse((await readUserSettings(page)).content)['sessions.chatgpt.defaultBackend']).toBe('chatgptweb');
		await page.keyboard.press('Escape');
		await expect(settings).toBeHidden();
		await expect(native).toBeVisible();
		await newChat.click();
		await expect(web).toBeVisible();
		await expect(native).toBeHidden();
		await expect(page.locator('[data-item^="chatgpt-native:"]')).toHaveCount(0);
		await expect(web.locator('.ash-chat-input-model-action')).toHaveText('Fixture model');
		const webInput = new Editor(web);
		await webInput.waitForEditorFocus();
		await webInput.waitForTypeInEditor('Web draft');
		await commands.runCommand('sessions.open.experimentalChatgpt');
		await expect(native).toContainText('First chunk, second chunk, complete');
		await commands.runCommand('sessions.open.chatgpt');
		await webInput.waitForEditorContents(text => text.includes('Web draft'));
	});
});

test.describe('Unified Chat sidebar', () => {
	test.use({ electronWindowMode: 'active', electronUserSettings: { 'window.startupWindow': 'ide', 'workbench.locale': 'zh-CN', 'sessions.chatgpt.defaultBackend': 'chatgptweb' } });

	test('opens one sent SVG thumbnail inside Chat without opening Code', { tag: ['@electron-app-server'] }, async ({ application, target, workbench }, testInfo) => {
		await installService(application as ElectronApplication, false, '', true);
		const page = await workbench.openAgentsWindow(target.kind);
		await page.locator('[data-item="chatgpt:history-one"] .ash-sessions-list-item').click();
		const chat = page.getByRole('region', { name: 'ChatGPT', exact: true });
		const message = chat.locator('.ash-chat-item-userMessage');
		const thumbnail = message.getByRole('button', { name: '预览 diagram.svg', exact: true });
		await expect(thumbnail).toBeEnabled();
		await expect(message.locator('img')).toHaveCount(1);
		await expect(message.locator('pre')).toHaveText('History question');
		await expect(chat.locator('.ash-chat-media')).toHaveCount(0);
		await thumbnail.press('Enter');
		const preview = page.getByRole('dialog', { name: '预览 diagram.svg' });
		await expect(preview).toHaveClass('ash-image-preview-popup');
		const image = preview.locator('.ash-image-viewer-image');
		await expect(image).toBeVisible();
		await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(80);
		await expect(page.locator('.ash-image-preview')).toHaveCount(0);
		await expect(page.locator('.ash-window-mode-control').getByRole('button', { name: '聊天 / Agents', exact: true })).toHaveAttribute('aria-pressed', 'true');
		await testInfo.attach('sent-svg-preview', { body: await preview.screenshot(), contentType: 'image/png' });
		await page.keyboard.press('Escape');
		await expect(preview).toHaveCount(0);
		await expect(thumbnail).toBeFocused();
	});

	test('renders the shared code card for Ash and ChatGPT replies', { tag: ['@electron-app-server'] }, async ({ application: browser, target, workbench, testWorkspace }, testInfo) => {
		const application = browser as ElectronApplication;
		const fence = '\n\n```bash\nprintf "%s\\n" hello\necho "Ash code card"\n```';
		await installService(application, false, fence);
		await application.evaluate(({ clipboard }) => { clipboard.writeText = async () => { }; });
		await using catalog = createAshModelServer([], fence);
		await configureAshModel(catalog, application, workbench, testWorkspace.directory);
		const connection = await connectProfile(application, undefined, testWorkspace.directory, workbench.page);
		try {
			const { client } = connection;
			const { session } = await client.request(APP_SERVER_METHODS['session/create'], {
				commandId: 'shared-code-card', title: 'Ash code card', kind: 'chat',
				executionTarget: null, agent: { type: 'default' },
			});
			const { sessionId } = session;
			const { threadId } = session.threads[0]!;
			const readThread = async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId })).thread;
			await client.request(APP_SERVER_METHODS['session/request'], {
				commandId: 'shared-code-card-turn', sessionId, request: {
					type: 'startTurn', threadId, expectedSequence: (await readThread()).sequence,
					model: ashFixtureModel, mode: 'agent', approvalMode: 'manual',
					input: [{ type: 'text', text: 'Show a shell example' }],
				},
			});
			await expect.poll(async () => (await readThread()).turns[0]?.status).toBe('completed');
			const page = await workbench.openAgentsWindow(target.kind);
			for (const [source, selector, canApply] of [
				['ChatGPT', 'chatgpt:history-one', false],
				['Ash', `ash:${sessionId}`, true],
			] as const) {
				await page.locator(`[data-item="${selector}"] .ash-sessions-list-item`).click();
				const card = page.locator('.ash-chat-code-block-card:visible');
				await expect(card.locator('.ash-chat-code-block-language')).toHaveText('Bash');
				await expect(card.locator('.stanza-editor-line-text')).toHaveText(['printf "%s\\n" hello', 'echo "Ash code card"']);
				await testInfo.attach(`${source}-code-card`, { body: await card.screenshot(), contentType: 'image/png' });
				const copyCode = card.getByRole('button', { name: '复制', exact: true });
				const copyMessage = page.locator('.ash-chat-item-agentMessage:visible').filter({ has: card })
					.getByRole('button', { name: '复制消息', exact: true });
				await expect(async () => {
					await card.hover();
					await copyMessage.hover();
					await expect(page.getByRole('tooltip')).toHaveText('复制', { timeout: 1500 });
				}).toPass({ timeout: 8000 });
				for (const copy of [copyMessage, copyCode]) {
					await copy.press('Enter');
					const check = copy.locator('[data-ash-icon-id="check"]');
					await expect(check).toBeVisible();
					expect(await check.evaluate(icon => {
						const styles = getComputedStyle(icon);
						const expected = icon.ownerDocument.createElement('span');
						expected.style.color = styles.getPropertyValue('--ash-success-foreground');
						return styles.color === expected.style.color;
					})).toBe(true);
					await expect(copy).toBeFocused();
				}
				await testInfo.attach(`${source}-copied-code`, { body: await card.screenshot(), contentType: 'image/png' });
				const more = card.getByRole('button', { name: '更多操作', exact: true });
				await more.press('Enter');
				const apply = page.getByRole('menuitem', { name: '应用到编辑器', exact: true });
				if (canApply) await expect(apply).toBeEnabled();
				else await expect(apply).toBeDisabled();
				await page.keyboard.press('Escape');
				await expect(more).toBeFocused();
			}
		} finally { await connection.close(); }
	});

	test('edits a native Ash Chat message in a new Thread and reopens the original draft', { tag: ['@electron-app-server'] }, async ({ application: browser, target, workbench, testWorkspace }) => {
		const application = browser as ElectronApplication;
		await installService(application);
		const modelRequests: string[] = [];
		await using catalog = createAshModelServer(modelRequests);
		await configureAshModel(catalog, application, workbench, testWorkspace.directory);
		const { client, close } = await connectProfile(application, undefined, testWorkspace.directory, workbench.page);
		try {
			const { session } = await client.request(APP_SERVER_METHODS['session/create'], {
				commandId: 'native-edit-session', title: 'Native message editing', kind: 'chat',
				executionTarget: null, agent: { type: 'default' },
			});
			const { sessionId } = session;
			const { threadId } = session.threads[0];
			const read = async (id = threadId) => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId: id })).thread;
			for (const [index, text] of ['Original prompt', 'Original follow-up'].entries()) {
				await client.request(APP_SERVER_METHODS['session/request'], {
					commandId: `native-edit-seed-${index}`, sessionId, request: {
						type: 'startTurn', threadId, expectedSequence: (await read()).sequence,
						model: ashFixtureModel, mode: 'agent', approvalMode: 'manual',
						input: [{ type: 'text', text }],
					},
				});
				await expect.poll(async () => (await read()).turns.at(-1)?.status).toBe('completed');
			}
			const page = await workbench.openAgentsWindow(target.kind);
			const row = page.locator(`[data-item="ash:${sessionId}"] .ash-sessions-list-item`);
			await row.press('Enter');
			const chat = page.locator('.ash-native-chat-widget .ash-chat');
			await expect(chat).toHaveAttribute('data-thread-id', threadId);
			await expect(chat).toContainText('Original follow-up');
			const composer = new Editor(chat);
			await composer.waitForEditorFocus();
			await composer.waitForTypeInEditor('Keep the original draft');
			const prompt = chat.locator('.ash-chat-item-userMessage').filter({ hasText: 'Original prompt' });
			await prompt.getByRole('button', { name: '编辑消息', exact: true }).press('Enter');
			const edit = chat.getByRole('textbox', { name: '编辑请求', exact: true });
			await edit.fill('/init revised as literal Chat text');
			await edit.press('Control+Enter');
			await expect(chat).not.toHaveAttribute('data-thread-id', threadId);
			await expect(chat).toContainText('/init revised as literal Chat text');
			await expect(chat).not.toContainText('Original follow-up');
			const rewrittenId = (await chat.getAttribute('data-thread-id'))!;
			await expect.poll(async () => (await read(rewrittenId)).turns.map(turn => turn.status)).toEqual(['completed']);
			expect((await read(rewrittenId)).turns[0].instructions?.id).not.toBe('instructions/init');
			expect((await read()).turns).toHaveLength(2);
			expect(modelRequests).toEqual([ashFixtureModel.model, ashFixtureModel.model, ashFixtureModel.model]);
			expect(await application.evaluate(() => globalThis.ashNativeFixture.sends)).toBe(0);
			await row.press('Enter');
			await expect(chat).toHaveAttribute('data-thread-id', threadId);
			await expect(chat).toContainText('Original follow-up');
			await composer.waitForEditorContents(text => text === 'Keep the original draft');
			await row.press('Shift+F10');
			await page.getByRole('menuitem', { name: '对话版本', exact: true }).press('ArrowRight');
			await page.getByText('版本 1', { exact: true }).click();
			await expect(chat).toHaveAttribute('data-thread-id', rewrittenId);
			await expect(chat).toContainText('/init revised as literal Chat text');
		} finally { await close(); }
	});

	test('continues the selected version of a workspace-bound native Chat in Code', { tag: ['@electron-app-server'] }, async ({ application: browser, target, workbench, testWorkspace }) => {
		const application = browser as ElectronApplication;
		await installService(application);
		const modelRequests: string[] = [];
		await using catalog = createAshModelServer(modelRequests);
		await configureAshModel(catalog, application, workbench, testWorkspace.directory);
		const { client, close } = await connectProfile(application, undefined, testWorkspace.directory, workbench.page);
		try {
			const { session } = await client.request(APP_SERVER_METHODS['session/create'], {
				commandId: 'continue-native-chat-in-code', title: 'Native Chat handoff', kind: 'chat',
				executionTarget: null, agent: { type: 'default' },
			});
			const { sessionId } = session;
			const { threadId } = session.threads[0];
			const readConversation = () => client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId });
			const readThread = async () => (await readConversation()).thread;
			await client.request(APP_SERVER_METHODS['session/request'], {
				commandId: 'first-native-chat-turn', sessionId, request: {
					type: 'startTurn', threadId, expectedSequence: (await readThread()).sequence, model: ashFixtureModel,
					mode: 'agent', approvalMode: 'manual', input: [{ type: 'text', text: 'Original Chat message' }],
				},
			});
			await expect.poll(async () => (await readThread()).turns[0]?.status).toBe('completed');
			const page = await workbench.openAgentsWindow(target.kind);
			const row = page.locator(`[data-item="ash:${sessionId}"] .ash-sessions-list-item`);
			await row.press('Enter');
			const chat = page.locator('.ash-native-chat-widget .ash-chat');
			await expect(chat).toHaveAttribute('data-thread-id', threadId);
			const workspace = chat.locator('.ash-session-workspace-status');
			await expect(workspace).toBeHidden();
			await expect(chat.getByRole('button', { name: '使用工作区', exact: true })).toHaveCount(0);
			const continueInCode = page.getByRole('menuitem', { name: '在 Code 中继续', exact: true });
			const workspaceActions = page.getByRole('menuitem', { name: /^(设置工作区…|更换工作区…|解除工作区)$/ });
			const folder = join(testWorkspace.directory, 'initial-workspace');
			await mkdir(folder);
			await writeFile(join(folder, 'baseline.txt'), 'workspace baseline');
			const canonicalFolder = await realpath(folder);
			const originalDialog = await application.evaluateHandle(({ dialog }) => dialog.showOpenDialog);
			try {
				await application.evaluate(({ dialog }, directory) => {
					dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
				}, folder);
				await row.press('Shift+F10');
				await expect(continueInCode).toHaveCount(0);
				await page.getByRole('menuitem', { name: '设置工作区…', exact: true }).click();
				await page.getByRole('button', { name: '信任并打开', exact: true }).click();
				await expect(workspace).toBeVisible();
				await expect(workspace).toHaveAttribute('title', canonicalFolder);
			} finally {
				await application.evaluate(({ dialog }, original) => { dialog.showOpenDialog = original; }, originalDialog);
				await originalDialog.dispose();
			}
			await row.press('Shift+F10');
			await expect(continueInCode).toBeEnabled();
			await expect(workspaceActions).toHaveCount(0);
			await continueInCode.press('Enter');
			const code = page.locator('.ash-sessions-chat-slot.active:visible .ash-chat');
			await expect(code).toHaveAttribute('data-session-id', sessionId);
			await expect(code).toHaveAttribute('data-thread-id', threadId);
			await expect(code).toContainText('Original Chat message');
			await expect(code).toContainText('Answer from Ash');
			await expect(code.locator('.ash-session-workspace-status')).toHaveCount(0);
			const originalDirectory = (await readConversation()).directory!.root;
			const originalFile = join(originalDirectory, 'baseline.txt');
			await writeFile(originalFile, 'at submission');
			const composer = new Editor(code);
			await composer.waitForEditorFocus();
			await composer.waitForTypeInEditor('Follow up from Code');
			await composer.input.press('Enter');
			await expect.poll(async () => (await readThread()).turns.map(turn => turn.status)).toEqual(['completed', 'completed']);
			await expect(code).toContainText('Follow up from Code');
			await writeFile(originalFile, 'after submission');
			const saved = (await client.request(APP_SERVER_METHODS['session/catalog/read'], { sessionId })).session;
			expect(saved?.kind).toBe('chat');
			expect(saved?.executionTarget).toEqual({ type: 'local', root: canonicalFolder });
			expect(saved?.threads.map(thread => thread.threadId)).toEqual([threadId]);
			expect(modelRequests).toEqual([ashFixtureModel.model, ashFixtureModel.model]);
			const titleMenu = page.locator('.ash-sessions-titlebar-menu');
			await titleMenu.press('Enter');
			await expect(page.getByRole('menuitem', { name: '重命名', exact: true })).toBeVisible();
			await expect(workspaceActions).toHaveCount(0);
			await page.keyboard.press('Escape');
			await expect(titleMenu).toBeFocused();
			const editInCode = async (text: string, editedText: string, turnCount: number, expectedFile: string) => {
				const prompt = code.locator('.ash-chat-item-userMessage').filter({ hasText: text });
				await prompt.getByRole('button', { name: '编辑消息', exact: true }).press('Enter');
				const edit = code.getByRole('textbox', { name: '编辑请求', exact: true });
				await edit.fill(editedText);
				await edit.press('Control+Enter');
				await expect(code).not.toHaveAttribute('data-thread-id', threadId);
				await expect(code).toContainText(editedText);
				await expect(code).not.toContainText(text);
				const editedThreadId = (await code.getAttribute('data-thread-id'))!;
				const read = () => client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId: editedThreadId });
				await expect.poll(async () => (await read()).thread.turns.map(turn => turn.status)).toEqual(Array(turnCount).fill('completed'));
				const { directory } = await read();
				expect(directory!.root).not.toBe(originalDirectory);
				expect(await readFile(join(directory!.root, 'baseline.txt'), 'utf8')).toBe(expectedFile);
				expect(await readFile(originalFile, 'utf8')).toBe('after submission');
				return editedThreadId;
			};
			const editedThreadId = await editInCode('Follow up from Code', 'Edited Code follow-up', 2, 'at submission');
			const mode = page.locator('.ash-window-mode-control');
			await mode.getByRole('button', { name: '聊天 / Agents', exact: true }).click();
			await row.press('Enter');
			await expect(chat).toHaveAttribute('data-thread-id', threadId);
			await expect(chat).toContainText('Follow up from Code');
			await expect(workspace).toHaveText(basename(folder));
			await row.press('Shift+F10');
			await page.getByRole('menuitem', { name: '对话版本', exact: true }).press('ArrowRight');
			await page.getByText('版本 1', { exact: true }).click();
			await expect(chat).toHaveAttribute('data-thread-id', editedThreadId);
			await expect(chat).toContainText('Edited Code follow-up');
			await row.press('Shift+F10');
			await continueInCode.press('Enter');
			await expect(code).toHaveAttribute('data-session-id', sessionId);
			await expect(code).toHaveAttribute('data-thread-id', editedThreadId);
			await expect(code).toContainText('Edited Code follow-up');
			await mode.getByRole('button', { name: '聊天 / Agents', exact: true }).click();
			await row.press('Enter');
			await expect(chat).toHaveAttribute('data-thread-id', threadId);
			await row.press('Shift+F10');
			await continueInCode.press('Enter');
			await expect(code).toHaveAttribute('data-thread-id', threadId);
			await editInCode('Original Chat message', 'Edited pre-workspace message', 1, 'workspace baseline');
			await page.locator('[data-action-id="sessions.newSession"] button').click();
			const draft = page.locator('.ash-sessions-chat-slot.active:visible .ash-chat[data-untitled-session-id]');
			await expect(draft.locator('.ash-sessions-workspace-picker')).toBeVisible();
			await expect(draft.locator('.ash-session-workspace-status')).toHaveCount(0);
		} finally { await close(); }
	});

	test('opens and restores an existing native Ash conversation without sending a message', { tag: ['@electron-app-server'] }, async ({ application: browser, target, workbench, testWorkspace }) => {
		const application = browser as ElectronApplication;
		await installService(application);
		const connection = await connectProfile(application, undefined, testWorkspace.directory, workbench.page);
		try {
			const { client } = connection;
			const { session } = await client.request(APP_SERVER_METHODS['session/create'], {
				commandId: 'desktop-session-pre-upgrade-chat', title: 'Existing Ash Chat', kind: 'chat',
				executionTarget: null, agent: { type: 'default' },
			});
			await client.request(APP_SERVER_METHODS['thread/goal/set'], {
				threadId: session.threads[0]!.threadId, objective: 'Saved native Chat goal', status: 'paused',
			});
			const { session: code } = await client.request(APP_SERVER_METHODS['session/create'], {
				commandId: 'existing-code', title: 'Existing Code Session', kind: 'code',
				executionTarget: { type: 'local', root: testWorkspace.directory }, agent: { type: 'default' },
			});
			const page = await workbench.openAgentsWindow(target.kind);
			const row = page.locator(`[data-item="ash:${session.sessionId}"] .ash-sessions-list-item`);
			await expect(row).toHaveText(/Existing Ash Chat/u);
			await client.request(APP_SERVER_METHODS['session/request'], {
				sessionId: session.sessionId, commandId: 'rename-existing-native-chat',
				request: { type: 'renameSession', title: 'Renamed Ash Chat' },
			});
			await expect(row).toHaveText(/Renamed Ash Chat/u);
			await row.press('Enter');
			await expect(row).toHaveAttribute('aria-current', 'page');
			const chat = page.locator('.ash-native-chat-widget .ash-chat');
			await expect(chat).toHaveAttribute('data-session-id', session.sessionId);
			await expect(chat.locator('.ash-chat-goal-banner')).toContainText('Saved native Chat goal');
			const mode = page.locator('.ash-window-mode-control');
			await mode.getByRole('button', { name: '代码', exact: true }).click();
			await expect(chat).toBeHidden();
			const codeRow = page.locator(`[data-item="session:${code.sessionId}"] .ash-sessions-list-item`);
			await expect(codeRow).toBeVisible();
			await codeRow.press('Enter');
			await expect(codeRow).toHaveAttribute('aria-current', 'page');
			await mode.getByRole('button', { name: '聊天 / Agents', exact: true }).click();
			await expect(chat).toHaveAttribute('data-session-id', session.sessionId);
			const restored = await workbench.reopenAgentsWindow(application, page);
			const restoredChat = restored.locator('.ash-native-chat-widget .ash-chat');
			await expect(restoredChat).toHaveAttribute('data-session-id', session.sessionId);
			await expect(restoredChat.locator('.ash-chat-goal-banner')).toContainText('Saved native Chat goal');
			await expect(restored.locator(`[data-item="ash:${session.sessionId}"] .ash-sessions-list-item`)).toHaveAttribute('aria-current', 'page');
		} finally {
			await connection.close();
		}
	});

	test('a restored Ash draft can find and send with a ChatGPT model when its Ash model is hidden', { tag: ['@electron-app-server'] }, async ({ application: browser, target, workbench, testWorkspace }) => {
		const application = browser as ElectronApplication;
		await installService(application);
		const ashRequests: string[] = [];
		await using catalog = createAshModelServer(ashRequests);
		await configureAshModel(catalog, application, workbench, testWorkspace.directory);
		const page = await workbench.openAgentsWindow(target.kind);
		const picker = page.getByRole('dialog', { name: '选择聊天模型', exact: true });
		const webModelButton = page.locator('.ash-chatgpt-widget .ash-chat-input-model-action');
		await expect(webModelButton).toHaveText('Fixture model');
		await webModelButton.press('ArrowDown');
		await picker.getByRole('menuitemradio', { name: ashFixtureModel.model, exact: true }).click();
		const ash = page.locator('.ash-native-chat-widget .ash-chat');
		const ashComposer = new Editor(ash);
		const text = 'Continue this draft with ChatGPT';
		await ashComposer.waitForEditorFocus();
		await ashComposer.waitForTypeInEditor(text);
		const id = await ash.getAttribute('data-untitled-session-id');
		expect(id).toBeTruthy();
		const settings = await readUserSettings(workbench.page);
		await writeUserSettings(workbench.page, JSON.stringify({ ...JSON.parse(settings.content), 'models.hidden': [] }), settings.revision);

		const restored = await workbench.reopenAgentsWindow(application, page);
		const restoredAsh = restored.locator('.ash-native-chat-widget .ash-chat');
		await expect(restoredAsh).toHaveAttribute('data-untitled-session-id', id!);
		await new Editor(restoredAsh).waitForEditorContents(value => value === text);
		await restoredAsh.locator('.ash-chat-input-model-action').press('ArrowDown');
		const restoredPicker = restored.getByRole('dialog', { name: '选择聊天模型', exact: true });
		const webChoice = restoredPicker.getByRole('menuitemradio', { name: 'Fixture model', exact: true });
		await expect(webChoice).toHaveAttribute('aria-checked', 'false');
		await expect(restoredPicker.getByRole('menuitemradio', { name: ashFixtureModel.model, exact: true })).toHaveCount(0);
		await webChoice.press('Enter');
		const web = restored.locator('.ash-chatgpt-widget');
		await expect(web).toBeVisible();
		const webComposer = new Editor(web);
		await webComposer.waitForEditorFocus();
		await webComposer.waitForEditorContents(value => value === text);
		await web.getByRole('button', { name: '发送', exact: true }).click();
		await expect.poll(() => application.evaluate(() => globalThis.ashNativeFixture.sends)).toBe(1);
		await application.evaluate(() => globalThis.ashNativeFixture.advance());
		await application.evaluate(() => globalThis.ashNativeFixture.advance());
		await expect(web).toContainText('First chunk, second chunk, complete');
		expect(ashRequests).toEqual([]);
	});

	test('a retained Chat picker follows Ash model settings', { tag: ['@electron-app-server'] }, async ({ application: browser, target, workbench, testWorkspace }, testInfo) => {
		const application = browser as ElectronApplication;
		await installService(application);
		await using catalog = createAshModelServer([]);
		await configureAshModel(catalog, application, workbench, testWorkspace.directory);
		const connection = await connectProfile(application, undefined, testWorkspace.directory, workbench.page);
		try {
			await connection.client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: 'openai', apiKey: 'isolated-effort-fixture-key' });
			await connection.client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: 'anthropic', apiKey: 'isolated-speed-fixture-key' });
		} finally { await connection.close(); }
		const page = await workbench.openAgentsWindow(target.kind);
		const modelButton = page.locator('.ash-chatgpt-widget .ash-chat-input-model-action');
		const picker = page.getByRole('dialog', { name: '选择聊天模型', exact: true });
		const ashChoice = picker.getByRole('menuitemradio', { name: ashFixtureModel.model, exact: true });
		const webChoice = picker.getByRole('menuitemradio', { name: 'Fixture model', exact: true });
		await expect(modelButton).toHaveText('Fixture model');
		await modelButton.press('ArrowDown');
		await expect(ashChoice).toBeVisible();
		const settings = await readUserSettings(workbench.page);
		await writeUserSettings(workbench.page, JSON.stringify({ ...JSON.parse(settings.content), 'models.hidden': [] }), settings.revision);
		await expect(ashChoice).toHaveCount(0);
		await expect(webChoice).toHaveAttribute('aria-checked', 'true');
		await expect(picker.getByRole('combobox')).toHaveCount(0);
		await expect(webChoice).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(modelButton).toBeFocused();

		await new QuickAccess(page).runCommand('workbench.action.chat.manage');
		const modelList = page.locator('.ash-chat-models-catalog');
		await modelList.getByRole('combobox').fill(ashFixtureModel.model);
		const toggle = modelList.getByRole('switch', { name: new RegExp(ashFixtureModel.model, 'u') });
		await expect(toggle).not.toBeChecked();
		await toggle.press('Space');
		await expect(toggle).toBeChecked();
		await expect(toggle).toBeEnabled();
		await page.keyboard.press('Escape');
		await modelButton.press('ArrowDown');
		await expect(ashChoice).toBeVisible();
		await expect(webChoice).toHaveAttribute('aria-checked', 'true');
		await ashChoice.click();
		const ashDraft = page.locator('.ash-native-chat-widget .ash-chat[data-untitled-session-id]');
		const nativeModelButton = ashDraft.locator('.ash-chat-input-model-action');
		await expect(nativeModelButton).toHaveText(ashFixtureModel.model);
		await nativeModelButton.press('ArrowDown');
		await picker.getByRole('menuitemradio', { name: 'Sol 6.1', exact: true }).click();
		await expect(picker.getByRole('slider')).toHaveAttribute('aria-valuetext', '中');
		const fast = picker.getByRole('button', { name: '快速模式', exact: true });
		await expect(fast).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(nativeModelButton).toHaveAccessibleName('Sol 6.1 中');
		await expect(nativeModelButton).toBeFocused();
		await expect(ashDraft.locator('.ash-chat-input-configuration-action')).toBeHidden();
		await ashDraft.locator('.ash-chat-input-part').screenshot({ path: testInfo.outputPath('ash-chat-combined-model-picker.png') });
		await nativeModelButton.press('ArrowDown');
		await picker.getByRole('button', { name: 'Sol 6.1', exact: true }).click();
		await picker.getByRole('menuitemradio', { name: 'Opus 5.5', exact: true }).click();
		await expect(fast).toBeVisible();
		await picker.getByRole('button', { name: 'Opus 5.5', exact: true }).click();
		await picker.getByRole('menuitemradio', { name: 'Sonnet 5.5', exact: true }).click();
		await expect(picker.getByRole('button', { name: 'Sonnet 5.5', exact: true })).toBeVisible();
		await expect(fast).toHaveCount(0);
	});

	test('opens and continues ChatGPT and Ash conversations from the same list', { tag: ['@electron-app-server'] }, async ({ application: browser, target, workbench, testWorkspace }) => {
		const application = browser as ElectronApplication;
		await installService(application);
		await application.evaluate(({ clipboard }) => {
			clipboard.writeText = async text => { Reflect.set(globalThis, 'ashTitleShareClipboard', text); };
		});
		const copied = () => application.evaluate(() => Reflect.get(globalThis, 'ashTitleShareClipboard') as string | undefined);
		const ashRequests: string[] = [];
		await using catalog = createAshModelServer(ashRequests);
		await configureAshModel(catalog, application, workbench, testWorkspace.directory);
		await using shareService = await createConversationShareServer();
		const settings = await readUserSettings(workbench.page);
		await writeUserSettings(workbench.page, JSON.stringify({
			...JSON.parse(settings.content), 'sessions.chat.shareServiceUrl': shareService.origin,
		}), settings.revision);
		const page = await workbench.openAgentsWindow(target.kind);
		const titlebar = page.locator('.ash-sessions-titlebar-widget');
		const share = titlebar.getByRole('button', { name: '分享', exact: true });
		const more = titlebar.getByRole('button', { name: '更多会话操作', exact: true });
		const rename = async (title: string): Promise<void> => {
			await titlebar.getByRole('button', { name: /^重命名会话/u }).press('Enter');
			const input = titlebar.getByRole('textbox', { name: '会话名称', exact: true });
			await expect(input).toBeFocused();
			await input.fill(title);
			await input.press('Enter');
			await expect(titlebar.getByRole('button', { name: `重命名会话（${title}）` })).toBeFocused();
		};
		const sidebar = page.locator('.ash-chat-navigation');
		const editor = page.locator('.ash-chatgpt-widget');
		const chatGPTComposer = new Editor(editor);
		const modeControl = page.locator('.ash-window-mode-control');
		const chatMode = modeControl.getByRole('button', { name: '聊天 / Agents', exact: true });
		const codeMode = modeControl.getByRole('button', { name: '代码', exact: true });
		await codeMode.click();
		await expect(codeMode).toHaveAttribute('aria-pressed', 'true');
		await new QuickAccess(page).runCommand('workbench.action.files.newUntitledFile');
		const codeEditor = page.getByRole('textbox', { name: 'Untitled-1', exact: true });
		await expect(codeEditor).toBeVisible();
		const code = page.locator('.ash-sessions-chat-slot.active:visible .ash-chat');
		const codeComposer = new Editor(code);
		await codeComposer.waitForEditorFocus();
		await codeComposer.waitForTypeInEditor('Keep this Code draft');
		await code.locator('.ash-chat-input-model-action').press('ArrowDown');
		const codeAuto = page.getByRole('switch', { name: '自动', exact: true });
		await expect(codeAuto).toBeVisible();
		if (!await codeAuto.isChecked()) await codeAuto.press('Space');
		await expect(codeAuto).toBeChecked();
		await page.keyboard.press('Escape');
		await chatMode.click();
		await expect(chatMode).toHaveAttribute('aria-pressed', 'true');
		const modelButton = editor.locator('.ash-chat-input-model-action');
		const webWelcome = editor.getByRole('heading', { level: 2 });
		await expect(webWelcome).toBeVisible();
		await expect(titlebar).toBeHidden();
		const welcome = await webWelcome.innerText();
		await expect(modelButton).toHaveText('Fixture model');
		await expect(modelButton).toBeEnabled();
		await chatGPTComposer.waitForTypeInEditor('First Ash message');
		await modelButton.press('ArrowDown');
		const picker = page.getByRole('dialog', { name: '选择聊天模型', exact: true });
		await expect(picker.getByRole('menuitemradio', { name: 'Fixture model', exact: true })).toBeVisible();
		await expect(picker.getByText('选择模型新建 Ash 对话…', { exact: true })).toHaveCount(0);
		await picker.getByRole('menuitemradio', { name: ashFixtureModel.model, exact: true }).click();

		const ash = page.locator('.ash-native-chat-widget .ash-chat');
		const ashComposer = new Editor(ash);
		await ashComposer.waitForEditorFocus();
		await ashComposer.waitForEditorContents(text => text === 'First Ash message');
		await expect(chatMode).toHaveAttribute('aria-pressed', 'true');
		await expect(sidebar).toBeVisible();
		await expect(ash.locator('.ash-chat-input-model-action')).toHaveText(ashFixtureModel.model);
		await expect(codeEditor).toBeHidden();
		await expect(ash.getByRole('heading', { level: 2 })).toHaveText(welcome);
		const codeTools = ash.locator(':is(.ash-sessions-environment, .ash-chat-input-mode-selector, .ash-chat-input-permission-picker, .ash-chat-input-context-toolbar):visible');
		await expect(codeTools).toHaveCount(0);
		await ash.locator('.ash-chat-input-model-action').press('ArrowDown');
		await expect(picker.locator('.ash-chat-model-slider-widget')).toBeVisible();
		await expect(picker.getByRole('combobox')).toHaveCount(0);
		await expect(picker.getByRole('toolbar')).toHaveCount(0);
		await expect(picker.getByRole('menuitemradio', { name: ashFixtureModel.model, exact: true })).toHaveAttribute('aria-checked', 'true');
		await expect(picker.getByRole('menuitemradio', { name: '自动', exact: true })).toHaveCount(0);
		await page.keyboard.press('Escape');
		await codeMode.click();
		await expect(ash).toBeHidden();
		await expect(code.locator('.ash-chat-input-model-action')).toHaveText('自动');
		await codeComposer.waitForEditorContents(text => text === 'Keep this Code draft');
		await chatMode.click();
		await expect(codeTools).toHaveCount(0);
		await ashComposer.waitForEditorContents(text => text === 'First Ash message');
		await ashComposer.waitForEditorFocus();
		const sentAfter = Date.now();
		await page.keyboard.press('Enter');
		await expect(ash).toContainText('Answer from Ash');
		const ashRequestTime = ash.locator('.ash-chat-item-userMessage time');
		const ashReplyTime = ash.locator('.ash-chat-item-agentMessage time').first();
		await expect(ashRequestTime).toHaveCount(0);
		await expect(ashReplyTime).toBeVisible();
		const replyDateTime = (await ashReplyTime.getAttribute('datetime'))!;
		expect(Date.parse(replyDateTime)).toBeGreaterThanOrEqual(sentAfter);
		expect(Date.parse(replyDateTime)).toBeLessThanOrEqual(Date.now());
		const setReplyTimestamps = async (window: Page, enabled: boolean): Promise<void> => {
			await window.getByRole('button', { name: '账户', exact: true }).click();
			await window.getByRole('menuitem', { name: '设置', exact: true }).click();
			const appearance = window.getByRole('dialog', { name: '设置', exact: true });
			await appearance.getByRole('button', { name: '外观', exact: true }).click();
			const timestamps = appearance.getByRole('switch', { name: '显示 Agent 回复时间', exact: true });
			await expect(timestamps).toHaveAttribute('aria-checked', String(!enabled));
			await timestamps.press('Space');
			await expect(timestamps).toHaveAttribute('aria-checked', String(enabled));
			await timestamps.press('Escape');
			await expect(appearance).toBeHidden();
		};
		await setReplyTimestamps(page, false);
		await expect(ashReplyTime).toBeHidden();
		await expect(ashRequestTime).toHaveCount(0);
		const ashSessionId = await ash.getAttribute('data-session-id');
		expect(ashSessionId).toBeTruthy();
		const ashRow = sidebar.locator(`[data-item="ash:${ashSessionId}"]`);
		const ashTitle = ashRow.locator('.ash-sessions-list-item');
		await expect(ashTitle).toHaveAttribute('aria-current', 'page');
		await expect(ashRow).toHaveAttribute('data-parent-section', 'recent');
		await rename('Ash title from the title bar');
		await expect(ashTitle).toContainText('Ash title from the title bar');
		await expect(share).toHaveClass(/\bash-button-primary\b/u);

		let expectedSends = 0;
		const sendChatGPT = async (text: string, whileStreaming?: () => Promise<void>): Promise<void> => {
			await chatGPTComposer.waitForEditorFocus();
			await chatGPTComposer.waitForTypeInEditor(text);
			await editor.getByRole('button', { name: '发送', exact: true }).click();
			await expect.poll(() => application.evaluate(() => globalThis.ashNativeFixture.sends)).toBe(++expectedSends);
			const answer = editor.locator('.ash-chat-item-agentMessage').last();
			await expect(answer).toContainText('First chunk');
			await whileStreaming?.();
			await application.evaluate(() => globalThis.ashNativeFixture.advance());
			await application.evaluate(() => globalThis.ashNativeFixture.advance());
			await expect(answer).toContainText('First chunk, second chunk, complete');
			await expect(editor.getByRole('button', { name: '停止', exact: true })).toBeHidden();
		};

		await page.locator('[data-action-id="sessions.newSession"]').getByRole('button', { name: '新建', exact: true }).click();
		await sendChatGPT('First ChatGPT message');
		const chatGPTRow = sidebar.locator('[data-item="chatgpt:fixture-live"] .ash-sessions-list-item');
		await expect(chatGPTRow).toHaveAttribute('aria-current', 'page');
		await expect(ashTitle).not.toHaveAttribute('aria-current', 'page');
		await rename('ChatGPT title from the title bar');
		await expect(chatGPTRow).toContainText('ChatGPT title from the title bar');
		await more.press('Enter');
		await page.getByRole('menuitem', { name: '置顶', exact: true }).press('Enter');
		await expect(sidebar.locator('[data-item="chatgpt:fixture-live"]')).toHaveAttribute('data-parent-section', 'pinned');
		await more.press('Enter');
		await expect(page.getByRole('menuitem', { name: '取消置顶', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await share.press('Enter');
		const confirmation = page.getByRole('dialog');
		await expect(confirmation).toContainText('ChatGPT title from the title bar');
		await confirmation.getByRole('button', { name: '分享', exact: true }).click();
		await expect.poll(copied).toBe('https://chatgpt.com/share/fixture-live');
		await expect(share).toBeFocused();
		const titleBounds = (await titlebar.locator('.ash-sessions-titlebar-title').boundingBox())!;
		const shareBounds = (await share.boundingBox())!;
		const bar = page.locator('.ash-sessions-titlebar');
		const barBounds = (await bar.boundingBox())!;
		expect(titleBounds.x + titleBounds.width).toBeLessThan(shareBounds.x);
		expect(barBounds.x + barBounds.width - shareBounds.x - shareBounds.width).toBeLessThan(40);
		await test.info().attach('chat-conversation-title-bar', { body: await bar.screenshot(), contentType: 'image/png' });

		await ashTitle.press('Enter');
		await expect(chatMode).toHaveAttribute('aria-pressed', 'true');
		await expect(ashTitle).toHaveAttribute('aria-current', 'page');
		await expect(chatGPTRow).not.toHaveAttribute('aria-current', 'page');
		await expect(ash).toHaveAttribute('data-session-id', ashSessionId!);
		await expect(ash).toContainText('First Ash message');
		await expect(titlebar.getByRole('button', { name: '重命名会话（Ash title from the title bar）' })).toBeVisible();
		await ash.locator('.ash-chat-input-model-action').press('ArrowDown');
		await expect(picker.getByRole('menuitemradio', { name: ashFixtureModel.model, exact: true })).toBeVisible();
		await expect(picker.getByRole('menuitemradio', { name: 'Fixture model', exact: true })).toHaveCount(0);
		await page.keyboard.press('Escape');
		await ashComposer.input.focus();
		await ashComposer.waitForEditorFocus();
		await ashComposer.waitForTypeInEditor('/compact Follow up with Ash');
		await page.keyboard.press('Enter');
		await expect(ash).toContainText('/compact Follow up with Ash');
		await expect(ash.locator('.ash-chat-item-agentMessage')).toHaveCount(2);
		await expect.poll(() => ashRequests).toEqual([ashFixtureModel.model, ashFixtureModel.model]);
		expect(await application.evaluate(() => globalThis.ashNativeFixture.sends)).toBe(1);

		await share.press('Enter');
		const nativeShare = page.getByRole('dialog');
		await expect(nativeShare).toContainText(shareService.origin);
		expect(shareService.records.size).toBe(0);
		await nativeShare.getByRole('button', { name: '分享', exact: true }).click();
		await expect.poll(copied).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[a-f0-9-]{36}$/u);
		const link = (await copied())!;
		const readerPage = application.waitForEvent('window');
		const reader = await application.evaluateHandle(({ BrowserWindow }, url) => {
			const window = new BrowserWindow({ show: false, webPreferences: { partition: 'conversation-share-reader', sandbox: true } });
			void window.loadURL(url);
			return window;
		}, link);
		try {
			const sharedPage = await readerPage;
			await sharedPage.waitForURL(link);
			await expect(sharedPage.getByRole('heading', { name: 'Ash title from the title bar' })).toBeVisible();
			await expect(sharedPage.locator('article')).toHaveCount(4);
			await expect(sharedPage.locator('main')).toContainText(/First Ash message[\s\S]*Answer from Ash[\s\S]*Follow up with Ash[\s\S]*Answer from Ash/u);
		} finally {
			await reader.evaluate(window => window.destroy());
			await reader.dispose();
		}

		await ashTitle.focus();
		await ashRow.getByRole('button', { name: '置顶聊天', exact: true }).press('Enter');
		await expect(ashRow).toHaveAttribute('data-parent-section', 'pinned');
		await expect(ashTitle).toBeFocused();
		await page.keyboard.press('Alt+F1');
		const help = page.locator('.ash-accessible-view-content');
		await expect(help).toHaveValue(/ChatGPT 和 Ash 对话共用窗口侧栏/u);
		await expect(help).toHaveValue(/Ash 对话的菜单也可以置顶或取消置顶/u);
		await page.keyboard.press('Escape');
		await expect(ashTitle).toBeFocused();
		await more.press('Enter');
		await page.getByRole('menuitem', { name: '取消置顶', exact: true }).press('Enter');
		await expect(ashRow).toHaveAttribute('data-parent-section', 'recent');
		await more.press('Enter');
		await page.getByRole('menuitem', { name: '置顶', exact: true }).press('Enter');
		await expect(ashRow).toHaveAttribute('data-parent-section', 'pinned');
		await chatGPTRow.click();
		await expect(chatGPTRow).toHaveAttribute('aria-current', 'page');
		await expect(ashTitle).not.toHaveAttribute('aria-current', 'page');
		await expect(editor).toContainText('First ChatGPT message');
		const chatGPTReplyTime = editor.locator('.ash-chat-item-agentMessage time').first();
		await expect(chatGPTReplyTime).toBeHidden();
		await expect(editor.locator('.ash-chat-item-userMessage time')).toHaveCount(0);
		const chatGPTInput = editor.getByRole('textbox', { name: '询问 ChatGPT', exact: true });
		await chatGPTInput.press('Alt+F2');
		await expect(help).toHaveValue(/First ChatGPT message[\s\S]*First chunk, second chunk, complete/u);
		await page.keyboard.press('Escape');
		await expect(chatGPTInput).toBeFocused();
		await sendChatGPT('Follow up with ChatGPT', async () => {
			await ashTitle.click();
			await expect(ash).toContainText('Follow up with Ash');
			await chatGPTRow.click();
			await expect(editor.getByRole('button', { name: '停止', exact: true })).toBeVisible();
		});
		expect(await application.evaluate(() => globalThis.ashNativeFixture.sends)).toBe(2);
		expect(ashRequests).toEqual([ashFixtureModel.model, ashFixtureModel.model]);
		const responseActions = editor.getByRole('toolbar', { name: '回复操作', exact: true }).first();
		await responseActions.getByRole('button', { name: '更多操作', exact: true }).press('Enter');
		await page.getByRole('menuitem', { name: '分叉', exact: true }).press('Enter');
		await expect(editor).toContainText('Fork history from ChatGPT');
		await expect(editor).not.toContainText('Follow up with ChatGPT');
		expect(await application.evaluate(() => globalThis.ashNativeFixture.sends)).toBe(2);
		await chatGPTRow.click();
		await expect(editor).toContainText('Follow up with ChatGPT');
		await expect(editor).not.toContainText('Fork history from ChatGPT');
		await more.press('Enter');
		await page.getByRole('menuitem', { name: '删除', exact: true }).press('Enter');
		const deleteConfirmation = page.getByRole('dialog');
		const deleteButton = deleteConfirmation.getByRole('button', { name: '永久删除', exact: true });
		await expect(deleteConfirmation).toContainText('此对话及其历史记录将被永久删除。');
		await expect(deleteConfirmation).toHaveCSS('border-radius', '12px');
		await expect(deleteButton).toHaveClass(/\bash-button-danger\b/u);
		await test.info().attach('chat-delete-confirmation', { body: await page.screenshot(), contentType: 'image/png' });
		await page.keyboard.press('Escape');
		await expect(deleteConfirmation).toHaveCount(0);
		await expect(chatGPTRow).toBeVisible();
		await more.press('Enter');
		await page.getByRole('menuitem', { name: '删除', exact: true }).press('Enter');
		await deleteButton.click();
		await expect(chatGPTRow).toHaveCount(0);

		await ashTitle.click();
		await codeMode.click();
		await expect(page.locator('[data-item]').getByText('First Ash message', { exact: true })).toHaveCount(0);
		await codeComposer.waitForEditorContents(text => text === 'Keep this Code draft');
		await chatMode.click();
		await expect(ash).toContainText('Follow up with Ash');
		await test.step('Reopen Agents and restore the native Chat conversation', async () => {
			const restored = await workbench.reopenAgentsWindow(application, page);
			const restoredChat = restored.locator('.ash-native-chat-widget .ash-chat');
			await expect(restoredChat).toHaveAttribute('data-session-id', ashSessionId!);
			await expect(restoredChat).toContainText('Follow up with Ash');
			const restoredReplyTime = restoredChat.locator('.ash-chat-item-agentMessage time').first();
			await expect(restoredReplyTime).toBeHidden();
			await setReplyTimestamps(restored, true);
			await expect(restoredReplyTime).toHaveAttribute('datetime', replyDateTime);
			await expect(restoredChat.locator('.ash-chat-item-userMessage time')).toHaveCount(0);
			await expect(restoredChat.locator('.ash-chat-input-model-action')).toHaveText(ashFixtureModel.model);
			await restored.locator('.ash-sessions-titlebar-widget').getByRole('button', { name: '更多会话操作' }).press('Enter');
			await restored.getByRole('menuitem', { name: '删除', exact: true }).press('Enter');
			const ashDelete = restored.getByRole('dialog').getByRole('button', { name: '永久删除', exact: true });
			await expect(ashDelete).toHaveClass(/\bash-button-danger\b/u);
			await ashDelete.click();
			await expect(restored.locator(`[data-item="ash:${ashSessionId}"]`)).toHaveCount(0);
			const window = await application.browserWindow(restored);
			const closed = restored.waitForEvent('close');
			await window.evaluate(window => window.close());
			await closed;
		});
	});
});

test.describe('Ash project file copies', () => {
	test.use({ electronUserSettings: { 'window.startupWindow': 'ide', 'workbench.locale': 'zh-CN', 'sessions.chatgpt.defaultBackend': 'chatgptweb' } });

	test('saves project files locally and changes their Ash folder while ChatGPT is unavailable', { tag: ['@electron-app-server'] }, async ({ application: browser, workbench }, testInfo) => {
		const application = browser as ElectronApplication;
		await installService(application, false, '', false, true);
		const page = await workbench.openAgentsWindow('electron');
		const profile = await application.evaluate(() => process.env.ASH_HOME!);
		const originalRoot = join(profile, 'Project Files');
		const chosenFolder = testInfo.outputPath('chosen-project-files');
		await mkdir(chosenFolder, { recursive: true });
		const destination = await realpath(chosenFolder);
		const saved = async (root: string, name: string): Promise<string | undefined> => {
			const paths = await readdir(root, { recursive: true }).catch(() => []);
			const path = paths.find(path => basename(path) === name);
			return path ? readFile(join(root, path), 'utf8') : undefined;
		};

		await page.locator('.ash-sessions-activity-content').getByRole('button', { name: '项目', exact: true }).click();
		const project = page.locator('.ash-projects').getByRole('button', { name: 'File project fixture', exact: true });
		await expect(project).toBeVisible();
		expect(await saved(originalRoot, 'project-fixture.txt')).toBeUndefined();
		await project.click();
		const materials = page.getByRole('region', { name: '上下文', exact: true });
		const file = materials.getByRole('button', { name: 'project-fixture.txt', exact: true });
		await expect(file).toBeVisible();
		await expect.poll(() => saved(originalRoot, 'project-fixture.txt')).toBe('Saved project material fixture');
		await expect.poll(() => saved(originalRoot, 'other-fixture.txt')).toBe('Second project file');

		await page.locator('.ash-projects-breadcrumb').getByRole('button', { name: '项目', exact: true }).click();
		await application.evaluate(() => ashNativeFixture.setOffline(true));
		await new QuickAccess(page).runCommand('workbench.action.openSettings');
		const settings = page.locator('.ash-sessions-settings-dialog');
		const folderSetting = settings.locator('[data-settings-item-id="sessions.projects.localFilesLocation"]');
		await expect(folderSetting).toContainText(originalRoot);
		const change = folderSetting.getByRole('button', { name: '更改', exact: true });
		await settings.screenshot({ path: testInfo.outputPath('project-files-settings-zh-CN.png') });
		await expect(change).toHaveClass(/\bash-button-secondary\b/u);
		const originalDialog = await application.evaluateHandle(({ dialog }) => dialog.showOpenDialog);
		try {
			await application.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, destination);
			await change.press('Enter');
			await expect(folderSetting).toContainText(destination);
		} finally {
			await application.evaluate(({ dialog }, original) => { dialog.showOpenDialog = original; }, originalDialog);
		}
		await expect.poll(async () => JSON.parse((await readUserSettings(page)).content)['sessions.projects.localFilesLocation']).toBe(destination);
		await page.keyboard.press('Escape');
		await expect(settings).toBeHidden();
		await application.evaluate(() => ashNativeFixture.setOffline(false));
		await project.click();
		await expect.poll(() => saved(destination, 'project-fixture.txt')).toBe('Saved project material fixture');
		await expect.poll(() => saved(destination, 'other-fixture.txt')).toBe('Second project file');

		await application.evaluate(() => ashNativeFixture.setOffline(true));
		await file.press('Enter');
		const editor = page.getByRole('tabpanel', { name: 'project-fixture.txt', exact: true });
		await new Editor(editor).waitForEditorContents(text => text === 'Saved project material fixture');

		const restored = await workbench.reopenAgentsWindow(application, page);
		await restored.locator('.ash-window-mode-control').getByRole('button', { name: '聊天 / Agents', exact: true }).click();
		const showSidebar = restored.getByRole('button', { name: '显示侧边栏', exact: true });
		if (await showSidebar.isVisible()) await showSidebar.click();
		await restored.locator('.ash-sessions-activity-content').getByRole('button', { name: '项目', exact: true }).click({ timeout: 5000 });
		await restored.locator('.ash-projects').getByRole('button', { name: 'File project fixture', exact: true }).click();
		await restored.getByRole('region', { name: '上下文', exact: true }).getByRole('button', { name: 'project-fixture.txt', exact: true }).press('Enter');
		const restoredEditor = restored.getByRole('tabpanel', { name: 'project-fixture.txt', exact: true });
		await new Editor(restoredEditor).waitForEditorContents(text => text === 'Saved project material fixture');
	});
});

for (const locale of ['en', 'zh-CN'] as const) {
	test.describe(`ChatGPT initialization lifecycle in ${locale}`, () => {
		test.use({ openWorkspace: false, useDefaultLanguageServer: false, electronUserSettings: { 'window.startupWindow': 'ide', 'workbench.locale': locale, 'sessions.chatgpt.defaultBackend': 'chatgptweb' } });
		test('pasted images stay inside the ChatGPT composer and can be previewed and removed', { tag: ['@electron-app-server'] }, async ({ application: browser, target, workbench }, testInfo) => {
			const application = browser as ElectronApplication;
			await installService(application);
			const page = await workbench.openAgentsWindow(target.kind);
			const history = page.getByRole('button', { name: 'First native history', exact: true });
			await page.emulateMedia({ reducedMotion: 'no-preference' });
			await expect(history).toBeVisible();
			const editor = page.locator('.ash-chatgpt-widget');
			const composer = new Editor(editor);
			await composer.waitForEditorFocus();
			await composer.waitForTypeInEditor('Keep this draft');
			const name = 'clipboard.png';
			const form = editor.locator('.ash-chat-input-container');
			await application.evaluate(() => globalThis.ashNativeFixture.holdUploads(true));
			await composer.input.evaluate((element, name) => {
				const canvas = document.createElement('canvas');
				canvas.width = 96;
				canvas.height = 64;
				canvas.getContext('2d')!.fillRect(0, 0, 96, 64);
				const bytes = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), character => character.charCodeAt(0));
				const clipboard = new DataTransfer();
				clipboard.items.add(new File([bytes], name, { type: 'image/png' }));
				element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
			}, name);
			const previewLabel = locale === 'en' ? `Preview ${name}` : `预览 ${name}`;
			const thumbnail = form.getByRole('button', { name: previewLabel, exact: true });
			const remove = form.getByRole('button', { name: locale === 'en' ? `Remove ${name}` : `移除 ${name}`, exact: true });
			await expect(thumbnail.locator('img')).toBeVisible();
			const pending = form.locator('.ash-chat-staged-file.image.pending');
			await expect(pending).toHaveCount(1);
			await expect(thumbnail.locator('img')).toHaveCSS('opacity', '0.5');
			await expect(pending.getByText(locale === 'en' ? 'Uploading…' : '正在上传…', { exact: true })).toHaveCSS('clip-path', 'inset(50%)');
			expect(await thumbnail.evaluate(element => getComputedStyle(element, '::after').animationName)).toBe('ash-chat-staged-image-sweep');
			await history.hover();
			await expect(remove).toHaveCSS('opacity', '0');
			await expect(remove).toHaveCSS('pointer-events', 'none');
			await testInfo.attach(`chatgpt-pending-image-${locale}`, { body: await form.screenshot(), contentType: 'image/png' });
			await thumbnail.hover();
			await expect(remove).toHaveCSS('opacity', '1');
			await expect(remove.locator('.ash-icon')).toHaveCSS('font-size', '12px');
			const formBounds = (await form.boundingBox())!;
			const thumbnailBounds = (await thumbnail.boundingBox())!;
			const removeBounds = (await remove.boundingBox())!;
			expect(thumbnailBounds.y).toBeGreaterThan(formBounds.y);
			expect(thumbnailBounds.y + thumbnailBounds.height).toBeLessThan(formBounds.y + formBounds.height);
			expect(removeBounds.x).toBeGreaterThan(thumbnailBounds.x + thumbnailBounds.width / 2);
			expect(removeBounds.y).toBeLessThan(thumbnailBounds.y + thumbnailBounds.height / 2);
			expect(removeBounds.width).toBeCloseTo(removeBounds.height);
			await application.evaluate(() => globalThis.ashNativeFixture.holdUploads(false));
			await expect.poll(() => application.evaluate(() => Object.keys(globalThis.ashNativeFixture.uploadedFiles))).toContain(name);
			await expect(pending).toHaveCount(0);
			await expect(thumbnail.locator('img')).toHaveCSS('opacity', '1');
			expect(await thumbnail.evaluate(element => getComputedStyle(element, '::after').animationName)).toBe('none');
			await thumbnail.click();
			const preview = page.getByRole('dialog', { name: previewLabel, exact: true });
			await expect(preview.getByRole('img', { name, exact: true })).toBeVisible();
			await expect(preview.getByRole('button', { name: locale === 'en' ? /^Zoom: \d+%$/u : /^缩放：\d+%$/u })).toBeEnabled();
			await expect(preview.getByRole('button', { name: locale === 'en' ? 'Save image' : '保存图片', exact: true })).toBeEnabled();
			const annotateLabel = locale === 'en' ? 'Annotate image' : '标注图片';
			await expect(preview.getByRole('button', { name: annotateLabel, exact: true })).toBeEnabled();
			await page.keyboard.press('Escape');
			await expect(preview).toBeHidden();
			await expect(thumbnail).toBeFocused();
			await history.hover();
			await expect(remove).toHaveCSS('opacity', '1');
			await page.keyboard.press('Tab');
			await expect(remove).toBeFocused();
			await expect(remove).toHaveCSS('opacity', '1');
			await composer.waitForEditorFocus();
			await expect(remove).toHaveCSS('opacity', '0');
			await testInfo.attach(`chatgpt-pasted-image-${locale}`, { body: await form.screenshot(), contentType: 'image/png' });
			const reopened = await workbench.reopenAgentsWindow(application, page);
			const restoredForm = reopened.locator('.ash-chatgpt-widget .ash-chat-input-container');
			const restored = new Editor(restoredForm);
			const restoredThumbnail = restoredForm.getByRole('button', { name: previewLabel, exact: true });
			await expect(restoredThumbnail.locator('img')).toBeVisible();
			const heldBefore = await application.evaluate(() => globalThis.ashNativeFixture.heldUploads);
			await application.evaluate(() => globalThis.ashNativeFixture.holdUploads(true));
			await restoredThumbnail.click();
			const restoredPreview = reopened.getByRole('dialog', { name: previewLabel, exact: true });
			await restoredPreview.getByRole('button', { name: annotateLabel, exact: true }).click();
			await drawImageAnnotation(restoredPreview);
			await restoredPreview.getByRole('button', { name: locale === 'en' ? 'Done annotating' : '完成标注', exact: true }).click();
			await expect(restoredPreview).toBeHidden();
			await expect(restored.input).toBeFocused();
			const copy = 'clipboard-annotated.png';
			const annotated = restoredForm.getByRole('button', { name: locale === 'en' ? `Preview ${copy}` : `预览 ${copy}`, exact: true });
			await expect(annotated.locator('img')).toBeVisible();
			await expect(restoredThumbnail).toBeVisible();
			await expect.poll(() => application.evaluate(() => globalThis.ashNativeFixture.heldUploads)).toBe(heldBefore + 1);
			await application.evaluate(() => globalThis.ashNativeFixture.holdUploads(false));
			await expect.poll(() => application.evaluate(() => Object.keys(globalThis.ashNativeFixture.uploadedFiles))).toContain(copy);
			await restoredForm.getByRole('button', { name: locale === 'en' ? `Remove ${name}` : `移除 ${name}`, exact: true }).press('Enter');
			await expect(restoredThumbnail).toHaveCount(0);
			await restoredForm.getByRole('button', { name: locale === 'en' ? `Remove ${copy}` : `移除 ${copy}`, exact: true }).press('Enter');
			await expect(annotated).toHaveCount(0);
			await expect(restored.input).toBeFocused();
			await restored.waitForEditorContents(text => text === 'Keep this draft');
		});

		test('closing and reopening during pending initialization cancels the old window and restores a usable chat', { tag: ['@electron-app-server'] }, async ({ application: browser, target, workbench, driver }, testInfo) => {
			const application = browser as ElectronApplication;
			await installService(application, true);
			let page = await workbench.openAgentsWindow(target.kind);
			for (let reopen = 0; reopen < 3; reopen++) {
				await expect.poll(() => application.evaluate(() => globalThis.ashNativeFixture.pendingInitializations)).toBe(1);
				await expect(page.locator('.ash-chat-navigation-list')).toHaveAttribute('aria-busy', 'true');
				page = await workbench.reopenAgentsWindow(application, page);
				await expect.poll(() => application.evaluate(() => globalThis.ashNativeFixture.cancelledInitializations)).toBe(reopen + 1);
				expect(driver.diagnostics.errors).toEqual([]);
			}
			await expect.poll(() => application.evaluate(() => globalThis.ashNativeFixture.pendingInitializations)).toBe(1);
			await application.evaluate(() => globalThis.ashNativeFixture.releaseInitialization());
			await expect(page.locator('.ash-chat-navigation-list')).toHaveAttribute('aria-busy', 'false');
			await expect(page.getByRole('button', { name: 'First native history', exact: true })).toBeVisible();
			await page.getByRole('button', { name: 'First native history', exact: true }).click();
			const editor = page.locator('.ash-chatgpt-widget');
			await expect(editor).toContainText('History one answer');
			const newButton = page.locator('[data-action-id="sessions.newSession"] button');
			const help = page.locator('.ash-accessible-view-content');
			await newButton.press('Alt+F1');
			await expect(help).toHaveValue(locale === 'en'
				? /New opens a draft in the selected Chat or Code mode and focuses the message input/u
				: /“新建”会在当前选中的 Chat 或 Code 模式打开草稿，并聚焦消息输入框/u);
			await expect(help).not.toHaveValue(/ChatGPT|Codex/u);
			await page.keyboard.press('Escape');
			await expect(newButton).toBeFocused();
			const input = editor.getByRole('textbox', { name: locale === 'en' ? 'Ask ChatGPT' : '询问 ChatGPT', exact: true });
			await input.press('Alt+F1');
			await expect(help).toHaveValue(locale === 'en' ? /Independent Ash sign-in renews automatically/u : /Ash 独立登录会自动续期/u);
			await expect(help).toHaveValue(locale === 'en' ? /under All and Sessions and match by title or project name/u : /“全部”和“会话”分类中，可按标题或项目名称查找/u);
			await page.keyboard.press('Escape');
			await expect(input).toBeFocused();
			expect(await application.evaluate(() => globalThis.ashNativeFixture.pendingInitializations)).toBe(0);
			expect(driver.diagnostics.errors).toEqual([]);
			await testInfo.attach('chatgpt-after-initialization-close', { body: await page.screenshot(), contentType: 'image/png' });
		});

		test('restores an offline ChatGPT conversation and draft on window reopen, then opens blank New on ordinary startup', { tag: ['@electron-app-server'] }, async ({ application: browser, target, workbench, reloadWorkbench }) => {
			const application = browser as ElectronApplication;
			await installService(application);
			const page = await workbench.openAgentsWindow(target.kind);
			await page.getByRole('button', { name: 'First native history', exact: true }).click();
			await expect(page.locator('.ash-chatgpt-widget')).toContainText('History one answer');
			const composer = new Editor(page.locator('.ash-chatgpt-widget'));
			await composer.waitForEditorFocus();
			await composer.waitForTypeInEditor('Unsent native follow-up');
			const ready = 'draft-ready.txt';
			const pending = 'draft-pending.txt';
			const staged = (page: Page, name: string) => page.locator('.ash-chat-staged-file').filter({ hasText: name });
			const picker = page.locator('.ash-chatgpt-widget input[type=file]');
			await picker.setInputFiles({ name: ready, mimeType: 'text/plain', buffer: Buffer.from('Ready draft bytes') });
			await expect(staged(page, ready)).toContainText(locale === 'en' ? 'Ready' : '就绪');
			await application.evaluate(() => globalThis.ashNativeFixture.holdUploads(true));
			await picker.setInputFiles({ name: pending, mimeType: 'text/plain', buffer: Buffer.from('Pending draft bytes') });
			await expect.poll(() => application.evaluate(() => globalThis.ashNativeFixture.heldUploads)).toBe(1);
			await application.evaluate(() => globalThis.ashNativeFixture.setOffline(true));

			const reopened = await workbench.reopenAgentsWindow(application, page);
			const history = reopened.locator('.ash-chat-navigation');
			const editor = reopened.locator('.ash-chatgpt-widget');
			const notices = reopened.locator('.ash-notification-host .ash-notification-message');
			const historyFailure = notices.filter({ hasText: locale === 'en' ? 'Could not sync ChatGPT history' : '无法同步 ChatGPT 历史' });
			await expect(historyFailure).toHaveCount(1);
			await expect(editor.locator('.ash-chat-input-notification-message')).toBeHidden();
			await expect(history.getByRole('button', { name: 'First native history', exact: true })).toHaveAttribute('aria-current', 'page');
			await expect(history.getByRole('button', { name: 'Second native history', exact: true })).toBeVisible();
			await expect(history.getByRole('button', { name: 'Pinned native history', exact: true })).toBeVisible();
			await expect(editor).toContainText('History one answer');
			const openOriginal = editor.getByRole('button', { name: locale === 'en' ? 'Open conversation in ChatGPT' : '在 ChatGPT 中打开对话', exact: true });
			await expect(openOriginal).toBeVisible();
			const readAloud = editor.getByRole('button', { name: locale === 'en' ? 'Read aloud' : '朗读', exact: true });
			await expect(readAloud).toHaveCount(0);
			await new Editor(editor).waitForEditorContents(text => text === 'Unsent native follow-up');
			await expect(staged(reopened, ready)).toContainText(locale === 'en' ? 'Ready' : '就绪');
			const retry = staged(reopened, pending).getByRole('button', { name: locale === 'en' ? 'Retry ' + pending : '重试 ' + pending, exact: true });
			await expect(retry).toBeVisible();
			await reopened.evaluate(() => window.dispatchEvent(new Event('offline')));
			const offlineNotice = notices.filter({ hasText: locale === 'en' ? 'ChatGPT is offline' : 'ChatGPT 当前离线' });
			await expect(offlineNotice).toHaveCount(1);
			await expect(historyFailure).toHaveCount(0);
			await application.evaluate(() => {
				globalThis.ashNativeFixture.setOffline(false);
				globalThis.ashNativeFixture.setRecentHistoryRateLimited(true);
				globalThis.ashNativeFixture.holdUploads(false);
			});
			const historyStatus = notices.filter({ hasText: locale === 'en' ? 'ChatGPT is temporarily limiting history requests' : 'ChatGPT 暂时限制了历史请求' });
			const recentRequests = () => application.evaluate(() => globalThis.ashNativeFixture.recentHistoryRequests);
			const beforeReconnect = await recentRequests();
			await reopened.evaluate(() => window.dispatchEvent(new Event('online')));
			await expect(readAloud).toBeVisible();
			await expect(historyStatus).toHaveCount(1);
			await expect(offlineNotice).toHaveCount(0);
			await expect(historyFailure).toHaveCount(0);
			await expect(editor.locator('.ash-chat-input-notification-message')).toBeHidden();
			expect(await recentRequests()).toBe(beforeReconnect + 1);
			await new QuickAccess(reopened).runCommand('sessions.chatgpt.reload');
			await expect(historyStatus).toHaveCount(1);
			expect(await recentRequests()).toBe(beforeReconnect + 1);
			await retry.click();
			await expect(staged(reopened, pending)).toContainText(locale === 'en' ? 'Ready' : '就绪');
			expect(await application.evaluate(() => globalThis.ashNativeFixture.uploadedFiles)).toEqual({ [ready]: 'Ready draft bytes', [pending]: 'Pending draft bytes' });
			await application.evaluate(() => globalThis.ashNativeFixture.setRecentHistoryRateLimited(false));
			// Both the renderer and the main-process history gate enforce the cooldown.
			const cooldownOffset = 65_000;
			await application.evaluate((_electron, offset) => globalThis.ashNativeFixture.setClockOffset(offset), cooldownOffset);
			try {
				await reopened.clock.setFixedTime(new Date(Date.now() + cooldownOffset));
				await reopened.evaluate(() => window.dispatchEvent(new Event('online')));
				await expect(historyStatus).toHaveCount(0);
				await expect.poll(recentRequests).toBe(beforeReconnect + 2);
			} finally {
				await application.evaluate(() => globalThis.ashNativeFixture.setClockOffset(0));
			}

			const restarted = await reloadWorkbench('quit');
			await installService(restarted.application as ElectronApplication);
			const fresh = await restarted.workbench.openAgentsWindow(target.kind);
			const freshEditor = fresh.locator('.ash-chatgpt-widget');
			const freshComposer = new Editor(freshEditor);
			await expect(freshComposer.input).toBeFocused();
			await freshComposer.waitForEditorContents(text => text === '');
			await expect(freshEditor.locator('.ash-chat-item')).toHaveCount(0);
			await expect(freshEditor.locator('.ash-chat-staged-file')).toHaveCount(0);
			await fresh.getByRole('button', { name: 'First native history', exact: true }).click();
			await expect(freshEditor).toContainText('History one answer');
			await freshComposer.waitForEditorContents(text => text === 'Unsent native follow-up');
			await expect(staged(fresh, ready)).toContainText(locale === 'en' ? 'Ready' : '就绪');
			await expect(staged(fresh, pending)).toContainText(locale === 'en' ? 'Ready' : '就绪');
		});
	});

	test.describe(`ChatGPT entry in ${locale}`, () => {
		test.use({ electronWindowMode: 'active', electronUserSettings: { 'sessions.chatgpt.defaultBackend': 'chatgptweb' } });
		test('opens by default, retains the existing login, streams followups and restores history and drafts', { tag: ['@electron-app-server'] }, async ({ application: initialApplication, workbench: initialWorkbench, target, restartWorkbench, testWorkspace }, testInfo) => {
			let application = initialApplication as ElectronApplication; let workbench = initialWorkbench;
			if (locale === 'zh-CN') {
				await workbench.quickaccess.runCommand('workbench.action.configureLocale');
				const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
				await picker.getByRole('combobox').fill('简体中文'); await picker.getByRole('combobox').press('Enter');
				const restarted = await restartWorkbench(); application = restarted.application as ElectronApplication; workbench = restarted.workbench;
			}
			await installService(application);
			const model = ashFixtureModel;
			const ashRequests: string[] = [];
			await using catalog = createAshModelServer(ashRequests);
			await configureAshModel(catalog, application, workbench, testWorkspace.directory);
			const page = await workbench.openAgentsWindow(target.kind); const commands = new QuickAccess(page);
			const newLabel = locale === 'en' ? 'New' : '新建';
			const newChat = page.locator('[data-action-id="sessions.newSession"]').getByRole('button', { name: newLabel, exact: true });
			await expect(page.locator('[data-action-id="sessions.open.chatgpt"]')).toHaveCount(0);
			await expect(newChat).toBeVisible();
			await expect(newChat).toHaveAttribute('aria-current', 'page');
			const editor = page.locator('.ash-chatgpt-widget'); await expect(editor).toBeVisible();
			await expect(page.locator('.ash-chat2-editor, .ash-web-bridge')).toHaveCount(0);
			const input = editor.getByRole('textbox', { name: locale === 'en' ? 'Ask ChatGPT' : '询问 ChatGPT', exact: true });
			const composer = new Editor(editor);
			await expect(input).toBeEditable();
			await composer.waitForEditorContents(text => text.trim() === '');
			await composer.waitForEditorFocus();
			await composer.waitForTypeInEditor('Hello from native UI');
			const cardStyle = (element: HTMLElement) => {
				const style = getComputedStyle(element);
				return { padding: style.padding, radius: style.borderRadius, background: style.backgroundColor, grid: style.gridTemplateAreas, height: style.height };
			};
			const chatGPTCard = editor.locator('.ash-chat-input-container.ash-chat-input-adaptive');
			const chatGPTCardStyle = await chatGPTCard.evaluate(cardStyle);
			const chatGPTCardBounds = await chatGPTCard.boundingBox();
			await editor.locator('.ash-chat-input-model-action').press('ArrowDown');
			const modelMenu = page.getByRole('dialog', { name: locale === 'en' ? 'Choose a chat model' : '选择聊天模型', exact: true });
			await expect(modelMenu.getByRole('menuitemradio', { name: 'Fixture model', exact: true })).toBeVisible();
			await expect(modelMenu.getByText(locale === 'en' ? 'New Ash Chat with Model…' : '选择模型新建 Ash 对话…', { exact: true })).toHaveCount(0);
			await modelMenu.getByRole('menuitemradio', { name: model.model, exact: true }).click();
			const mode = page.locator('.ash-window-mode-control');
			const chatMode = mode.getByRole('button', { name: locale === 'en' ? 'Chat / Agents' : '聊天 / Agents', exact: true });
			const ash = page.locator('.ash-native-chat-widget .ash-chat');
			const ashComposer = new Editor(ash);
			await ashComposer.waitForEditorContents(text => text === 'Hello from native UI');
			const ashCard = ash.locator('.ash-chat-input-container.ash-chat-input-adaptive');
			await expect.poll(() => ashCard.evaluate(cardStyle)).toEqual(chatGPTCardStyle);
			const ashCardBounds = await ashCard.boundingBox();
			for (const dimension of ['width', 'x', 'y'] as const) {
				expect(Math.abs(ashCardBounds![dimension] - chatGPTCardBounds![dimension]), dimension).toBeLessThanOrEqual(2);
			}
			await expect(chatMode).toHaveAttribute('aria-pressed', 'true');
			await expect(ash.locator('.ash-chat-input-model-action')).toHaveText(model.model);
			const ashDraftId = await ash.getAttribute('data-untitled-session-id');
			expect(ashDraftId).toBeTruthy();
			const sidebar = page.locator('.ash-chat-navigation');
			await expect(sidebar.getByRole('button', { name: 'Ash', exact: true })).toHaveCount(0);
			await expect(sidebar.locator('.ash-sessions-list')).toHaveCount(0);
			const codeMode = mode.getByRole('button', { name: locale === 'en' ? 'Code' : '代码', exact: true });
			await codeMode.click();
			await expect(codeMode).toHaveAttribute('aria-pressed', 'true');
			await expect(ash).toBeHidden();
			const codeList = page.locator('.ash-sessions-list[data-mode="code"]');
			await expect(codeList).toBeVisible();
			await expect(codeList.locator(`[data-item="untitled:${ashDraftId}"]`)).toHaveCount(0);
			await chatMode.click();
			await expect(chatMode).toHaveAttribute('aria-pressed', 'true');
			await expect(ash).toHaveAttribute('data-untitled-session-id', ashDraftId!);
			await ashComposer.waitForEditorContents(text => text === 'Hello from native UI');
			await ash.locator('.ash-chat-input-model-action').press('ArrowDown');
			await expect(modelMenu.getByRole('menuitemradio', { name: model.model, exact: true })).toBeVisible();
			await expect(modelMenu.getByRole('menuitemradio', { name: 'Fixture model', exact: true })).toBeVisible();
			await expect(modelMenu.getByText(locale === 'en' ? 'New ChatGPT Chat with Model…' : '选择模型新建 ChatGPT 对话…', { exact: true })).toHaveCount(0);
			await page.keyboard.press('Escape');
			await ashComposer.waitForEditorFocus();
			await page.keyboard.press('Enter');
			await expect(ash).toContainText('Answer from Ash');
			expect(ashRequests).toEqual([model.model]);
			await newChat.click();
			await expect(editor).toBeVisible();
			await composer.waitForEditorContents(text => text === 'Hello from native UI');
			expect(await application.evaluate(() => globalThis.ashNativeFixture.sends)).toBe(0);
			await editor.getByRole('button', { name: locale === 'en' ? 'Send' : '发送', exact: true }).click();
			const answer = editor.locator('.ash-chat-item-agentMessage').last();
			await expect(answer).toContainText('First chunk');
			await expect(editor.getByRole('button', { name: locale === 'en' ? 'Stop' : '停止', exact: true })).toBeVisible();
			await page.locator('[data-action-id="sessions.newSession"]').getByRole('button', { name: locale === 'en' ? 'New' : '新建', exact: true }).click();
			await expect(answer).toContainText('First chunk');
			await expect(editor).toBeVisible();
			expect(await application.evaluate(() => globalThis.ashNativeFixture.sends)).toBe(1);
			await application.evaluate(() => globalThis.ashNativeFixture.advance());
			await expect(answer).toContainText('First chunk, second chunk');
			await application.evaluate(() => globalThis.ashNativeFixture.advance());
			await expect(answer).toContainText('First chunk, second chunk, complete');
			await composer.waitForEditorContents(text => text.trim() === '');
			await expect(editor.getByRole('button', { name: locale === 'en' ? 'Stop' : '停止', exact: true })).toBeHidden();
			await expect(editor.locator('.ash-chat-input-notification-message')).toBeHidden();
			for (const mode of ['complete', 'stop', 'voice-recovery'] as const) {
				if (mode === 'voice-recovery') {
					await page.evaluate(() => {
						// A synthetic microphone keeps this failure-path test independent of hardware.
						const context = new AudioContext();
						const stream = context.createMediaStreamDestination().stream;
						navigator.mediaDevices.getUserMedia = async () => stream.clone();
						window.addEventListener('pagehide', () => { void context.close(); }, { once: true });
					});
					await editor.getByRole('button', { name: locale === 'en' ? 'Voice conversation' : '语音对话', exact: true }).click();
					await expect(page.locator('.ash-notification-message:visible').filter({ hasText: '404' })).toBeVisible();
					await expect(editor.locator('.ash-chat-input-notification-message')).toBeHidden();
					await expect(editor.getByRole('button', { name: locale === 'en' ? 'Stop voice conversation' : '停止语音对话', exact: true })).toHaveCount(0);
				}
				await composer.waitForEditorFocus(); await composer.waitForTypeInEditor(`Follow up after ${mode}`);
				await editor.getByRole('button', { name: locale === 'en' ? 'Send' : '发送', exact: true }).click();
				const count = mode === 'complete' ? 2 : mode === 'stop' ? 3 : 4;
				await expect(editor.locator('.ash-chat-item-agentMessage')).toHaveCount(count);
				await expect(answer).toContainText('First chunk');
				if (mode === 'stop') { await editor.getByRole('button', { name: locale === 'en' ? 'Stop' : '停止', exact: true }).click(); }
				else {
					await application.evaluate(() => globalThis.ashNativeFixture.advance());
					await application.evaluate(() => globalThis.ashNativeFixture.advance());
					await expect(answer).toContainText('First chunk, second chunk, complete');
				}
				await expect(editor.getByRole('button', { name: locale === 'en' ? 'Stop' : '停止', exact: true })).toBeHidden();
				await expect(editor.locator('.ash-chat-input-notification-message')).toBeHidden();
				await composer.waitForEditorContents(text => text.trim() === '');
			}
			const history = page.locator('.ash-chat-navigation');
			await expect(history.getByRole('button', { name: locale === 'en' ? 'New chat' : '新聊天', exact: true })).toHaveCount(0);
			await history.getByRole('button', { name: 'First native history', exact: true }).click();
			await expect(editor).toContainText('History one answer');
			await expect(newChat).not.toHaveAttribute('aria-current', 'page');
			await composer.waitForEditorFocus(); await composer.waitForTypeInEditor('Draft in first history');
			await history.getByRole('button', { name: 'Second native history', exact: true }).click();
			await expect(editor).toContainText('History two answer');
			await expect(editor).not.toContainText('History one answer');
			await history.getByRole('button', { name: 'First native history', exact: true }).click();
			await expect(editor).toContainText('History one answer');
			await composer.waitForEditorContents(text => text === 'Draft in first history');
			await newChat.click();
			await expect(newChat).toHaveAttribute('aria-current', 'page');
			await expect(editor.locator('.ash-chat-item')).toHaveCount(0);
			await composer.waitForEditorContents(text => text.trim() === '');
			await composer.waitForEditorFocus();
			await expect(editor).toBeVisible();
			await composer.waitForTypeInEditor('Independent new chat draft');
			await history.getByRole('button', { name: 'First native history', exact: true }).click();
			await expect(editor).toContainText('History one answer');
			await composer.waitForEditorContents(text => text === 'Draft in first history');
			await page.locator('[data-action-id="sessions.newSession"]').getByRole('button', { name: locale === 'en' ? 'New' : '新建', exact: true }).click();
			await expect(editor.locator('.ash-chat-item')).toHaveCount(0);
			await composer.waitForEditorContents(text => text === 'Independent new chat draft');
			await history.getByRole('button', { name: 'First native history', exact: true }).click();
			await input.focus(); await page.keyboard.press('Alt+F1');
			await expect(page.locator('.ash-accessible-view-content')).toHaveValue(locale === 'en' ? /Use New at the top of the sidebar to start a chat/u : /使用侧栏顶部的“新建”开始聊天/u);
			await page.keyboard.press('Escape');
			await testInfo.attach(`chatgpt-entry-${locale}`, { body: await page.screenshot(), contentType: 'image/png' });
			const pinned = history.locator('[data-section="pinned"] .ash-sessions-list-section-toggle');
			await pinned.click();
			await expect(pinned).toHaveAttribute('aria-expanded', 'false');
			const retainedHistory = await history.elementHandle();
			const viewport = history.locator('.ash-scrollbar-viewport').first();
			const pages = [
				{ action: 'sessions.open.projects', content: '.ash-projects' },
				{ action: 'sessions.open.creator', content: '.ash-creator-home' },
				{ action: 'sessions.open.customize', content: '.ash-customize' },
			];
			for (const entry of pages) {
				await viewport.evaluate(element => { element.scrollTop = 96; });
				await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(96);
				await page.locator(`[data-action-id="${entry.action}"] .ash-sessions-activity-item`).click();
				await expect(page.locator(entry.content)).toBeVisible();
				await expect(editor).toBeHidden();
				await expect(history).toBeVisible();
				expect(await history.evaluate((element, retained) => element === retained, retainedHistory)).toBe(true);
				await expect(pinned).toHaveAttribute('aria-expanded', 'false');
				await expect(history.getByRole('button', { name: 'First native history', exact: true })).toHaveAttribute('aria-current', 'page');
				await expect(viewport).toHaveJSProperty('scrollTop', 96);
				if (entry.action === 'sessions.open.creator') {
					await page.locator('.ash-creator-home').getByRole('button', { name: locale === 'en' ? 'Design' : '设计', exact: true }).click();
					await expect(page.locator('.ash-sessions-design-view')).toBeVisible();
					await expect(history).toBeVisible();
					expect(await history.evaluate((element, retained) => element === retained, retainedHistory)).toBe(true);
				}
				await history.getByRole('button', { name: 'First native history', exact: true }).click();
				await expect(editor).toBeVisible();
				await composer.waitForEditorContents(text => text === 'Draft in first history');
				await composer.waitForEditorFocus();
			}
			await retainedHistory!.dispose();
			await page.locator('.ash-window-mode-control').getByRole('button', { name: locale === 'en' ? 'Code' : '代码', exact: true }).click();
			await expect(editor).toBeHidden();
			await commands.runCommand('sessions.open.chatgpt');
			await expect(editor).toContainText('History one answer');
			await composer.waitForEditorContents(text => text === 'Draft in first history');
			expect(await application.evaluate(() => globalThis.ashNativeFixture.sends)).toBe(4);
			let restored = await workbench.reopenAgentsWindow(application, page);
			await expect(restored.locator('.ash-chatgpt-widget')).toContainText('History one answer');
			await expect(restored.locator('[data-action-id="sessions.open.chatgpt"]')).toHaveCount(0);
			const restoredNewChat = restored.locator('[data-action-id="sessions.newSession"]').getByRole('button', { name: newLabel, exact: true });
			await expect(restoredNewChat).toBeVisible();
			await expect(restoredNewChat).not.toHaveAttribute('aria-current', 'page');
			for (const entry of pages) {
				await restored.locator(`[data-action-id="${entry.action}"] .ash-sessions-activity-item`).click();
				restored = await workbench.reopenAgentsWindow(application, restored);
				await expect(restored.locator(entry.content)).toBeVisible();
				const restoredHistory = restored.locator('.ash-chat-navigation');
				await expect(restoredHistory).toBeVisible();
				await expect(restoredHistory.locator('[data-section="pinned"] .ash-sessions-list-section-toggle')).toHaveAttribute('aria-expanded', 'false');
				await expect(restoredHistory.getByRole('button', { name: 'First native history', exact: true })).toHaveAttribute('aria-current', 'page');
				await restoredHistory.getByRole('button', { name: 'First native history', exact: true }).click();
				await expect(restored.locator('.ash-chatgpt-widget')).toContainText('History one answer');
				await new Editor(restored.locator('.ash-chatgpt-widget')).waitForEditorFocus();
			}
			expect(await application.evaluate(() => globalThis.ashNativeFixture.sends)).toBe(4);
		});
	});
}
