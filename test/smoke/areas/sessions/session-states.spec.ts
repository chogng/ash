import { createServer, type ServerResponse } from 'node:http';
import { writeFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { Workbench } from '../../../automation/workbench.js';
import { APP_SERVER_METHODS, type ModelRef, type Session } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile, enableFixtureModel } from './sessionProfileFixture.js';

test.use({ video: 'on' });

// Observe only this window's product connections. Seeding and verification use
// a separate profile connection in the source Workbench, never a service stub.
function observeDetails(): void {
	const requests: { method: string; sessionId?: string; }[] = [];
	(window as Window & { sessionStateRequests?: typeof requests; }).sessionStateRequests = requests;
	const record = (frame: string): void => {
		const message = JSON.parse(frame);
		if (message.method) requests.push({ method: message.method, sessionId: message.params?.sessionId });
	};
	const send = WebSocket.prototype.send;
	WebSocket.prototype.send = function (data): void {
		if (this.url.includes('/ash/app-server') && typeof data === 'string') record(data);
		send.call(this, data);
	};
	const post = MessagePort.prototype.postMessage;
	MessagePort.prototype.postMessage = function (message, options?: Transferable[] | StructuredSerializeOptions): void {
		if (typeof message?.frame === 'string') record(message.frame);
		post.call(this, message, Array.isArray(options) ? { transfer: options } : options);
	};
}

test.describe('Saved conversations shared with the IDE', () => {
	test.use({ electronUserSettings: { 'window.startupWindow': 'ide', 'workbench.locale': 'zh-CN' } });

	test('IDE and Code continue the same conversation without an execution folder', { tag: ['@electron-app-server'] }, async ({ application, target, workbench, testWorkspace }) => {
		const title = 'Shared folderless conversation';
		const model = { provider: 'custom-shared-conversation-fixture', model: 'shared-conversation-model' };
		let replies = 0;
		await using server = createServer((request, response) => {
			if (request.method === 'GET') {
				response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: model.model }] }));
				return;
			}
			const reply = { id: `shared-reply-${++replies}`, choices: [{ delta: { content: `Shared reply ${replies}` }, finish_reason: 'stop' }] };
			response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`data: ${JSON.stringify(reply)}\n\ndata: [DONE]\n\n`);
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Shared conversation fixture has no port');
		const { client, close } = await connectProfile(application, undefined, testWorkspace.directory, workbench.page);
		let session: Session;
		try {
			const config = await client.request(APP_SERVER_METHODS['config/read'], {});
			await client.request(APP_SERVER_METHODS['provider/configure'], {
				commandId: 'shared-conversation-provider', expectedRevision: config.revision,
				config: {
					connection: model.provider, provider: model.provider, baseUrl: `http://127.0.0.1:${address.port}/v1`,
					custom: { name: 'Shared conversation fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 },
					modelContext: { [model.model]: { contextWindow: 272_000 } },
				},
			});
			await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: model.provider, apiKey: 'isolated-fixture-key' });
			({ session } = await client.request(APP_SERVER_METHODS['session/create'], {
				commandId: 'shared-folderless-conversation', kind: 'code', title, agent: { type: 'default' }, executionTarget: null,
			}));
		} finally {
			await close();
		}
		await enableFixtureModel(workbench, model, 'zh-CN');
		const send = async (page: Page, chat: ReturnType<Page['locator']>, prompt: string, reply: string): Promise<void> => {
			await chat.locator('.ash-chat-input-model-action').press('ArrowDown');
			const picker = page.getByRole('dialog', { name: '选择聊天模型', exact: true });
			const auto = picker.getByRole('switch', { name: '自动', exact: true });
			if (await auto.isChecked()) await auto.press('Space');
			const search = picker.getByRole('combobox');
			await search.fill(model.model);
			await expect(picker.getByRole('menuitemradio')).toHaveCount(1);
			await search.press('Enter');
			const editor = new Editor(chat);
			await editor.input.focus();
			await editor.waitForTypeInEditor(prompt);
			await page.keyboard.press('Enter');
			await expect(chat.locator('.ash-chat-item-agentMessage').last()).toContainText(reply);
		};
		const threadId = session.threads[0].threadId;
		const row = `[data-item="session:${session.sessionId}"]`;
		await workbench.quickaccess.runCommand('workbench.action.chat.focusAgentSessionsViewer');
		await workbench.page.locator(`.ash-chat-sessions-sidebar ${row}`).click();
		const ideChat = workbench.page.locator('.ash-chat-view-pane .ash-chat:visible');
		await expect(ideChat).toHaveAttribute('data-session-id', session.sessionId);
		await expect(ideChat).toHaveAttribute('data-thread-id', threadId);
		await send(workbench.page, ideChat, 'Sent from IDE', 'Shared reply 1');

		const page = await workbench.openAgentsWindow(target.kind);
		await page.locator('.ash-window-mode-control').getByRole('button', { name: '代码', exact: true }).click();
		await page.locator(`.ash-sessions-list ${row} .ash-sessions-list-item`).press('Enter');
		const codeChat = page.locator('.ash-sessions-chat-slot.active:visible .ash-chat');
		await expect(codeChat).toHaveAttribute('data-session-id', session.sessionId);
		await expect(codeChat).toHaveAttribute('data-thread-id', threadId);
		await expect(codeChat).toContainText('Sent from IDE');
		await expect(codeChat).toContainText('Shared reply 1');
		await send(page, codeChat, 'Sent from Code', 'Shared reply 2');
		await expect(ideChat).toContainText('Sent from Code');
		await expect(ideChat).toContainText('Shared reply 2');

		await new Editor(codeChat).input.press('Alt+F1');
		await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/已保存的 Ash 对话可以在代码模式或 IDE 中继续，包括没有文件夹的对话。/u);
		await page.keyboard.press('Escape');
		await new QuickAccess(page).runCommand('sessions.showSessionsPicker');
		await expect(page.getByRole('option').filter({ hasText: title })).toBeVisible();
	});
});

