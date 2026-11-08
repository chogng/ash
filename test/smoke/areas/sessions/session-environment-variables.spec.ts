import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { APP_SERVER_METHODS, APPROVAL_MODE_DEFINITIONS } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from './sessionProfileFixture.js';

test.use({ gitRepository: true });

test.describe('Environment draft navigation in Simplified Chinese', () => {
	test.use({ electronUserSettings: { 'workbench.locale': 'zh-CN' } });

	test('A new environment draft is protected during keyboard workspace switching', { tag: ['@electron-app-server'] }, async ({ target, workbench }) => {
		const page = await workbench.openAgentsWindow(target.kind);
		const modes = page.locator('.ash-window-mode-control');
		const code = modes.getByRole('button', { name: '代码', exact: true });
		const agents = modes.getByRole('button', { name: '聊天 / Agents', exact: true });
		await code.click();
		const picker = page.locator('.ash-sessions-chat-slot.active:visible .ash-sessions-environment-picker');
		await picker.click();
		await page.getByText('新建环境', { exact: true }).click();
		const form = page.getByRole('dialog', { name: '新建环境' });
		const name = form.getByLabel('名称', { exact: true });
		await name.fill('Unsaved environment');

		await agents.press('Space');
		const confirmation = page.getByRole('dialog', { name: '放弃未保存的更改？' });
		await expect(confirmation.getByRole('button', { name: '继续编辑' })).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(confirmation).toHaveCount(0);
		await expect(name).toBeFocused();
		await expect(name).toHaveValue('Unsaved environment');
		await expect(code).toHaveAttribute('aria-pressed', 'true');

		await agents.press('Enter');
		await confirmation.getByRole('button', { name: '放弃更改', exact: true }).press('Enter');
		await expect(form).toHaveCount(0);
		await expect(picker).toBeFocused();
		await agents.press('Enter');
		await expect(agents).toHaveAttribute('aria-pressed', 'true');
	});
});

