import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

test.use({ video: 'on' });

for (const locale of ['en', 'zh-CN']) {
	for (const surface of ['workbench', 'sessions']) {
		test(`Pending attachment-only mouse Send reaches the backend in ${surface} in ${locale}`, { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, target, webAppServer, workbench, restartWorkbench, testWorkspace }, testInfo) => {
			test.setTimeout(180_000);
			if (locale === 'zh-CN') {
				await workbench.quickaccess.runCommand('workbench.action.configureLocale');
				const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
				await language.fill('简体中文');
				await language.press('Enter');
				({ application, workbench } = await restartWorkbench());
			}
			const copy = locale === 'zh-CN'
				? { code: '代码', picker: '选择聊天模型', auto: '自动', enable: '启用', sideBar: '显示辅助侧栏' }
				: { code: 'Code', picker: 'Choose a chat model', auto: 'Auto', enable: 'Enable', sideBar: 'Show Secondary Side Bar' };
			const provider = 'custom-pending-input-fixture';
			const model = 'pending-input-model';
			const marker = `pending_mouse_attachment_${surface}_${locale}`;
			const requests: unknown[] = [];
			const server = createServer(async (request, response) => {
				if (request.method === 'GET') {
					response.writeHead(200, { 'content-type': 'application/json' });
					response.end(JSON.stringify({ data: [{ id: model }] }));
					return;
				}
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
				response.writeHead(200, { 'content-type': 'text/event-stream' });
				response.end('data: {"id":"pending-input-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Synthetic held attachment received"},"finish_reason":null}]}\n\ndata: {"id":"pending-input-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
			});
			await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
			let control: Page | undefined;
			let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
			let page = workbench.page;
			let holding = false;
			try {
				// The fixture reads the real backend in a stable realm; the UI alone sends the request.
				if (target.kind === 'browser') {
					control = await page.context().newPage();
					await control.goto(page.url(), { waitUntil: 'domcontentloaded' });
				}
				connection = await connectProfile(application, webAppServer, testWorkspace.directory, control ?? page);
				const { client } = connection;
				const address = server.address();
				if (!address || typeof address === 'string') throw new Error('Missing fixture port');
				const config = await client.request(APP_SERVER_METHODS['config/read'], {});
				await client.request(APP_SERVER_METHODS['provider/configure'], { commandId: 'pending-input-provider', expectedRevision: config.revision, config: { connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`, custom: { name: 'Isolated pending input fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 }, modelContext: { [model]: { contextWindow: 272_000 } } } });
				await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: provider, apiKey: 'synthetic-fixture-key' });
				await workbench.settingsEditor.openUserSettingsUI();
				await workbench.settingsEditor.selectGroup('agents');
				await workbench.settingsEditor.selectCategory('models');
				const enabled = page.getByRole('switch', { name: `${copy.enable} ${model}`, exact: true });
				if (!await enabled.isChecked()) await enabled.press('Space');
				await expect(enabled).toBeChecked();
				await page.locator('.ash-modal-editor-close').click();
				let composer: Locator;
				if (surface === 'sessions') {
					page = await workbench.openAgentsWindow(target.kind);
					await page.locator('.ash-sessions-activity-content').getByRole('button', { name: copy.code, exact: true }).click();
					await page.locator('[data-action-id="sessions.newSession"] button').click();
					composer = page.locator('.ash-sessions-chat-slot.active:visible .ash-chat');
				} else {
					if (!await page.locator('.ash-chat-view-pane').isVisible()) await page.getByRole('button', { name: copy.sideBar, exact: true }).click();
					composer = page.locator('.ash-chat-view-pane .ash-chat:visible');
				}
				await composer.locator('.ash-chat-input-model-action').press('ArrowDown');
				const picker = page.getByRole('dialog', { name: copy.picker, exact: true });
				const automatic = picker.getByRole('switch', { name: copy.auto, exact: true });
				if (await automatic.isChecked()) await automatic.press('Space');
				const search = picker.getByRole('combobox');
				await search.fill(model);
				await expect(picker.getByRole('menuitemradio')).toHaveCount(1);
				await search.press('Enter');
				const prevented = await composer.locator('.ash-chat-input-container').evaluate((form, marker) => {
					const Reader = globalThis.FileReader;
					const reads: (() => void)[] = [];
					globalThis.FileReader = class extends Reader {
						override readAsArrayBuffer(blob: Blob): void { reads.push(() => super.readAsArrayBuffer(blob)); }
					};
					(window as Window & { ashHeldInputRead?: { count(): number; release(): void; restore(): void; }; }).ashHeldInputRead = {
						count: () => reads.length,
						release: () => { for (const read of reads.splice(0)) read(); },
						restore: () => { globalThis.FileReader = Reader; },
					};
					const transfer = new DataTransfer();
					transfer.items.add(new File([marker], 'held-mouse.txt', { type: 'text/plain' }));
					const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer });
					form.dispatchEvent(paste);
					return paste.defaultPrevented;
				}, marker);
				holding = true;
				expect(prevented).toBe(true);
				await expect.poll(() => page.evaluate(() => (window as Window & { ashHeldInputRead?: { count(): number; }; }).ashHeldInputRead!.count())).toBe(1);
				const send = composer.locator('[data-action-id="ash.chat.input.send"] button');
				await expect(send).toBeVisible();
				await expect(send).toBeEnabled();
				await expect(composer.locator('.ash-chat-input-attachment-item')).toHaveCount(0);
				await page.screenshot({ path: testInfo.outputPath('pending-mouse-send.png') });
				await send.click();
				await expect(send).toBeDisabled();
				expect(requests).toEqual([]);
				await page.evaluate(() => (window as Window & { ashHeldInputRead?: { release(): void; }; }).ashHeldInputRead!.release());
				await expect(composer).toHaveAttribute('data-thread-id', /.+/u);
				const sessionId = await composer.getAttribute('data-session-id');
				const threadId = await composer.getAttribute('data-thread-id');
				if (!sessionId || !threadId) throw new Error('Missing accepted conversation identity');
				const read = async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId })).thread;
				await expect.poll(async () => (await read()).turns.at(-1)?.status).toBe('completed');
				const accepted = await read();
				expect(accepted.turns.flatMap(turn => turn.items).filter(item => item.type === 'userContext').map(item => ({ name: item.name, content: item.content }))).toEqual([{ name: 'held-mouse.txt', content: marker }]);
				expect(requests).toHaveLength(1);
				expect(JSON.stringify(requests[0])).toContain(marker);
				await expect(composer.locator('.ash-chat-input-attachment-item')).toHaveCount(0);
				await testInfo.attach('accepted-thread', { body: JSON.stringify(accepted, null, 2), contentType: 'application/json' });
				await writeFile(testInfo.outputPath('model-requests.json'), JSON.stringify(requests, null, 2));
			} finally {
				if (holding && !page.isClosed()) await page.evaluate(() => {
					const owner = window as Window & { ashHeldInputRead?: { restore(): void; }; };
					owner.ashHeldInputRead?.restore(); delete owner.ashHeldInputRead;
				});
				await connection?.close();
				await control?.close();
				server.closeAllConnections();
				await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
			}
		});
	}
}


for (const text of ['', 'Private instruction intended for A']) {
	for (const aba of [false, true]) {
		test(`Workbench pending ${text ? 'text and file' : 'file-only'} input stays out of other drafts across ${aba ? 'A-B-A' : 'A-B'}`, { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, target, webAppServer, workbench, testWorkspace }, testInfo) => {
			test.setTimeout(180_000);
			const provider = 'custom-navigation-input-fixture';
			const model = 'navigation-input-model';
			const requests: unknown[] = [];
			const server = createServer(async (request, response) => {
				if (request.method === 'GET') {
					response.writeHead(200, { 'content-type': 'application/json' });
					response.end(JSON.stringify({ data: [{ id: model }] }));
					return;
				}
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
				response.writeHead(200, { 'content-type': 'text/event-stream' });
				response.end('data: {"id":"navigation-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Synthetic navigation reply"},"finish_reason":null}]}\n\ndata: {"id":"navigation-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
			});
			await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
			const page = workbench.page;
			let control: Page | undefined;
			let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
			let holding = false;
			try {
				if (target.kind === 'browser') {
					control = await page.context().newPage();
					await control.goto(page.url(), { waitUntil: 'domcontentloaded' });
				}
				connection = await connectProfile(application, webAppServer, testWorkspace.directory, control ?? page);
				const { client } = connection;
				const address = server.address();
				if (!address || typeof address === 'string') throw new Error('Missing fixture port');
				const config = await client.request(APP_SERVER_METHODS['config/read'], {});
				await client.request(APP_SERVER_METHODS['provider/configure'], { commandId: 'navigation-input-provider', expectedRevision: config.revision, config: { connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`, custom: { name: 'Isolated navigation fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 }, modelContext: { [model]: { contextWindow: 272_000 } } } });
				await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: provider, apiKey: 'synthetic-fixture-key' });
				await workbench.settingsEditor.openUserSettingsUI();
				await workbench.settingsEditor.selectGroup('agents');
				await workbench.settingsEditor.selectCategory('models');
				const enabled = page.getByRole('switch', { name: `Enable ${model}`, exact: true });
				if (!await enabled.isChecked()) await enabled.press('Space');
				await expect(enabled).toBeChecked();
				await page.locator('.ash-modal-editor-close').click();
				if (!await page.locator('.ash-chat-view-pane').isVisible()) await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
				const composer = page.locator('.ash-chat-view-pane .ash-chat:visible');
				await composer.locator('.ash-chat-input-model-action').press('ArrowDown');
				const picker = page.getByRole('dialog', { name: 'Choose a chat model', exact: true });
				const automatic = picker.getByRole('switch', { name: 'Auto', exact: true });
				if (await automatic.isChecked()) await automatic.press('Space');
				await picker.getByRole('combobox').fill(model);
				await expect(picker.getByRole('menuitemradio')).toHaveCount(1);
				await picker.getByRole('combobox').press('Enter');
				const editor = new Editor(composer);
				await editor.waitForEditorFocus();
				await page.keyboard.insertText('Initial completed turn in A');
				await editor.input.press('Enter');
				await expect(composer).toHaveAttribute('data-thread-id', /.+/u);
				const sessionId = await composer.getAttribute('data-session-id');
				const threadA = await composer.getAttribute('data-thread-id');
				if (!sessionId || !threadA) throw new Error('Missing initial conversation identity');
				const read = async (threadId: string) => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId })).thread;
				await expect.poll(async () => (await read(threadA)).turns.at(-1)?.status).toBe('completed');
				// Only seed the second Thread via the public API. All navigation and sends use the UI.
				const created = await client.request(APP_SERVER_METHODS['session/request'], { commandId: 'navigation-create-thread-B', sessionId, request: { type: 'createThread', title: 'Controlled B' } });
				if (created.type !== 'thread') throw new Error('Expected a created Thread');
				const threadB = created.value.threadId;
				const selectThread = async (threadId: string): Promise<void> => {
					const catalog = (await client.request(APP_SERVER_METHODS['session/catalog/read'], { sessionId })).session;
					if (!catalog) throw new Error('Missing current Session catalog');
					const active = catalog.threads.filter(thread => thread.status === 'active');
					const index = active.findIndex(thread => thread.threadId === threadId);
					if (index < 0) throw new Error('Missing destination Thread');
					await page.locator('.ash-chat-view-title-button').click();
					const history = page.locator('.ash-quick-pick:visible');
					const option = history.getByRole('option').filter({ has: page.locator('.ash-quick-pick-row-label').getByText(catalog.title.trim() || 'Session', { exact: true }) }).filter({ has: page.locator('.ash-quick-pick-row-description').getByText(new RegExp(`^Thread ${index + 1}(?: ·|$)`, 'u')) });
					await expect(option).toHaveCount(1);
					await option.click();
					await expect(history).toBeHidden();
					await expect(composer).toHaveAttribute('data-thread-id', threadId);
				};
				await selectThread(threadA);
				const retainedPaneId = await composer.getAttribute('id');
				await editor.waitForEditorFocus();
				if (text) await page.keyboard.insertText(text);
				const privateFile = `private_pending_file_${text ? 'with_text' : 'only'}_${aba ? 'ABA' : 'AB'}`;
				const prevented = await composer.locator('.ash-chat-input-container').evaluate((form, contents) => {
					const Reader = globalThis.FileReader;
					const reads: (() => Promise<void>)[] = [];
					globalThis.FileReader = class extends Reader {
						override readAsArrayBuffer(blob: Blob): void {
							reads.push(() => new Promise<void>((resolve, reject) => {
								this.addEventListener('loadend', () => resolve(), { once: true });
								this.addEventListener('error', () => reject(this.error), { once: true });
								super.readAsArrayBuffer(blob);
							}));
						}
					};
					(window as Window & { ashNavigationRead?: { count(): number; release(): Promise<void>; restore(): void; }; }).ashNavigationRead = { count: () => reads.length, release: async () => { await Promise.all(reads.splice(0).map(read => read())); }, restore: () => { globalThis.FileReader = Reader; } };
					const transfer = new DataTransfer();
					transfer.items.add(new File([contents], 'private-A.txt', { type: 'text/plain' }));
					const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer });
					form.dispatchEvent(paste);
					return paste.defaultPrevented;
				}, privateFile);
				holding = true;
				expect(prevented).toBe(true);
				await expect.poll(() => page.evaluate(() => (window as Window & { ashNavigationRead?: { count(): number; }; }).ashNavigationRead!.count())).toBe(1);
				const send = composer.locator('[data-action-id="ash.chat.input.send"] button');
				await expect(send).toBeEnabled();
				await send.click();
				await expect(send).toBeDisabled();
				await selectThread(threadB);
				if (aba) await selectThread(threadA);
				await expect(composer).toHaveAttribute('id', retainedPaneId!);
				await expect(composer).toHaveAttribute('data-session-id', sessionId);
				const selected = aba ? threadA : threadB;
				const nextDraft = `New draft for ${aba ? 'A again' : 'B'}`;
				await editor.waitForEditorFocus();
				await editor.input.press('ControlOrMeta+A');
				await page.keyboard.insertText(nextDraft);
				await editor.waitForEditorContents(contents => contents === nextDraft);
				await page.evaluate(() => (window as Window & { ashNavigationRead?: { release(): Promise<void>; }; }).ashNavigationRead!.release());
				await expect(composer.locator('.ash-chat-input-attachment-item')).toHaveCount(0);
				await editor.waitForEditorContents(contents => contents === nextDraft);
				for (const threadId of [threadA, threadB]) {
					const snapshot = await read(threadId);
					expect(JSON.stringify(snapshot)).not.toContain(privateFile);
					if (text) expect(JSON.stringify(snapshot)).not.toContain(text);
					expect((await client.request(APP_SERVER_METHODS['queue/list'], { sessionId, threadId })).messages).toHaveLength(0);
				}
				expect(requests.filter(request => JSON.stringify(request).includes(privateFile) || (text && JSON.stringify(request).includes(text)))).toHaveLength(0);
				await page.screenshot({ path: testInfo.outputPath('retained-current-draft.png') });
				await editor.input.press('Enter');
				await expect.poll(async () => (await read(selected)).turns.at(-1)?.status).toBe('completed');
				await expect.poll(async () => JSON.stringify(await read(selected)).includes(nextDraft)).toBe(true);
				await expect(composer).toHaveAttribute('data-thread-id', selected);
				const final = { A: await read(threadA), B: await read(threadB) };
				expect(JSON.stringify(final)).not.toContain(privateFile);
				if (text) expect(JSON.stringify(final)).not.toContain(text);
				await writeFile(testInfo.outputPath('thread-navigation.json'), JSON.stringify({ sessionId, threadA, threadB, selected, final, requests }, null, 2));
			} finally {
				if (holding && !page.isClosed()) await page.evaluate(() => {
					const owner = window as Window & { ashNavigationRead?: { restore(): void; }; };
					owner.ashNavigationRead?.restore(); delete owner.ashNavigationRead;
				});
				await connection?.close();
				await control?.close();
				server.closeAllConnections();
				await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
			}
		});
	}
}