for (const locale of ['en', 'zh-CN']) {
	test(`Code sidebar scrolls and restores its position with the Projects toolbar in ${locale}`, { tag: ['@electron-app-server'] }, async ({ application, target, workbench, restartWorkbench, testWorkspace }) => {
		if (locale === 'zh-CN') {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
			await language.fill('简体中文');
			await language.press('Enter');
			({ application, workbench } = await restartWorkbench());
		}
		const { client, close } = await connectProfile(application, undefined, testWorkspace.directory, workbench.page);
		try {
			await client.request(APP_SERVER_METHODS['project/create'], {
				commandId: 'sidebar-scroll-project', projectId: 'sidebar-scroll-project', name: 'Sidebar project', description: '', materials: [],
			});
			for (let index = 0; index < 28; index++) {
				await client.request(APP_SERVER_METHODS['session/create'], {
					commandId: `sidebar-scroll-${index}`, kind: 'code', title: `Sidebar fixture ${index}`,
					agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory },
				});
			}
		} finally {
			await close();
		}

		const page = await workbench.openAgentsWindow(target.kind);
		const modes = page.locator('.ash-window-mode-control');
		const code = modes.getByRole('button', { name: locale === 'zh-CN' ? '代码' : 'Code', exact: true });
		await code.click();
		const sidebar = page.locator('.ash-sessions-list:visible');
		const viewport = sidebar.locator('.ash-sessions-list-items > .ash-scrollbar-viewport');
		const scrollbar = sidebar.getByRole('scrollbar').and(sidebar.locator('[aria-orientation="vertical"]'));
		const thumb = scrollbar.locator('.ash-scrollbar-thumb');
		const toolbar = sidebar.locator('[data-section="projects"] .ash-sessions-list-more');
		await expect(toolbar.getByRole('button', { name: locale === 'zh-CN' ? '更多会话操作' : 'More Sessions Actions', exact: true })).toBeVisible();
		await scrollbar.press('Home');
		await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0);
		await expect(toolbar).toBeInViewport();
		await viewport.hover();
		await expect(thumb).toHaveCSS('border-left-width', '1px');
		const { x, y, height } = (await thumb.boundingBox())!;
		await page.mouse.move(x + 0.5, y + height / 2);
		await page.mouse.down();
		await page.mouse.move(x + 0.5, y + height / 2 + 40);
		await page.mouse.up();
		await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
		await scrollbar.press('Home');
		await viewport.hover();
		await page.mouse.wheel(0, 160);
		await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
		const top = await viewport.evaluate(element => element.scrollTop);
		await modes.getByRole('button', { name: locale === 'zh-CN' ? '聊天 / Agents' : 'Chat / Agents', exact: true }).click();
		await code.click();
		await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(top);
		await scrollbar.press('End');
		await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
		await expect(toolbar).not.toBeInViewport();
	});

	test(`Background branch management preserves drafts and survives stop, failure and reopen in ${locale}`, { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, target, webAppServer, workbench, restartWorkbench, testWorkspace }, testInfo) => {
		test.setTimeout(240_000);
		if (locale === 'zh-CN') {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
			await language.fill('简体中文');
			await language.press('Enter');
			({ application, workbench } = await restartWorkbench());
		}
		const copy = locale === 'zh-CN'
			? { idle: '空闲', working: '进行中', needsInput: '需要回应', readyForReview: '待审阅', failed: '失败', stopped: '已停止', thread: '分支', code: '代码', picker: '选择聊天模型' }
			: { idle: 'Idle', working: 'Working', needsInput: 'Needs input', readyForReview: 'Ready for review', failed: 'Failed', stopped: 'Stopped', thread: 'Thread', code: 'Code', picker: 'Choose a chat model' };
		const held = new Map<string, ServerResponse>();
		const questions = new Set<string>();
		const modelRequests: unknown[] = [];
		const chunk = (delta: unknown, finish: string | null = null): string => `data: ${JSON.stringify({ id: 'management-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		const finish = (response: ServerResponse): void => { response.end(chunk({ content: 'Synthetic management answer' }) + chunk({}, 'stop') + 'data: [DONE]\n\n'); };
		const server = createServer(async (request, response) => {
			if (request.method === 'GET') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'management-model' }] })); return; }
			const chunks: Buffer[] = [];
			for await (const part of request) chunks.push(Buffer.from(part));
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: { role: string; content: unknown; }[]; };
			modelRequests.push(body);
			await writeFile(testInfo.outputPath('model-http-requests.json'), JSON.stringify(modelRequests, null, 2));
			// The backend appends environment context after the authored user input.
			const prompt = body.messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).reverse().find(text => /fixture-(hold|failure|retry|question)/u.test(text)) ?? '';
			if (prompt.includes('fixture-failure')) {
				response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Synthetic fixture failure', type: 'invalid_request_error' } })); return;
			}
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.flushHeaders();
			if (prompt.includes('fixture-question') && !questions.has(prompt)) {
				questions.add(prompt);
				response.end(chunk({ tool_calls: [{ index: 0, id: 'management-mode-choice', type: 'function', function: { name: 'switch_mode', arguments: JSON.stringify({ mode: 'agent', reason: 'Synthetic management choice' }) } }] }) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n'); return;
			}
			if (prompt.includes('fixture-hold')) {
				response.write(chunk({})); held.set(prompt, response);
				response.once('close', () => { if (held.get(prompt) === response) held.delete(prompt); }); return;
			}
			finish(response);
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
		let page: Page | undefined;
		try {
			connection = await connectProfile(application, webAppServer, testWorkspace.directory, workbench.page);
			const { client } = connection;
			const address = server.address();
			if (!address || typeof address === 'string') throw new Error('Management fixture has no port');
			const provider = 'custom-session-management-fixture';
			const model: ModelRef = { provider, model: 'management-model' };
			const config = await client.request(APP_SERVER_METHODS['config/read'], {});
			await client.request(APP_SERVER_METHODS['provider/configure'], { commandId: 'management-provider', expectedRevision: config.revision, config: { connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`, custom: { name: 'Isolated management model', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 }, modelContext: { 'management-model': { contextWindow: 272_000 } } } });
			await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: provider, apiKey: 'isolated-fixture-key' });
			await enableFixtureModel(workbench, model, locale);
			const create = async (commandId: string, title: string): Promise<Session> => (await client.request(APP_SERVER_METHODS['session/create'], { commandId, kind: 'code', title, agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } })).session;
			// Catalog order follows durable IDs. Keep its initial selected Session separate
			// so this background tree is never hydrated before the passive assertions.
			await create('management-a-foreground', 'Foreground session');
			const background = await create('management-background', 'Background management');
			const sessionId = background.sessionId;
			const root = background.threads[0];
			if (!root) throw new Error('Expected management root');
			const branchTitle = 'Background branch';
			const fork = await client.request(APP_SERVER_METHODS['session/request'], { commandId: 'management-fork', sessionId, request: { type: 'forkThread', parentThreadId: root.threadId, title: branchTitle } });
			if (fork.type !== 'thread') throw new Error('Expected management branch');
			for (let index = 0; index < 14; index++) await create(`management-padding-${index}`, `Padding ${index}`);
			const read = async (): Promise<Session> => {
				const result = (await client.request(APP_SERVER_METHODS['session/catalog/read'], { sessionId })).session;
				if (!result) throw new Error('Management Session disappeared');
				return result;
			};
			const start = async (threadId: string, prompt: string): Promise<void> => {
				const before = await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId });
				await client.request(APP_SERVER_METHODS['session/request'], { commandId: prompt, sessionId, request: { type: 'startTurn', threadId, expectedSequence: before.thread.sequence, mode: 'ask', approvalMode: 'bypassPermissions', model, input: [{ type: 'text', text: prompt }] } });
			};
			const branchState = async (threadId: string): Promise<string | undefined> => (await read()).threads.find(thread => thread.threadId === threadId)?.manager?.status;
			let agentsWorkbench = workbench;
			if (target.kind === 'browser') {
				const agentsSource = await workbench.page.context().newPage();
				await agentsSource.goto(workbench.page.url(), { waitUntil: 'domcontentloaded' });
				agentsWorkbench = new Workbench(agentsSource); await agentsWorkbench.waitForReady();
			}
			page = await agentsWorkbench.openAgentsWindow(target.kind);
			await page.evaluate(observeDetails);
			await page.locator('.ash-window-mode-control').getByRole('button', { name: copy.code, exact: true }).click();
			await page.locator('[data-action-id="sessions.newSession"] button').click();
			const active = (): ReturnType<Page['locator']> => page!.locator('.ash-sessions-chat-slot.active:visible :is(.ash-chat,.ash-cowork)');
			const editor = new Editor(active());
			await expect(active()).toHaveAttribute('data-untitled-session-id', /.+/u);
			const draftId = await active().getAttribute('data-untitled-session-id');
			await active().locator('.ash-chat-input-model-action').press('ArrowDown');
			const picker = page.getByRole('dialog', { name: copy.picker, exact: true });
			const auto = picker.getByRole('switch', { name: locale === 'zh-CN' ? '自动' : 'Auto', exact: true });
			if (await auto.isChecked()) await auto.press('Space');
			const search = picker.getByRole('combobox');
			await search.fill(model.model); await expect(picker.getByRole('menuitemradio')).toHaveCount(1); await search.press('Enter');
			// Keep row order stable while status changes update the last activity time.
			await page.locator('.ash-tree-row[data-tree-id="section:projects"]').hover();
			await page.locator('.ash-sessions-list-more').getByRole('button', { name: locale === 'zh-CN' ? '更多会话操作' : 'More Sessions Actions', exact: true }).click();
			await page.getByRole('menuitem', { name: locale === 'zh-CN' ? '排序方式' : 'Sort By', exact: true }).press('ArrowRight');
			await page.getByRole('menuitemradio', { name: locale === 'zh-CN' ? '创建日期' : 'Date Created', exact: true }).click();
			await expect(active().locator('.ash-chat-input-model-action')).toHaveText(model.model);
			await editor.waitForEditorFocus();
			await editor.waitForTypeInEditor('Keep the unsent management draft');
			const row = (): ReturnType<Page['locator']> => page!.locator('.ash-sessions-list-item').filter({ hasText: 'Background management' });
			const assertStatus = (label: string, glyph: string): Promise<void> => test.step(`Verify sidebar status icon for ${label}`, async () => {
				await expect(row()).toHaveAccessibleName(new RegExp(`^Background management\\. ${label}(?:\\.|$)`, 'u'));
				await expect(row()).toHaveText('Background management');
				const layer = row().locator('..').locator('.ash-session-status-icon-layer');
				await expect(layer).toHaveCount(1);
				if (glyph === 'working') {
					await expect(layer.locator('.ash-pixel-spinner, [data-ash-icon-id="sync"]')).toBeVisible();
				} else {
					await expect(layer.locator(`[data-ash-icon-id="${glyph}"]`)).toBeVisible();
				}
			});
			await assertStatus(copy.idle, 'circle');
			const rowHeight = (await row().boundingBox())!.height;
			await row().focus();
			const rowIdentity = await row().elementHandle();
			const list = page.locator('.ash-sessions-list-items > .ash-scrollbar-viewport');
			const scroll = await list.evaluate(element => { element.scrollTop = 37; return element.scrollTop; });
			expect(scroll).toBeGreaterThan(0);
			const preserve = async (): Promise<void> => {
				await expect(row()).toBeFocused();
				expect((await row().boundingBox())!.height).toBe(rowHeight);
				expect(await row().evaluate((element, previous) => element === previous, rowIdentity)).toBe(true);
				expect(await list.evaluate(element => element.scrollTop)).toBe(scroll);
				await expect(row()).not.toHaveAttribute('aria-current', 'page');
				await expect(active()).toHaveAttribute('data-untitled-session-id', draftId!);
				await expect(active().locator('.ash-chat-input-model-action')).toHaveText(model.model);
				await editor.waitForEditorContents(text => text === 'Keep the unsent management draft');
			};
			await start(root.threadId, 'fixture-hold-root');
			await start(fork.value.threadId, 'fixture-hold-branch');
			await expect.poll(() => branchState(root.threadId)).toBe('working');
			await expect.poll(() => branchState(fork.value.threadId)).toBe('working');
			await assertStatus(copy.working, 'working'); await preserve();
			await expect.poll(() => held.size).toBe(2);
			const release = async (marker: string): Promise<void> => {
				const response = [...held].find(([prompt]) => prompt.includes(marker))?.[1];
				if (!response) throw new Error(`Missing held model response ${marker}`);
				finish(response);
			};
			await release('fixture-hold-branch');
			await expect.poll(() => branchState(fork.value.threadId)).toBe('readyForReview');
			await assertStatus(copy.working, 'working'); await preserve();
			const beforeStop = (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId: root.threadId })).thread;
			const turn = beforeStop.turns.at(-1);
			if (!turn) throw new Error('Expected held Turn');
			const interrupt = { commandId: 'management-interrupt-replay', sessionId, request: { type: 'interruptTurn' as const, threadId: root.threadId, expectedSequence: beforeStop.sequence, turnId: turn.turnId } };
			await client.request(APP_SERVER_METHODS['session/request'], interrupt);
			await expect.poll(() => branchState(root.threadId)).toBe('stopped');
			const stopped = await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId: root.threadId });
			await client.request(APP_SERVER_METHODS['session/request'], interrupt);
			expect((await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId: root.threadId })).thread).toEqual(stopped.thread);
			await assertStatus(copy.stopped, 'circle'); await preserve();
			await start(root.threadId, 'fixture-failure');
			await expect.poll(() => branchState(root.threadId), { timeout: 30_000 }).toBe('failed');
			await assertStatus(copy.failed, 'error'); await preserve();
			await start(root.threadId, 'fixture-retry-complete');
			await expect.poll(() => branchState(root.threadId)).toBe('readyForReview');
			await assertStatus(copy.readyForReview, 'code-review'); await preserve();
			const requests = await page.evaluate(() => (window as Window & { sessionStateRequests?: { method: string; sessionId?: string; }[]; }).sessionStateRequests!);
			expect(requests.filter(request => request.sessionId === sessionId && ['session/read', 'session/subscribe', 'session/thread/read'].includes(request.method))).toEqual([]);
			await rowIdentity?.dispose();
			// A real selected source connection owns user input. The second window
			// still displays only catalog facts while retaining its unsent draft.
			const history = await read();
			const index = history.threads.findIndex(thread => thread.threadId === root.threadId);
			await new QuickAccess(workbench.page).runCommand('workbench.action.chat.showHistory');
			const historyRow = workbench.page.locator('.ash-quick-pick .ash-list-row').filter({ hasText: 'Background management' }).filter({ hasText: `${copy.thread} ${index + 1}` });
			await expect(historyRow).toContainText(copy.readyForReview); await historyRow.click();
			await expect(workbench.page.locator('.ash-chat-view-pane :is(.ash-chat,.ash-cowork):visible')).toHaveAttribute('data-thread-id', root.threadId);
			await start(root.threadId, 'fixture-question');
			await expect.poll(() => branchState(root.threadId), { timeout: 30_000 }).toBe('needsInput');
			await assertStatus(copy.needsInput, 'question');
			await expect(row()).toHaveAttribute('aria-label', /Synthetic management choice/u);
			await expect(active()).toHaveAttribute('data-untitled-session-id', draftId!);
			await editor.waitForEditorContents(text => text === 'Keep the unsent management draft');
			const question = workbench.page.getByRole('combobox', { name: 'switch_mode — Synthetic management choice', exact: true });
			await expect(question).toBeVisible();
			await expect(question.getByRole('option', { disabled: false })).toHaveText(['agent', 'ask']);
			// A headless desktop may have no microphone. Record and dismiss only that
			// environment notification so it cannot cover the real Stop control.
			const audioFailure = workbench.page.locator('.ash-notification').filter({ hasText: 'Microphone enumeration failed' });
			if (await audioFailure.isVisible()) {
				await expect(audioFailure).toContainText('audio host rejected the operation');
				await writeFile(testInfo.outputPath('environment-notifications.json'), JSON.stringify({ audio: await audioFailure.innerText() }, null, 2));
				await audioFailure.locator('.ash-notification-close').click();
				await expect(audioFailure).toHaveCount(0);
			}
			await workbench.page.locator('[data-action-id="ash.chat.input.interrupt"] button:visible').click();
			await expect.poll(() => branchState(root.threadId)).toBe('stopped');
			await assertStatus(copy.stopped, 'circle');
			const finalRequests = await page.evaluate(() => (window as Window & { sessionStateRequests?: { method: string; sessionId?: string; }[]; }).sessionStateRequests!);
			expect(finalRequests.filter(request => request.sessionId === sessionId && ['session/read', 'session/subscribe', 'session/thread/read'].includes(request.method))).toEqual([]);
			await writeFile(testInfo.outputPath('management-transitions.json'), JSON.stringify({ locale, session: await read(), productRequests: finalRequests, stoppedReplay: stopped.thread }, null, 2));
			await row().scrollIntoViewIfNeeded();
			await page.screenshot({ path: testInfo.outputPath('background-stopped.png') });
			if ('windows' in application) {
				// Reopen without the title-bar action's explicit conversation handoff.
				const window = await application.browserWindow(page);
				const closed = page.waitForEvent('close');
				await window.evaluate(window => window.close());
				await closed;
				const reopened = workbench.page.context().waitForEvent('page');
				await workbench.quickaccess.runCommand('workbench.action.openAgentsWindow');
				page = await reopened;
				await page.locator('.ash-sessions-window').waitFor({ state: 'visible' });
			} else {
				page = await agentsWorkbench.reopenAgentsWindow(application, page);
			}
			await assertStatus(copy.stopped, 'circle');
			await expect(active()).toHaveAttribute('data-untitled-session-id', draftId!);
			await new Editor(active()).waitForEditorContents(text => text === 'Keep the unsent management draft');
			await row().click();
			await expect(active()).toHaveAttribute('data-thread-id', root.threadId);
			const sessionHistory = new QuickAccess(page);
			await sessionHistory.runCommand('sessions.showSessionsPicker');
			await sessionHistory.search('Background management');
			await expect(sessionHistory.items.filter({ hasText: 'Background management', hasNotText: branchTitle })).toContainText(copy.stopped);
			await page.keyboard.press('Escape');
			await page.screenshot({ path: testInfo.outputPath('reopened-history.png') });
		} finally {
			await connection?.close();
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
}
