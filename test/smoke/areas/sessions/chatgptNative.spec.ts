import { createServer } from 'node:http';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { Editor } from '../../../automation/editor.js';
import type { Workbench } from '../../../automation/workbench.js';
import { readUserSettings, writeUserSettings } from '../../../automation/settings.js';
import { simpleChatGPTModelCatalog } from '../../../fixtures/chatGPTModels.js';
import { chatGPTAuthDocument } from '../../../fixtures/chatGPTAuth.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from './sessionProfileFixture.js';

declare global {
	var ashNativeFixture: { advance(): void; readonly sends: number; readonly pendingInitializations: number; readonly cancelledInitializations: number; releaseInitialization(): void; setOffline(value: boolean): void; holdUploads(value: boolean): void; readonly heldUploads: number; readonly uploadedFiles: Record<string, string>; };
}

/** Keep production IPC, Rust authentication, transport, verification and UI; replace only service I/O. */
async function installService(application: ElectronApplication, holdInitialization = false): Promise<void> {
	await application.evaluate(async ({ app, session, webContents }, { catalog, authentication, holdInitialization }) => {
		const fs = process.getBuiltinModule('fs/promises');
		const path = process.getBuiltinModule('path');
		const home = path.join(process.env.HOME!, '.codex');
		await fs.mkdir(home, { recursive: true });
		await fs.writeFile(path.join(home, 'auth.json'), authentication);
		let sends = 0; let step = 0; let reply: ReadableStreamDefaultController<Uint8Array> | undefined;
		let cancelledInitializations = 0;
		let offline = false;
		let uploadsHeld = false;
		let heldUploads = 0;
		const uploadedFiles: Record<string, string> = {};
		const initializing = new Set<() => void>();
		const message = (id: string, role: string, text: string) => ({ id, author: { role }, content: { content_type: 'text', parts: [text] } });
		const live: Record<string, { parent: string | null; message: ReturnType<typeof message>; }> = {};
		let head: string | null = null;
		let userId = '';
		const chunk = (text: string) => {
			const id = `reply-live-${sends}`;
			live[id] = { parent: userId, message: message(id, 'assistant', text) }; head = id;
			return new TextEncoder().encode(`data: ${JSON.stringify({ conversation_id: 'fixture-live', message: live[id]!.message })}\n\n`);
		};
		globalThis.ashNativeFixture = {
			get sends() { return sends; },
			get pendingInitializations() { return initializing.size; },
			get cancelledInitializations() { return cancelledInitializations; },
			setOffline(value) { offline = value; },
			holdUploads(value) { uploadsHeld = value; },
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
				if (offline) { return new Response(null, { status: 503 }); }
				if (url.pathname.endsWith('/files') && init?.method === 'POST') {
					const { file_name: name } = JSON.parse(String(init.body));
					if (uploadsHeld) {
						heldUploads++;
						await new Promise<never>((_, reject) => {
							init.signal!.throwIfAborted();
							init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
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
				if (url.pathname.endsWith('/gizmos/snorlax/sidebar')) { return Response.json({ items: [], cursor: null }); }
				if (url.pathname.endsWith('/conversations')) {
					const items = [{ id: 'history-one', title: 'First native history' }, { id: 'history-two', title: 'Second native history' }, ...Array.from({ length: 30 }, (_, index) => ({ id: `history-extra-${index}`, title: `Additional history ${index}` }))];
					return Response.json({ items, total: items.length });
				}
				if (url.pathname.endsWith('/conversation/fixture-live')) { return Response.json({ title: 'Live fixture', current_node: head, mapping: live }); }
				if (url.pathname.includes('/conversation/history-')) {
					const first = url.pathname.endsWith('history-one');
					return Response.json({
						title: first ? 'First native history' : 'Second native history', current_node: 'answer', mapping: {
							question: { parent: null, message: message('question', 'user', 'History question') },
							answer: { parent: 'question', message: message('answer', 'assistant', first ? 'History one answer' : 'History two answer') },
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
	}, { catalog: simpleChatGPTModelCatalog([{ slug: 'fixture', title: 'Fixture model' }]), authentication: chatGPTAuthDocument(), holdInitialization });
}

const ashFixtureModel = { provider: 'custom-chat-routing-fixture', model: 'ash-routing-fixture' };

function createAshModelServer(ashRequests: string[]) {
	return createServer(async (request, response) => {
		if (request.method === 'GET') {
			response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: ashFixtureModel.model }] }));
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		ashRequests.push((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; }).model);
		response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('data: {"id":"ash-chat","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Answer from Ash"},"finish_reason":null}]}\n\ndata: {"id":"ash-chat","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
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

test.describe('Unified Chat sidebar', () => {
	test.use({ electronWindowMode: 'active', electronUserSettings: { 'window.startupWindow': 'ide', 'workbench.locale': 'zh-CN' } });

	test('opens and continues ChatGPT and Ash conversations from the same list', { tag: ['@electron-app-server'] }, async ({ application: browser, target, workbench, testWorkspace }) => {
		const application = browser as ElectronApplication;
		await installService(application);
		const ashRequests: string[] = [];
		await using catalog = createAshModelServer(ashRequests);
		await configureAshModel(catalog, application, workbench, testWorkspace.directory);
		const page = await workbench.openAgentsWindow(target.kind);
		const sidebar = page.locator('.ash-chat-navigation');
		const editor = page.locator('.ash-chatgpt-widget');
		const chatGPTComposer = new Editor(editor);
		const chatMode = page.locator('.ash-window-mode-control').getByRole('button', { name: '聊天 / Agents', exact: true });
		const modelButton = editor.locator('.ash-chat-input-model-action');
		await expect(modelButton).toHaveText('Fixture model');
		await expect(modelButton).toBeEnabled();
		await modelButton.press('ArrowDown');
		const picker = page.getByRole('dialog', { name: '选择聊天模型', exact: true });
		await expect(picker.getByRole('menuitemradio', { name: 'Fixture model', exact: true })).toBeVisible();
		await expect(picker.getByText('选择模型新建 Ash 对话…', { exact: true })).toHaveCount(0);
		await picker.getByRole('menuitemradio', { name: ashFixtureModel.model, exact: true }).click();

		const ash = page.locator('.ash-sessions-chat-slot.active:visible .ash-chat');
		const ashComposer = new Editor(ash);
		await ashComposer.waitForEditorFocus();
		await ashComposer.waitForTypeInEditor('First Ash message');
		await page.keyboard.press('Enter');
		await expect(ash).toContainText('Answer from Ash');
		const ashSessionId = await ash.getAttribute('data-session-id');
		expect(ashSessionId).toBeTruthy();
		const ashRow = sidebar.locator(`[data-item="ash:${ashSessionId}"]`);
		const ashTitle = ashRow.locator('.ash-sessions-list-item');
		await expect(ashTitle).toHaveAttribute('aria-current', 'page');
		await expect(ashRow).toHaveAttribute('data-parent-section', 'recent');

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

		await ashTitle.press('Enter');
		await expect(chatMode).toHaveAttribute('aria-pressed', 'true');
		await expect(ashTitle).toHaveAttribute('aria-current', 'page');
		await expect(chatGPTRow).not.toHaveAttribute('aria-current', 'page');
		await expect(ash).toHaveAttribute('data-session-id', ashSessionId!);
		await expect(ash).toContainText('First Ash message');
		await ashComposer.waitForEditorFocus();
		await ashComposer.waitForTypeInEditor('Follow up with Ash');
		await page.keyboard.press('Enter');
		await expect(ash.locator('.ash-chat-item-agentMessage')).toHaveCount(2);
		await expect.poll(() => ashRequests).toEqual([ashFixtureModel.model, ashFixtureModel.model]);
		expect(await application.evaluate(() => globalThis.ashNativeFixture.sends)).toBe(1);

		await ashRow.getByRole('button', { name: '置顶聊天', exact: true }).press('Enter');
		await expect(ashRow).toHaveAttribute('data-parent-section', 'pinned');
		await expect(ashTitle).toBeFocused();
		await page.keyboard.press('Alt+F1');
		const help = page.locator('.ash-accessible-view-content');
		await expect(help).toHaveValue(/ChatGPT 和 Ash 对话共用窗口侧栏/u);
		await expect(help).toHaveValue(/Ash 会话的更多菜单提供重命名、归档和删除/u);
		await page.keyboard.press('Escape');
		await expect(ashTitle).toBeFocused();
		await chatGPTRow.click();
		await expect(chatGPTRow).toHaveAttribute('aria-current', 'page');
		await expect(ashTitle).not.toHaveAttribute('aria-current', 'page');
		await expect(editor).toContainText('First ChatGPT message');
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
	});
});

for (const locale of ['en', 'zh-CN'] as const) {
	test.describe(`ChatGPT initialization lifecycle in ${locale}`, () => {
		test.use({ openWorkspace: false, useDefaultLanguageServer: false, electronUserSettings: { 'window.startupWindow': 'ide', 'workbench.locale': locale } });
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
			await expect(page.locator('.ash-chatgpt-widget')).toContainText('History one answer');
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
			await expect(editor.locator('.ash-chat-input-notification-message')).toContainText('503');
			await expect(history.getByRole('button', { name: 'First native history', exact: true })).toHaveAttribute('aria-current', 'page');
			await expect(history.getByRole('button', { name: 'Second native history', exact: true })).toBeVisible();
			await expect(history.getByRole('button', { name: 'Pinned native history', exact: true })).toBeVisible();
			await expect(editor).toContainText('History one answer');
			await new Editor(editor).waitForEditorContents(text => text === 'Unsent native follow-up');
			await expect(staged(reopened, ready)).toContainText(locale === 'en' ? 'Ready' : '就绪');
			const retry = staged(reopened, pending).getByRole('button', { name: locale === 'en' ? 'Retry ' + pending : '重试 ' + pending, exact: true });
			await expect(retry).toBeVisible();
			await application.evaluate(() => {
				globalThis.ashNativeFixture.setOffline(false);
				globalThis.ashNativeFixture.holdUploads(false);
			});
			await retry.click();
			await expect(staged(reopened, pending)).toContainText(locale === 'en' ? 'Ready' : '就绪');
			expect(await application.evaluate(() => globalThis.ashNativeFixture.uploadedFiles)).toEqual({ [ready]: 'Ready draft bytes', [pending]: 'Pending draft bytes' });

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
		test.use({ electronWindowMode: 'active' });
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
			await expect(page.locator('[data-action-id="sessions.open.chatgpt"]')).toHaveCount(0);
			await expect(page.locator('[data-action-id="sessions.newSession"] button:not([aria-current])')).toBeVisible();
			const editor = page.locator('.ash-chatgpt-widget'); await expect(editor).toBeVisible();
			await expect(page.locator('.ash-chat2-editor, .ash-web-bridge')).toHaveCount(0);
			const input = editor.getByRole('textbox', { name: locale === 'en' ? 'Ask ChatGPT' : '询问 ChatGPT', exact: true });
			const composer = new Editor(editor);
			await expect(input).toBeEditable();
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
			const ash = page.locator('.ash-sessions-chat-slot.active:visible .ash-chat');
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
			await page.locator('[data-action-id="sessions.newSession"]').getByRole('button', { name: locale === 'en' ? 'New' : '新建', exact: true }).click();
			await expect(editor).toBeVisible();
			await composer.waitForEditorContents(text => text === 'Hello from native UI');
			const sidebar = page.locator('.ash-chat-navigation');
			await expect(sidebar.getByRole('button', { name: 'Ash', exact: true })).toHaveCount(0);
			await expect(sidebar.locator('.ash-sessions-list')).toHaveCount(0);
			const codeMode = mode.getByRole('button', { name: locale === 'en' ? 'Code' : '代码', exact: true });
			await codeMode.click();
			const codeList = page.locator('.ash-sessions-list[data-mode="code"]');
			await codeList.locator('.ash-sessions-list-item').getByText(locale === 'en' ? /\(draft\)/ : /（草稿）/).click();
			await expect(ash).toHaveAttribute('data-untitled-session-id', ashDraftId!);
			await ashComposer.waitForEditorContents(text => text === 'Hello from native UI');
			await expect(codeMode).toHaveAttribute('aria-pressed', 'true');
			await ash.locator('.ash-chat-input-model-action').press('ArrowDown');
			await expect(modelMenu.getByRole('menuitemradio', { name: model.model, exact: true })).toBeVisible();
			await expect(modelMenu.getByRole('menuitemradio', { name: 'Fixture model', exact: true })).toHaveCount(0);
			await expect(modelMenu.getByText(locale === 'en' ? 'New ChatGPT Chat with Model…' : '选择模型新建 ChatGPT 对话…', { exact: true })).toHaveCount(0);
			await page.keyboard.press('Escape');
			await ashComposer.waitForEditorFocus();
			await page.keyboard.press('Enter');
			await expect(ash).toContainText('Answer from Ash');
			expect(ashRequests).toEqual([model.model]);
			await commands.runCommand('sessions.open.chatgpt');
			await expect(editor).toBeVisible();
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
					await expect(editor.locator('.ash-chat-input-notification-message')).toContainText('404');
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
			await composer.waitForEditorFocus(); await composer.waitForTypeInEditor('Draft in first history');
			await history.getByRole('button', { name: 'Second native history', exact: true }).click();
			await expect(editor).toContainText('History two answer');
			await expect(editor).not.toContainText('History one answer');
			await history.getByRole('button', { name: 'First native history', exact: true }).click();
			await expect(editor).toContainText('History one answer');
			await composer.waitForEditorContents(text => text === 'Draft in first history');
			await page.locator('[data-action-id="sessions.newSession"]').getByRole('button', { name: locale === 'en' ? 'New' : '新建', exact: true }).click();
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
			const pinned = history.locator('[data-group="pinned"] .ash-sessions-list-section-toggle');
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
				await page.locator(`[data-action-id="${entry.action}"] button`).click();
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
			await expect(restored.locator('[data-action-id="sessions.newSession"] button:not([aria-current])')).toBeVisible();
			for (const entry of pages) {
				await restored.locator(`[data-action-id="${entry.action}"] button`).click();
				restored = await workbench.reopenAgentsWindow(application, restored);
				await expect(restored.locator(entry.content)).toBeVisible();
				const restoredHistory = restored.locator('.ash-chat-navigation');
				await expect(restoredHistory).toBeVisible();
				await expect(restoredHistory.locator('[data-group="pinned"] .ash-sessions-list-section-toggle')).toHaveAttribute('aria-expanded', 'false');
				await expect(restoredHistory.getByRole('button', { name: 'First native history', exact: true })).toHaveAttribute('aria-current', 'page');
				await restoredHistory.getByRole('button', { name: 'First native history', exact: true }).click();
				await expect(restored.locator('.ash-chatgpt-widget')).toContainText('History one answer');
				await new Editor(restored.locator('.ash-chatgpt-widget')).waitForEditorFocus();
			}
			expect(await application.evaluate(() => globalThis.ashNativeFixture.sends)).toBe(4);
		});
	});
}
