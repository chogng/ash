import { createServer, type ServerResponse } from 'node:http';
import { writeFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { Workbench } from '../../../automation/workbench.js';
import { APP_SERVER_METHODS, type ModelRef, type Session } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from './sessionProfileFixture.js';

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

for (const locale of ['en', 'zh-CN']) {
	test(`Background branch management preserves drafts and survives stop, failure and reopen in ${locale}`, async ({ application, target, webAppServer, workbench, restartWorkbench, testWorkspace }, testInfo) => {
		test.skip(target.appServerMode !== 'required', 'Requires real durable Session management.');
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
			await workbench.settingsEditor.openUserSettingsUI();
			await workbench.settingsEditor.selectGroup('agents');
			await workbench.settingsEditor.selectCategory('models');
			const enabled = workbench.page.getByRole('switch', { name: `${locale === 'zh-CN' ? '启用' : 'Enable'} ${model.model}`, exact: true });
			if (!await enabled.isChecked()) await enabled.press('Space');
			await expect(enabled).toBeChecked();
			await workbench.page.locator('.ash-modal-editor-close').click();
			const create = async (commandId: string, title: string): Promise<Session> => (await client.request(APP_SERVER_METHODS['session/create'], { commandId, title, agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } })).session;
			// Catalog order follows durable IDs. Keep its initial selected Session separate
			// so this background tree is never hydrated before the passive assertions.
			await create('management-a-foreground', 'Foreground session');
			const background = await create('management-background', 'Background management');
			const sessionId = background.sessionId;
			const root = background.threads[0];
			if (!root) throw new Error('Expected management root');
			const fork = await client.request(APP_SERVER_METHODS['session/request'], { commandId: 'management-fork', sessionId, request: { type: 'forkThread', parentThreadId: root.threadId, title: 'Background branch' } });
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
			await page.locator('.ash-sessions-activity-content').getByRole('button', { name: copy.code, exact: true }).click();
			await page.locator('.ash-sessions-list-add').click();
			const active = (): ReturnType<Page['locator']> => page!.locator('.ash-sessions-chat-slot.active:visible :is(.ash-chat,.ash-cowork)');
			const editor = new Editor(active());
			await editor.waitForEditorFocus(); await page.keyboard.insertText('Keep the unsent management draft');
			const draftId = await active().getAttribute('data-untitled-session-id');
			expect(draftId).toBeTruthy();
			await active().locator('.ash-chat-input-model-action').press('ArrowDown');
			const picker = page.getByRole('dialog', { name: copy.picker, exact: true });
			const auto = picker.getByRole('switch', { name: locale === 'zh-CN' ? '自动' : 'Auto', exact: true });
			if (await auto.isChecked()) await auto.press('Space');
			const search = picker.getByRole('combobox');
			await search.fill(model.model); await expect(picker.getByRole('menuitemradio')).toHaveCount(1); await search.press('Enter');
			const row = (): ReturnType<Page['locator']> => page!.locator('.ash-sessions-list-item').filter({ hasText: 'Background management' });
			const status = (): ReturnType<Page['locator']> => row().locator('.ash-sessions-list-management');
			await expect(status()).toHaveText(copy.idle);
			await row().focus();
			const rowIdentity = await row().elementHandle();
			const list = page.locator('.ash-sessions-list-items');
			const scroll = await list.evaluate(element => { element.scrollTop = 37; return element.scrollTop; });
			expect(scroll).toBeGreaterThan(0);
			const preserve = async (): Promise<void> => {
				await expect(row()).toBeFocused();
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
			await expect(status()).toHaveText(copy.working); await preserve();
			await expect.poll(() => held.size).toBe(2);
			const release = async (marker: string): Promise<void> => {
				const response = [...held].find(([prompt]) => prompt.includes(marker))?.[1];
				if (!response) throw new Error(`Missing held model response ${marker}`);
				finish(response);
			};
			await release('fixture-hold-branch');
			await expect.poll(() => branchState(fork.value.threadId)).toBe('readyForReview');
			await expect(status()).toHaveText(copy.working); await preserve();
			const beforeStop = (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId: root.threadId })).thread;
			const turn = beforeStop.turns.at(-1);
			if (!turn) throw new Error('Expected held Turn');
			const interrupt = { commandId: 'management-interrupt-replay', sessionId, request: { type: 'interruptTurn' as const, threadId: root.threadId, expectedSequence: beforeStop.sequence, turnId: turn.turnId } };
			await client.request(APP_SERVER_METHODS['session/request'], interrupt);
			await expect.poll(() => branchState(root.threadId)).toBe('stopped');
			const stopped = await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId: root.threadId });
			await client.request(APP_SERVER_METHODS['session/request'], interrupt);
			expect((await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId: root.threadId })).thread).toEqual(stopped.thread);
			await expect(status()).toHaveText(copy.stopped); await preserve();
			await start(root.threadId, 'fixture-failure');
			await expect.poll(() => branchState(root.threadId), { timeout: 30_000 }).toBe('failed');
			await expect(status()).toHaveText(copy.failed); await preserve();
			await start(root.threadId, 'fixture-retry-complete');
			await expect.poll(() => branchState(root.threadId)).toBe('readyForReview');
			await expect(status()).toHaveText(copy.readyForReview); await preserve();
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
			await expect(status()).toHaveText(copy.needsInput);
			await expect(row()).toHaveAttribute('aria-label', /Synthetic management choice/u);
			await expect(active()).toHaveAttribute('data-untitled-session-id', draftId!);
			await editor.waitForEditorContents(text => text === 'Keep the unsent management draft');
			const question = workbench.page.getByRole('combobox', { name: 'Synthetic management choice', exact: true });
			await expect(question).toBeVisible();
			await expect(question.getByRole('option')).toHaveText(['agent', 'ask']);
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
			await expect(status()).toHaveText(copy.stopped);
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
			await expect(status()).toHaveText(copy.stopped);
			await expect(active()).toHaveAttribute('data-untitled-session-id', draftId!);
			await new Editor(active()).waitForEditorContents(text => text === 'Keep the unsent management draft');
			await row().click();
			await expect(active()).toHaveAttribute('data-thread-id', root.threadId);
			// The Agents history action is exposed through its existing slash command.
			const reopenedEditor = new Editor(active());
			await reopenedEditor.waitForEditorFocus();
			await page.keyboard.insertText('/history');
			await reopenedEditor.waitForEditorContents(text => text === '/history');
			await page.keyboard.press('Escape');
			await page.keyboard.press('Enter');
			await expect(page.locator('.ash-quick-pick .ash-list-row').filter({ hasText: 'Background management' }).filter({ hasText: `${copy.thread} ${index + 1}` })).toContainText(copy.stopped);
			await page.keyboard.press('Escape');
			await page.screenshot({ path: testInfo.outputPath('reopened-history.png') });
		} finally {
			await connection?.close();
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
}
