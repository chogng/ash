import { createServer } from 'node:http';
import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { connectProfile } from '../sessions/sessionProfileFixture.js';

test.use({ video: 'on' });

interface GitHubContextFixture {
	content: string;
	readonly reads: string[];
	dispose(): void;
}

/** Replace only GitHub read replies in this isolated renderer; Agent submission uses the real backend. */
function installGitHubContextFixture(): void {
	const owner = window as Window & { githubContextFixture?: GitHubContextFixture; };
	if (owner.githubContextFixture) { return; }
	const post = MessagePort.prototype.postMessage;
	const channels = new Map<MessagePort, {
		readonly original: MessagePort['onmessage'];
		readonly methods: Map<string | number, string>;
		readonly decoder: TextDecoder;
		pending: string;
	}>();
	const fixture: GitHubContextFixture = owner.githubContextFixture = {
		content: 'github_context_snapshot_20261030\nexport const answer = 42;\n',
		reads: [],
		dispose() {
			MessagePort.prototype.postMessage = post;
			for (const [port, channel] of channels) { port.onmessage = channel.original; }
			channels.clear();
			delete owner.githubContextFixture;
		},
	};
	MessagePort.prototype.postMessage = function (message, options?: Transferable[] | StructuredSerializeOptions): void {
		const data = (message as { data?: unknown; } | undefined)?.data;
		if (data instanceof Uint8Array) {
			const frames = new TextDecoder().decode(data).trim().split('\n');
			for (const frame of frames) {
				let request: { id?: string | number; method?: string; };
				try { request = JSON.parse(frame); } catch { continue; }
				if (request.id === undefined || !['github/account/list', 'github/repository/tree', 'github/repository/blob'].includes(request.method ?? '')) { continue; }
				let channel = channels.get(this);
				if (!channel) {
					const port = this;
					channel = { original: port.onmessage, methods: new Map(), decoder: new TextDecoder(), pending: '' };
					channels.set(port, channel);
					port.onmessage = event => {
						const current = channels.get(port)!;
						const bytes = (event.data as { data?: unknown; } | undefined)?.data;
						if (!(bytes instanceof Uint8Array)) { current.original?.call(port, event); return; }
						current.pending += current.decoder.decode(bytes, { stream: true });
						const frames = current.pending.split('\n');
						current.pending = frames.pop()!;
						const replaced = frames.filter(frame => frame.trim()).map(frame => {
							const reply = JSON.parse(frame);
							const method = current.methods.get(reply.id);
							if (!method) { return frame; }
							current.methods.delete(reply.id);
							fixture.reads.push(method);
							let result: unknown;
							if (method === 'github/account/list') {
								result = { accounts: [{ id: 'synthetic-github', host: 'github.com', login: 'fixture', status: 'ready', credentialRevision: '1' }] };
							} else if (method === 'github/repository/tree') {
								result = { sha: 'a'.repeat(40), entries: [{ path: 'README.md', kind: 'file', sha: 'b'.repeat(40), size: new TextEncoder().encode(fixture.content).length }] };
							} else {
								result = { sha: 'b'.repeat(40), contentBase64: btoa(fixture.content) };
							}
							return JSON.stringify({ jsonrpc: '2.0', id: reply.id, result });
						});
						// Preserve one consumption acknowledgement per real transport chunk,
						// even when a frame spans chunks or several responses share a chunk.
						current.original?.call(port, new MessageEvent('message', { data: { data: new TextEncoder().encode(replaced.length ? replaced.join('\n') + '\n' : '') } }));
					};
				}
				channel.methods.set(request.id, request.method!);
			}
		}
		post.call(this, message, Array.isArray(options) ? { transfer: options } : options);
	};
}

