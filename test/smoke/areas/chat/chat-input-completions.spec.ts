import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

const model = 'completion-fixture';
const provider = 'custom-input-completion';
test.use({ video: 'on', electronUserSettings: { 'models.hidden': [{ provider, model, visible: true }] } });

for (const surface of ['workbench', 'sessions']) {
	test(`Host input completion sends its captured file through App Server in ${surface}`, { tag: ['@electron-app-server'] }, async ({ application, webAppServer, workbench, target, testWorkspace }, testInfo) => {
		test.setTimeout(180_000);
		const marker = `completion_capture_${surface}`;
		const filename = 'completion-source.txt';
		const source = join(testWorkspace.directory, filename);
		await writeFile(source, marker);
		const requests: unknown[] = [];
		const server = createServer(async (request, response) => {
			if (request.method === 'GET') {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(JSON.stringify({ data: [{ id: model }] }));
				return;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of request) {
				chunks.push(Buffer.from(chunk));
			}
			requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.end('data: {"id":"completion-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Captured reference received"},"finish_reason":null}]}\n\ndata: {"id":"completion-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
		let page: Page = workbench.page;
		const windowErrors: string[] = [];
		const observeWindow = (window: Page) => { window.on('pageerror', error => windowErrors.push(error.message)); window.on('console', message => { if (message.type() === 'error') windowErrors.push(message.text()); }); };
		page.context().on('page', observeWindow);
		try {
			connection = await connectProfile(application, webAppServer, testWorkspace.directory, page);
			const { client } = connection;
			const catalog = await client.request(APP_SERVER_METHODS['skills/list'], { reload: 'cached' });
			const skill = catalog.skills.find(skill => skill.enablement === 'enabled' && skill.compatibility.type === 'compatible');
			if (!skill) throw new Error('The Desktop package must expose an enabled built-in skill');
			const address = server.address();
			if (!address || typeof address === 'string') {
				throw new Error('Missing completion model fixture port');
			}
			const config = await client.request(APP_SERVER_METHODS['config/read'], {});
			await client.request(APP_SERVER_METHODS['provider/configure'], {
				commandId: 'completion-provider', expectedRevision: config.revision,
				config: {
					connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`,
					custom: { name: 'Input completion fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 },
					modelContext: { [model]: { contextWindow: 272_000 } },
				},
			});
			await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: provider, apiKey: 'synthetic-fixture-key' });
			if (surface === 'sessions') {
				page = await workbench.openAgentsWindow(target.kind);
				await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
			} else if (!await page.locator('.ash-chat-view-pane').isVisible()) {
				await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
			}
			const composer = page.locator(surface === 'sessions' ? '.ash-sessions-chat-slot.active:visible .ash-chat' : '.ash-chat-view-pane .ash-chat:visible');
			await composer.locator('.ash-chat-input-model-action').press('ArrowDown');
			const picker = page.getByRole('dialog', { name: 'Choose a chat model', exact: true });
			const automatic = picker.getByRole('switch', { name: 'Auto', exact: true });
			if (await automatic.isChecked()) {
				await automatic.press('Space');
			}
			await picker.getByRole('combobox').fill(model);
			await expect(picker.getByRole('menuitemradio')).toHaveCount(1);
			await picker.getByRole('combobox').press('Enter');
			const input = composer.locator('.ash-chat-input-editor').getByRole('textbox');
			await input.pressSequentially('/adv');
			await expect(composer.locator('.stanza-editor-completion-label').filter({ hasText: '/advisor' })).toBeVisible();
			await input.press('Escape');
			await input.press('ControlOrMeta+a');
			await input.press('Backspace');
			await input.pressSequentially('/');
			await expect(composer.locator('.stanza-editor-completion-label').filter({ hasText: '/config' })).toBeVisible();
			await input.press('Escape');
			await input.press('ControlOrMeta+a');
			await input.press('Backspace');
			await input.pressSequentially(`$${skill.id.name}`);
			await expect(composer.locator('.stanza-editor-completion-label').filter({ hasText: `$${skill.id.name}` })).toBeVisible();
			await input.press('Tab');
			await input.pressSequentially('Review #completion-source');
			await expect(composer.locator('.stanza-editor-completion-label').filter({ hasText: `#${filename}` })).toBeVisible();
			await input.press('Tab');
			await expect(composer.locator('.ash-chat-code-reference')).toHaveText(filename);
			await expect(input).toBeFocused();
			expect(requests).toEqual([]);
			await page.screenshot({ path: testInfo.outputPath('accepted-file-completion.png') });
			await writeFile(source, 'changed after accepting the completion');
			await input.press('ControlOrMeta+z');
			await expect(composer.locator('.ash-chat-code-reference')).toHaveCount(0);
			await input.press('ControlOrMeta+Shift+z');
			await expect(composer.locator('.ash-chat-code-reference')).toHaveText(filename);
			await input.press('Enter');
			await expect(composer).toHaveAttribute('data-thread-id', /.+/u);
			const sessionId = await composer.getAttribute('data-session-id');
			const threadId = await composer.getAttribute('data-thread-id');
			if (!sessionId || !threadId) {
				throw new Error('Missing completion conversation identity');
			}
			const read = async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId })).thread;
			await expect.poll(async () => (await read()).turns.at(-1)?.status).toBe('completed');
			const accepted = await read();
			expect(accepted.turns.flatMap(turn => turn.items).filter(item => item.type === 'userContext').map(item => ({ name: item.name, content: item.content }))).toEqual([{ name: filename, content: marker }]);
			expect(JSON.stringify(requests[0])).toContain(JSON.stringify(`<skill-instructions source="${skill.id.source}" name="${skill.id.name}" revision="${skill.contentDigest}">`).slice(1, -1));
			expect(requests).toHaveLength(1);
			expect(JSON.stringify(requests[0])).toContain(marker);
			expect(JSON.stringify(requests[0])).not.toContain('changed after accepting the completion');
			await testInfo.attach('accepted-thread', { body: JSON.stringify(accepted, null, 2), contentType: 'application/json' });
		} catch (error) {
			const diagnostics = testInfo.outputPath('window-errors.json');
			await writeFile(diagnostics, JSON.stringify({ errors: windowErrors, windows: await Promise.all(page.context().pages().map(async window => ({ url: window.url(), text: await window.locator('body').innerText().catch(() => '') }))) }, null, 2));
			await testInfo.attach('window-errors', { path: diagnostics, contentType: 'application/json' });
			throw error;
		} finally {
			page.context().off('page', observeWindow);
			await connection?.close();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		}
	});
}
