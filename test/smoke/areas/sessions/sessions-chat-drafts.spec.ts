import { createServer } from 'node:http';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from './sessionProfileFixture.js';

test.use({ video: 'on' });

for (const locale of ['en', 'zh-CN']) {
	test(`Sessions file preparation and source drafts survive submission and reopen in ${locale}`, { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, target, webAppServer, workbench, restartWorkbench, testWorkspace }, testInfo) => {
		test.setTimeout(180_000);
		if (locale === 'zh-CN') {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
			await language.fill('简体中文');
			await language.press('Enter');
			({ application, workbench } = await restartWorkbench());
		}
		const copy = locale === 'zh-CN'
			? { code: '代码', picker: '选择聊天模型', auto: '自动', enable: '启用', open: '打开 draft-source.txt' }
			: { code: 'Code', picker: 'Choose a chat model', auto: 'Auto', enable: 'Enable', open: 'Open draft-source.txt' };
		const provider = 'custom-sessions-draft-fixture';
		const model = { provider, model: 'sessions-draft-model' };
		const requests: unknown[] = [];
		const server = createServer(async (request, response) => {
			if (request.method === 'GET') {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(JSON.stringify({ data: [{ id: model.model }] }));
				return;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.end('data: {"id":"draft-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Synthetic attachment received"},"finish_reason":null}]}\n\ndata: {"id":"draft-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		// Keep the fixture connection in a stable realm while the product navigates and reopens.
		let control: Page | undefined;
		let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
		try {
			if (target.kind === 'browser') {
				control = await workbench.page.context().newPage();
				await control.goto(workbench.page.url(), { waitUntil: 'domcontentloaded' });
			}
			connection = await connectProfile(application, webAppServer, testWorkspace.directory, control ?? workbench.page);
			const { client } = connection;
			const address = server.address();
			if (!address || typeof address === 'string') throw new Error('Missing fixture port');
			const config = await client.request(APP_SERVER_METHODS['config/read'], {});
			await client.request(APP_SERVER_METHODS['provider/configure'], { commandId: 'draft-provider', expectedRevision: config.revision, config: { connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`, custom: { name: 'Isolated draft fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 }, modelContext: { [model.model]: { contextWindow: 272_000 } } } });
			await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: provider, apiKey: 'synthetic-fixture-key' });
			await workbench.settingsEditor.openUserSettingsUI();
			await workbench.settingsEditor.selectGroup('agents');
			await workbench.settingsEditor.selectCategory('models');
			const enabled = workbench.page.getByRole('switch', { name: `${copy.enable} ${model.model}`, exact: true });
			if (!await enabled.isChecked()) await enabled.press('Space');
			await expect(enabled).toBeChecked();
			await workbench.page.locator('.ash-modal-editor-close').click();
			let page = await workbench.openAgentsWindow(target.kind);
			await page.locator('.ash-sessions-activity-content').getByRole('button', { name: copy.code, exact: true }).click();
			await page.locator('.ash-sessions-list-add').click();
			const active = () => page.locator('.ash-sessions-chat-slot.active:visible .ash-chat');
			await active().locator('.ash-chat-input-model-action').press('ArrowDown');
			const picker = page.getByRole('dialog', { name: copy.picker, exact: true });
			const automatic = picker.getByRole('switch', { name: copy.auto, exact: true });
			if (await automatic.isChecked()) await automatic.press('Space');
			const search = picker.getByRole('combobox');
			await search.fill(model.model);
			await expect(picker.getByRole('menuitemradio')).toHaveCount(1);
			await search.press('Enter');
			const marker = 'sessions_attachment_snapshot_20261012';
			// Submit in the paste task, before FileReader can finish. This exercises the
			// real form entry, asynchronous file read and backend acceptance without stubbing a service.
			const delivered = await active().locator('.ash-chat-input-container').evaluate((form, marker) => {
				const transfer = new DataTransfer();
				transfer.items.add(new File([marker], 'pasted-source.txt', { type: 'text/plain' }));
				const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer });
				form.dispatchEvent(paste);
				const submit = new Event('submit', { bubbles: true, cancelable: true });
				form.dispatchEvent(submit);
				return { paste: paste.defaultPrevented, submit: submit.defaultPrevented };
			}, marker);
			expect(delivered).toEqual({ paste: true, submit: true });
			await expect(active()).toHaveAttribute('data-thread-id', /.+/u);
			const sessionId = await active().getAttribute('data-session-id');
			const threadId = await active().getAttribute('data-thread-id');
			if (!sessionId || !threadId) throw new Error('Missing accepted conversation identity');
			const read = async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId })).thread;
			await expect.poll(async () => (await read()).turns.at(-1)?.status).toBe('completed');
			const accepted = await read();
			expect(accepted.turns.flatMap(turn => turn.items).filter(item => item.type === 'userContext').map(item => ({ name: item.name, content: item.content }))).toEqual([{ name: 'pasted-source.txt', content: marker }]);
			expect(requests.some(request => JSON.stringify(request).includes(marker))).toBe(true);
			await expect(active().locator('.ash-chat-input-attachment-item')).toHaveCount(0);
			await testInfo.attach('accepted-thread', { body: JSON.stringify(accepted, null, 2), contentType: 'application/json' });
			await writeFile(testInfo.outputPath('model-requests.json'), JSON.stringify(requests, null, 2));

			await writeFile(join(testWorkspace.directory, 'draft-source.txt'), 'original draft source snapshot\n');
			await page.locator('.ash-sessions-list-add').click();
			const commands = new QuickAccess(page);
			await commands.open('draft-source.txt');
			await commands.select('draft-source.txt');
			const suggested = active().locator('.ash-chat-suggested-context button');
			await expect(suggested).toBeVisible();
			await suggested.press('Enter');
			const source = () => active().getByRole('button', { name: copy.open, exact: true });
			await expect(source()).toBeVisible();
			await source().hover();
			await expect(page.locator('.ash-hover')).toContainText('draft-source.txt');
			const sourceUri = (await page.locator('.ash-hover').innerText()).trim();
			await page.mouse.move(0, 0);
			const editor = new Editor(active());
			await editor.waitForEditorFocus();
			await page.keyboard.insertText('Keep this source draft');
			const identity = await active().getAttribute('data-untitled-session-id');
			page = await workbench.reopenAgentsWindow(application, page);
			await page.locator('.ash-sessions-activity-content').getByRole('button', { name: copy.code, exact: true }).click();
			await expect(active()).toHaveAttribute('data-untitled-session-id', identity!);
			await expect(source()).toBeVisible();
			await source().hover();
			await expect(page.locator('.ash-hover')).toContainText(sourceUri);
			await page.mouse.move(0, 0);
			await new Editor(active()).waitForEditorContents(text => text === 'Keep this source draft');
			await page.screenshot({ path: testInfo.outputPath('restored-source-draft.png') });
		} finally {
			await connection?.close();
			await control?.close();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		}
	});
}