for (const locale of ['en', 'zh-CN']) {
	test(`GitHub search attaches a file snapshot to the current Agent and submits it in ${locale}`, { tag: ['@electron-app-server'] }, async ({ application, target, webAppServer, workbench, restartWorkbench, testWorkspace }, testInfo) => {
		test.setTimeout(180_000);
		test.skip(target.kind !== 'electron', 'The synthetic GitHub boundary uses the Desktop MessagePort transport.');
		if (locale === 'zh-CN') {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
			await language.fill('简体中文');
			await language.press('Enter');
			({ application, workbench } = await restartWorkbench());
		}
		await workbench.page.context().addInitScript(installGitHubContextFixture);
		const copy = locale === 'zh-CN'
			? { code: '代码', enable: '启用', picker: '选择聊天模型', auto: '自动', repository: 'owner/name 或 https://github.com/owner/name', attach: '添加到当前 Agent 上下文', source: '打开 README.md' }
			: { code: 'Code', enable: 'Enable', picker: 'Choose a chat model', auto: 'Auto', repository: 'owner/name or https://github.com/owner/name', attach: 'Add to current Agent context', source: 'Open README.md' };
		const provider = 'custom-github-context-fixture';
		const model = { provider, model: 'github-context-model' };
		const requests: unknown[] = [];
		const server = createServer(async (request, response) => {
			if (request.method === 'GET') {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(JSON.stringify({ data: [{ id: model.model }] }));
				return;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of request) { chunks.push(Buffer.from(chunk)); }
			requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.end('data: {"id":"github-context","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"GitHub context received"},"finish_reason":null}]}\n\ndata: {"id":"github-context","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
		let page: import('@playwright/test').Page | undefined;
		try {
			connection = await connectProfile(application, webAppServer, testWorkspace.directory, workbench.page);
			const { client } = connection;
			const address = server.address();
			if (!address || typeof address === 'string') { throw new Error('Missing synthetic model port'); }
			const config = await client.request(APP_SERVER_METHODS['config/read'], {});
			await client.request(APP_SERVER_METHODS['provider/configure'], {
				commandId: 'github-context-provider', expectedRevision: config.revision,
				config: {
					connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`,
					custom: { name: 'Isolated GitHub context model', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 },
					modelContext: { [model.model]: { contextWindow: 272_000 } },
				},
			});
			await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: provider, apiKey: 'synthetic-model-key' });
			await workbench.settingsEditor.openUserSettingsUI();
			await workbench.settingsEditor.selectGroup('agents');
			await workbench.settingsEditor.selectCategory('models');
			const enabled = workbench.page.getByRole('switch', { name: `${copy.enable} ${model.model}`, exact: true });
			if (!await enabled.isChecked()) { await enabled.press('Space'); }
			await expect(enabled).toBeChecked();
			await workbench.page.locator('.ash-modal-editor-close').click();
			page = await workbench.openAgentsWindow(target.kind);
			await page.evaluate(installGitHubContextFixture);
			await page.locator('.ash-window-mode-control').getByRole('button', { name: copy.code, exact: true }).click();
			await page.locator('[data-action-id="sessions.newSession"] button').click();
			const active = page.locator('.ash-sessions-chat-slot.active:visible .ash-chat');
			await active.locator('.ash-chat-input-model-action').press('ArrowDown');
			const models = page.getByRole('dialog', { name: copy.picker, exact: true });
			const automatic = models.getByRole('switch', { name: copy.auto, exact: true });
			if (await automatic.isChecked()) { await automatic.press('Space'); }
			await models.getByRole('combobox').fill(model.model);
			await expect(models.getByRole('menuitemradio')).toHaveCount(1);
			await models.getByRole('combobox').press('Enter');
			const editor = new Editor(active);
			await editor.waitForEditorFocus();
			await page.keyboard.insertText('Explain this captured GitHub file.');
			await new QuickAccess(page).runCommand('sessions.github.browseRepositoryFiles');
			const repository = page.getByPlaceholder(copy.repository, { exact: true });
			await repository.fill('team/repo');
			await repository.press('Enter');
			await page.getByRole('dialog').getByRole('textbox').press('Enter');
			const results = page.getByRole('dialog').getByRole('combobox');
			await results.fill('README');
			const attach = page.getByRole('dialog').getByRole('button', { name: copy.attach, exact: true });
			await expect(attach).toBeVisible();
			await results.press('Tab');
			// A nonempty Quick Input exposes its native clear action before row actions.
			await page.keyboard.press('Tab');
			await expect(attach).toBeFocused();
			await attach.press('Enter');
			await expect(page.getByRole('dialog')).toHaveCount(0);
			await expect(active.getByRole('button', { name: copy.source, exact: true })).toBeVisible();
			await expect(editor.input).toBeFocused();
			await editor.waitForEditorContents(text => text.includes('Explain this captured GitHub file.'));
			expect(requests).toEqual([]);
			const original = await page.evaluate(() => {
				const fixture = (window as Window & { githubContextFixture?: GitHubContextFixture; }).githubContextFixture!;
				const original = fixture.content;
				fixture.content = 'Changed remote content after attachment';
				return original;
			});
			await page.screenshot({ path: testInfo.outputPath(`github-context-attached-${locale}.png`) });
			await editor.input.press('Enter');
			await expect(active).toHaveAttribute('data-thread-id', /.+/u);
			const sessionId = await active.getAttribute('data-session-id');
			const threadId = await active.getAttribute('data-thread-id');
			if (!sessionId || !threadId) { throw new Error('Missing accepted conversation'); }
			const read = async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId })).thread;
			await expect.poll(async () => (await read()).turns.at(-1)?.status).toBe('completed');
			const accepted = await read();
			expect(accepted.turns.flatMap(turn => turn.items).filter(item => item.type === 'userContext').map(item => ({ name: item.name, content: item.content }))).toEqual([{ name: 'README.md', content: original }]);
			expect(requests.some(request => JSON.stringify(request).includes('github_context_snapshot_20261030'))).toBe(true);
			expect(requests.some(request => JSON.stringify(request).includes('Changed remote content after attachment'))).toBe(false);
			await testInfo.attach('accepted-github-context', { body: JSON.stringify(accepted, null, 2), contentType: 'application/json' });
		} finally {
			await page?.evaluate(() => (window as Window & { githubContextFixture?: GitHubContextFixture; }).githubContextFixture?.dispose()).catch(() => undefined);
			await connection?.close();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		}
	});
}