test('A saved environment reaches the Agent process and stays scoped to its Session', { tag: ['@electron-app-server'] }, async ({ application, webAppServer, target, testWorkspace, workbench }) => {
	test.setTimeout(180_000);
	const provider = 'custom-session-environment';
	const model = { provider, model: 'session-environment' };
	const toolOutputs = new Map<string, string>();
	const server = createServer(async (request, response) => {
		if (request.method === 'GET') {
			response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: model.model }] }));
			return;
		}
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			const marker = ['configured-session', 'plain-session'].find(marker => body.messages?.some((message: { role: string; content: unknown; }) => message.role === 'user' && JSON.stringify(message.content).includes(marker)));
			if (!marker) throw new Error('Unexpected fixture prompt');
			const output = body.messages.findLast((message: { role: string; }) => message.role === 'tool');
			if (output) toolOutputs.set(marker, JSON.stringify(output.content));
			const script = 'console.log(process.env.SESSION_MARKER_FIXTURE ?? "unset"); console.log(JSON.stringify(process.env.SESSION_MULTILINE_FIXTURE ?? null));';
			const delta = output ? { content: marker + ' complete' } : {
				tool_calls: [{
					index: 0, id: marker, type: 'function', function: {
						name: 'shell-command', arguments: JSON.stringify({ program: process.execPath, arguments: ['-e', script], working_directory: '.' }),
					},
				}]
			};
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: marker, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
			response.end(chunk(delta, null) + chunk({}, output ? 'stop' : 'tool_calls') + 'data: [DONE]\n\n');
		} catch (error) {
			response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: String(error) } }));
		}
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
	try {
		connection = await connectProfile(application, webAppServer, testWorkspace.directory, workbench.page);
		const { client } = connection;
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Missing fixture port');
		let config = await client.request(APP_SERVER_METHODS['config/read'], {});
		await client.request(APP_SERVER_METHODS['provider/configure'], {
			commandId: 'environment-fixture-provider', expectedRevision: config.revision,
			config: { connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`, custom: { name: 'Session environment fixture', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 }, modelContext: { [model.model]: { contextWindow: 272_000 } } },
		});
		await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: provider, apiKey: 'synthetic-fixture-key' });
		config = await client.request(APP_SERVER_METHODS['config/read'], {});
		await client.request(APP_SERVER_METHODS['config/update'], { commandId: 'environment-fixture-model', expectedRevision: config.revision, model });
		config = await client.request(APP_SERVER_METHODS['config/read'], {});
		await client.request(APP_SERVER_METHODS['execPolicy/rule/upsert'], {
			commandId: 'environment-fixture-policy', expectedRevision: config.revision,
			rule: { id: 'environment-fixture-shell', selector: { type: 'source', source: 'built_in_tool', sourceId: 'shell-command' }, effect: { type: 'allowUnsandboxed' }, justification: 'Reads synthetic environment values in this isolated smoke profile.' },
		});
		const { project } = await client.request(APP_SERVER_METHODS['project/create'], {
			commandId: randomUUID(), projectId: randomUUID(),
			name: 'Environment fixture project', description: '',
			materials: [{ kind: 'folder', name: 'Workspace', path: pathToFileURL(testWorkspace.directory).href }],
		});
		let page = await workbench.openAgentsWindow(target.kind);
		const code = async () => page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await code();
		const active = () => page.locator('.ash-sessions-chat-slot.active:visible .ash-chat:visible');
		const picker = () => active().locator('.ash-sessions-environment-picker');
		await picker().click();
		await page.getByText('New Environment', { exact: true }).click();
		const dialog = page.getByRole('dialog', { name: 'New Environment' });
		await dialog.getByLabel('Name', { exact: true }).fill('Fixture environment');
		await dialog.getByRole('button', { name: 'Environment variables', exact: true }).click();
		await page.getByRole('textbox', { name: 'Environment variables' }).fill('SESSION_MARKER_FIXTURE=synthetic-session-value\nSESSION_MULTILINE_FIXTURE="first\nsecond"');
		await page.getByRole('button', { name: 'Done', exact: true }).click();
		await dialog.getByRole('button', { name: 'Create environment', exact: true }).click();
		await expect(picker()).toHaveText('Fixture environment');
		page = await workbench.reopenAgentsWindow(application, page);
		await code();
		await expect(picker()).toHaveText('Fixture environment');

		const send = async (marker: string) => {
			const projectPicker = active().locator('.ash-sessions-workspace-picker');
			if (await projectPicker.textContent() !== project.name) {
				await projectPicker.click();
				await page.locator('[role="menu"]').getByText(project.name, { exact: true }).click();
				await expect(projectPicker).toHaveText(project.name);
			}
			await active().locator('.ash-chat-input-mode-action').click();
			await page.locator('.ash-chat-input-mode-menu').getByRole('menuitemradio', { name: 'Agent', exact: true }).click();
			await active().getByRole('button', { name: /^Permissions:/ }).click();
			const bypass = APPROVAL_MODE_DEFINITIONS.find(mode => mode.id === 'bypassPermissions')!;
			await page.getByRole('menuitemradio', { name: bypass.label.english, exact: true }).click();
			await page.getByRole('dialog', { name: 'Confirm', exact: true }).getByRole('button', { name: bypass.label.english, exact: true }).click();
			const editor = new Editor(active());
			await editor.input.focus();
			await page.keyboard.insertText(marker);
			await editor.input.press('Enter');
			await expect(active()).toHaveAttribute('data-thread-id', /.+/u, { timeout: 15_000 });
			await expect.poll(() => toolOutputs.get(marker), { timeout: 60_000 }).toBeDefined();
			return toolOutputs.get(marker)!;
		};
		const configured = await send('configured-session');
		expect(configured).toContain('synthetic-session-value');
		expect(configured).toMatch(/first\\+nsecond/u);
		await page.locator('[data-action-id="sessions.newSession"] button').click();
		await expect(picker()).toHaveText('This Computer');
		const plain = await send('plain-session');
		expect(plain).toContain('unset');
		expect(plain).not.toContain('synthetic-session-value');
	} finally {
		await connection?.close();
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});
